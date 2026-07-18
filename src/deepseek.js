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

  const body = {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: "system", content: buildDeepSeekSystemPrompt() },
      { role: "user", content: buildDeepSeekUserPrompt(extracted, category) },
    ],
    response_format: { type: "json_object" },
    temperature: 0.7,
    // deepseek-v4-flash is a reasoning model: reasoning_content shares this
    // budget with the JSON output, so keep it generous to avoid truncation.
    max_tokens: 4000,
  };

  const json = await fetchJsonWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    "DeepSeek"
  );

  const choice = json?.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new UpstreamError(
      "DeepSeek output was truncated (hit max_tokens). Try again.",
      { status: 502 }
    );
  }

  const content = choice?.message?.content;
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
