/**
 * Gemini client — VISION ONLY. Reads product image(s), returns extracted
 * fields as structured JSON. Never receives copywriting duties.
 *
 * Supports one or many images in a single call. Multiple images are treated as
 * different angles of the SAME product (Meesho wants front / zoomed / table-top),
 * so they are consolidated into one field set with per-image QC.
 */

import {
  GEMINI_MODEL,
  GEMINI_MODEL_FALLBACKS,
  GEMINI_API_BASE,
} from "./config.js";
import {
  GEMINI_EXTRACT_SCHEMA,
  GEMINI_EXTRACT_INSTRUCTION,
  GEMINI_COMBINE_INSTRUCTION,
} from "./prompts.js";
import { fetchJsonWithRetry, UpstreamError } from "./http.js";

/**
 * @param {Array<{buffer: Buffer, mimeType: string}>} images  One or more images.
 * @returns {Promise<object>} Parsed fields matching GEMINI_EXTRACT_SCHEMA.
 */
export async function extractFieldsFromImages(images) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new UpstreamError("GEMINI_API_KEY is not configured.", { status: 500 });
  if (!images?.length) throw new UpstreamError("No images supplied.", { status: 400 });

  const multi = images.length > 1;

  // Label each image so the model can report per-image compliance in order.
  const parts = [{ text: multi ? GEMINI_COMBINE_INSTRUCTION : GEMINI_EXTRACT_INSTRUCTION }];
  images.forEach((img, i) => {
    if (multi) parts.push({ text: `Image ${i + 1} of ${images.length}:` });
    parts.push({
      inline_data: { mime_type: img.mimeType, data: img.buffer.toString("base64") },
    });
  });

  const body = {
    contents: [{ role: "user", parts }],
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
      blockReason ? `Gemini blocked the request (${blockReason}).` : "Gemini returned no content.",
      { status: 502, body: JSON.stringify(json) }
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError("Gemini returned malformed JSON.", { status: 502, body: text });
  }
}

/** Back-compat single-image helper. */
export function extractFieldsFromImage(imageBuffer, mimeType) {
  return extractFieldsFromImages([{ buffer: imageBuffer, mimeType }]);
}
