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
  GEMINI_THINKING_LEVEL,
  GEMINI_HEDGE_AFTER_MS,
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

  const buildBody = (withThinking) => ({
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: GEMINI_EXTRACT_SCHEMA,
      temperature: 0.2,
      // Capping thinking roughly halves vision latency with no loss of
      // extraction quality — this is a "read the attributes off the photo"
      // task, not one that benefits from deliberation. See config.js.
      ...(withThinking ? { thinkingConfig: { thinkingLevel: GEMINI_THINKING_LEVEL } } : {}),
    },
  });

  const post = (model, withThinking, signal) =>
    fetchJsonWithRetry(
      `${GEMINI_API_BASE}/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(buildBody(withThinking)),
        signal,
      },
      `Gemini (${model})`
    );

  // Try the primary model, then each fallback if the model is UNAVAILABLE (503).
  const models = [GEMINI_MODEL, ...GEMINI_MODEL_FALLBACKS];
  let lastErr;
  let json;
  for (const model of models) {
    try {
      json = model === models[0] ? await hedged(models, post) : await post(model, true);
      break; // success
    } catch (err) {
      lastErr = err;
      if (err instanceof UpstreamError && err.status === 503) {
        const next = models[models.indexOf(model) + 1];
        console.warn(
          `[gemini] ${model} unavailable (503) — ${next ? `falling back to ${next}` : "no fallbacks left"}`
        );
        continue;
      }
      // A model that doesn't know thinkingConfig rejects the whole request with
      // 400 INVALID_ARGUMENT. Don't let a latency optimisation be fatal — retry
      // this same model once without it before giving up on it.
      if (err instanceof UpstreamError && err.status === 400) {
        try {
          json = await post(model, false);
          break;
        } catch (plainErr) {
          lastErr = plainErr;
          if (plainErr instanceof UpstreamError && plainErr.status === 503) continue;
          throw plainErr;
        }
      }
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

/**
 * Hedged request: start the primary model, and if it hasn't answered within
 * GEMINI_HEDGE_AFTER_MS, start a second model alongside it and take whichever
 * finishes first. The loser is aborted.
 *
 * Gemini's latency on an identical image is wildly inconsistent — measured
 * 3.2s, 3.3s, 4.4s, 8.6s and 23.8s for the same photo, with no retries and no
 * 503s involved. That tail is upstream variance we cannot make faster, but we
 * do not have to sit and wait for it. Because the hedge only fires after the
 * delay, fast requests (the common case) never pay for a second call.
 */
async function hedged(models, post) {
  const primary = models[0];
  const backup = models[1];
  const ac = new AbortController();

  const primaryCall = post(primary, true, ac.signal);
  if (!backup || GEMINI_HEDGE_AFTER_MS <= 0) return primaryCall;

  // Keep the rejection handled so a losing hedge never trips an
  // unhandledRejection, and tag which model each result came from.
  const tag = (p, model) =>
    p.then((v) => ({ ok: true, model, value: v }), (e) => ({ ok: false, model, error: e }));

  const timer = new Promise((r) => setTimeout(() => r("HEDGE"), GEMINI_HEDGE_AFTER_MS));
  const first = await Promise.race([tag(primaryCall, primary), timer]);

  if (first !== "HEDGE") {
    ac.abort();
    if (first.ok) return first.value;
    throw first.error;
  }

  console.warn(`[gemini] ${primary} slow (>${GEMINI_HEDGE_AFTER_MS}ms) — hedging with ${backup}`);
  const backupCall = tag(post(backup, true, ac.signal), backup);
  const winner = await Promise.race([tag(primaryCall, primary), backupCall]);

  if (winner.ok) {
    console.warn(`[gemini] hedge won by ${winner.model}`);
    ac.abort(); // cancel the straggler
    return winner.value;
  }

  // Whichever finished first failed — fall back to the other one's result.
  console.warn(
    `[gemini] hedge: ${winner.model} failed (${winner.error?.status || "?"}: ` +
      `${String(winner.error?.message || "").slice(0, 90)}) — waiting on the other`
  );
  const other = await (winner.model === primary ? backupCall : tag(primaryCall, primary));
  ac.abort();
  if (other.ok) return other.value;
  throw winner.error;
}

/** Back-compat single-image helper. */
export function extractFieldsFromImage(imageBuffer, mimeType) {
  return extractFieldsFromImages([{ buffer: imageBuffer, mimeType }]);
}
