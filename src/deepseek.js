/**
 * DeepSeek client — TEXT ONLY. Turns extracted fields into compliant Meesho
 * copy. Never receives the image (deployed V4 models have no vision).
 *
 * JSON mode: response_format={"type":"json_object"} + the word "json" and an
 * example shape in the prompt. JSON mode guarantees SYNTAX, not SCHEMA — so we
 * validate the parsed object app-side before returning it.
 */

import {
  DEEPSEEK_MODEL,
  DEEPSEEK_API_BASE,
  DEEPSEEK_CHAT_PATH,
  DEEPSEEK_REASONING_EFFORT,
  DEEPSEEK_MAX_TOKENS,
  DEEPSEEK_MAX_TOKENS_RETRY,
  TITLE_MAX,
  DESC_MAX,
} from "./config.js";
import {
  buildDeepSeekSystemPrompt,
  buildDeepSeekUserPrompt,
} from "./prompts.js";
import { fetchJsonWithRetry, UpstreamError } from "./http.js";

/**
 * @param {object} extracted  Gemini's extracted fields.
 * @param {string} category   Selected Meesho category slug.
 * @returns {Promise<object>} { title, description, keywords, attributes, compliance_self_check }
 */
export async function generateListing(extracted, category) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new UpstreamError("DEEPSEEK_API_KEY is not configured.", { status: 500 });

  const url = `${DEEPSEEK_API_BASE}${DEEPSEEK_CHAT_PATH}`;
  const messages = [
    { role: "system", content: buildDeepSeekSystemPrompt() },
    { role: "user", content: buildDeepSeekUserPrompt(extracted, category) },
  ];

  const call = (maxTokens) =>
    fetchJsonWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages,
          response_format: { type: "json_object" },
          temperature: 0.7,
          // Reasoning tokens are billed against max_tokens, so leaving thinking
          // on truncates the JSON before it finishes. See config.js.
          reasoning_effort: DEEPSEEK_REASONING_EFFORT,
          max_tokens: maxTokens,
        }),
      },
      "DeepSeek"
    );

  let json = await call(DEEPSEEK_MAX_TOKENS);

  // Defensive: if a future model build ignores reasoning_effort and thinks the
  // budget away anyway, escalate once rather than failing the whole listing
  // (in bulk mode this used to fail every item in the batch at once).
  if (json?.choices?.[0]?.finish_reason === "length") {
    json = await call(DEEPSEEK_MAX_TOKENS_RETRY);
  }

  const choice = json?.choices?.[0];
  const content = choice?.message?.content;

  if (choice?.finish_reason === "length" && !isParsableJson(content)) {
    throw new UpstreamError(
      `DeepSeek output was truncated even at ${DEEPSEEK_MAX_TOKENS_RETRY} tokens — ` +
        "the model is spending its budget on reasoning. Check DEEPSEEK_REASONING_EFFORT in src/config.js.",
      { status: 502 }
    );
  }

  if (!content) {
    throw new UpstreamError("DeepSeek returned no content.", {
      status: 502,
      body: JSON.stringify(json),
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new UpstreamError("DeepSeek returned malformed JSON.", {
      status: 502,
      body: content,
    });
  }

  return normalizeListing(parsed);
}

function isParsableJson(s) {
  if (!s) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * App-side schema validation + defensive shaping. JSON mode only guarantees
 * syntax, so we coerce shapes and hard-truncate against the char limits.
 */
function normalizeListing(obj) {
  if (!obj || typeof obj !== "object") {
    throw new UpstreamError("DeepSeek JSON was not an object.", { status: 502 });
  }

  const title = hardTruncate(asString(obj.title), TITLE_MAX);
  const description = hardTruncate(asString(obj.description), DESC_MAX);

  let keywords = Array.isArray(obj.keywords)
    ? obj.keywords.map(asString).filter(Boolean)
    : [];

  const attributes =
    obj.attributes && typeof obj.attributes === "object" && !Array.isArray(obj.attributes)
      ? obj.attributes
      : {};

  const complianceSelfCheck =
    obj.compliance_self_check && typeof obj.compliance_self_check === "object"
      ? obj.compliance_self_check
      : {};

  if (!title) {
    throw new UpstreamError("DeepSeek response was missing a usable title.", {
      status: 502,
    });
  }

  // The Meesho form has "Product Name" and "Description" as catalog fields, so
  // mirror the generated copy into attributes — otherwise those two form fields
  // render blank even though we generated the content.
  attributes.product_name = title;
  if (!String(attributes.description ?? "").trim()) {
    attributes.description = description;
  }

  return {
    title,
    description,
    keywords,
    attributes,
    compliance_self_check: complianceSelfCheck,
    // Signal to the client if we had to hard-truncate anything.
    _truncated: {
      title: asString(obj.title).length > TITLE_MAX,
      description: asString(obj.description).length > DESC_MAX,
    },
  };
}

function asString(v) {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

function hardTruncate(s, max) {
  return s.length > max ? s.slice(0, max) : s;
}
