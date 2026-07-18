/**
 * Gemini client — VISION ONLY. Reads the product image, returns extracted
 * fields as structured JSON. Never receives copywriting duties.
 */

import {
  GEMINI_MODEL,
  GEMINI_MODEL_FALLBACKS,
  GEMINI_API_BASE,
} from "./config.js";
import {
  GEMINI_EXTRACT_SCHEMA,
  GEMINI_EXTRACT_INSTRUCTION,
} from "./prompts.js";
import { fetchJsonWithRetry, UpstreamError } from "./http.js";

/**
 * @param {Buffer} imageBuffer  Raw image bytes.
 * @param {string} mimeType     One of the allowed image MIME types.
 * @returns {Promise<object>}   Parsed fields matching GEMINI_EXTRACT_SCHEMA.
 */
export async function extractFieldsFromImage(imageBuffer, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new UpstreamError("GEMINI_API_KEY is not configured.", { status: 500 });

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: GEMINI_EXTRACT_INSTRUCTION },
          {
            inline_data: {
              mime_type: mimeType,
              data: imageBuffer.toString("base64"),
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: GEMINI_EXTRACT_SCHEMA,
      temperature: 0.2,
    },
  };

  // Try the primary model, then each fallback if the model is UNAVAILABLE (503).
  const models = [GEMINI_MODEL, ...GEMINI_MODEL_FALLBACKS];
  let lastErr;
  let json;
  for (const model of models) {
    try {
      json = await fetchJsonWithRetry(
        `${GEMINI_API_BASE}/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(body),
        },
        `Gemini (${model})`
      );
      break; // success
    } catch (err) {
      lastErr = err;
      // Only fall through to the next model on capacity errors; fail fast otherwise.
      if (err instanceof UpstreamError && err.status === 503) continue;
      throw err;
    }
  }

  if (!json) {
    throw new UpstreamError(
      "Gemini is temporarily overloaded (503). This is an upstream capacity spike — please try again in a moment.",
      { status: 503, body: lastErr?.body }
    );
  }

  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const blockReason = json?.promptFeedback?.blockReason;
    throw new UpstreamError(
      blockReason
        ? `Gemini blocked the request (${blockReason}).`
        : "Gemini returned no content.",
      { status: 502, body: JSON.stringify(json) }
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError("Gemini returned malformed JSON.", {
      status: 502,
      body: text,
    });
  }
}
