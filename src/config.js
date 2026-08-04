/**
 * Central configuration — model pins and Meesho limits.
 *
 * Everything the research report flagged as "verify / swap on change" lives here
 * as a top-of-file constant so it can be updated in one place.
 *
 * CHANGE TRIGGERS (from the report):
 *  - Re-verify DeepSeek model names BEFORE 2026/07/24 15:59 UTC — the legacy
 *    `deepseek-chat` / `deepseek-reasoner` aliases retire then.
 *  - If Gemini deprecates a model or changes the surface, update GEMINI_MODEL /
 *    GEMINI_API_BASE.
 *  - If Meesho ever publishes official character limits, update TITLE_MAX / DESC_MAX.
 */

// ---- Vision model: Gemini (reads the image) ----------------------------------
// Classic generateContent REST surface; structured output via
// generationConfig.responseMimeType + responseSchema.
export const GEMINI_MODEL = "gemini-3.5-flash";
// Fallback chain tried in order when the primary returns 503/UNAVAILABLE
// (the Gemini flash family periodically sheds load with 503 "high demand").
export const GEMINI_MODEL_FALLBACKS = ["gemini-flash-latest", "gemini-3.5-flash-lite"];
export const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

// gemini-3.5-flash is a THINKING model. Left unbounded it spends 500+ thought
// tokens deliberating over what is a straightforward "read the attributes off
// this photo" task, which roughly doubles wall-clock latency for no measurable
// gain in extraction quality. Measured on a 1024px product photo:
//   unbounded  18.9s (571 thought tokens)   minimal  8.7–14s (0 thought tokens)
// Set to "low"/"standard" if extraction accuracy ever regresses.
export const GEMINI_THINKING_LEVEL = "minimal";

// Hedging: if the primary model has not answered within this long, fire the
// first fallback alongside it and take whichever returns first (the loser is
// aborted). Gemini's latency on an IDENTICAL image was measured at 3.2s, 3.3s,
// 4.4s, 8.6s and 23.8s with no retries and no 503s — pure upstream variance.
// Set comfortably above the ~3.4s median so typical requests never trigger a
// second call; set to 0 to disable hedging entirely.
export const GEMINI_HEDGE_AFTER_MS = 5000;

// ---- Text model: DeepSeek (writes the copy — TEXT ONLY, never the image) ------
// OpenAI-compatible chat/completions endpoint.
export const DEEPSEEK_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_API_BASE = "https://api.deepseek.com";
export const DEEPSEEK_CHAT_PATH = "/chat/completions";

// deepseek-v4-flash is ALSO a reasoning model, and its reasoning tokens are
// billed against the SAME max_tokens budget as the visible answer. Unbounded,
// it burned 3,600–8,000 tokens thinking and then got cut off mid-JSON —
// finish_reason "length" on essentially every call, which is what made both
// single and bulk generation fail.
//
// Raising max_tokens does NOT fix this: reasoning simply expands to fill it
// (max_tokens 8000 -> 8000 reasoning tokens -> still truncated, 70s).
// Disabling reasoning is the actual fix. Measured on a real listing prompt:
//   unbounded          38.6s  finish=length  0 chars of usable JSON
//   reasoning "none"    4.9s  finish=stop    complete, schema-valid JSON
// Copy quality is unchanged — still 15 keywords and a full attribute set.
export const DEEPSEEK_REASONING_EFFORT = "none";
// With reasoning off a full listing costs ~450–620 completion tokens, so this
// is ~5x headroom. Only used if the model ignores reasoning_effort.
export const DEEPSEEK_MAX_TOKENS = 3000;
// One-shot escalation if a response still comes back truncated.
export const DEEPSEEK_MAX_TOKENS_RETRY = 8000;

// ---- Meesho character limits (UNDOCUMENTED — treat as configurable) ----------
// Meesho publishes no exact caps. These are defensive working values; the app
// hard-truncates against them and the UI shows counters.
export const TITLE_MAX = 100; // soft target; seller guidance ranges 50–120
export const DESC_MAX = 1400; // evidenced only by a seller screenshot counter
export const EAN_MAX = 13; // the one DOCUMENTED cap (EAN/UPC, incl. spaces)
export const KEYWORDS_TARGET = 15; // how many long-tail keywords to request

// ---- Image upload rules (mirror Gemini + Meesho constraints) -----------------
// Gemini-supported inline formats (verbatim from Google's image docs).
export const ALLOWED_IMAGE_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
];
// Keep well under Gemini's 20 MB total-request ceiling for inline base64.
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB

// ---- Multi-photo limits -------------------------------------------------------
// Upload cap per request. In "combine" mode every image goes into ONE Gemini
// request, so the total must stay under Gemini's 20 MB request ceiling — hence
// the separate, smaller combined budget.
export const MAX_IMAGES_PER_REQUEST = 12;
export const MAX_COMBINED_BYTES = 16 * 1024 * 1024; // 16 MB across all images
// Batch mode makes one call per photo; cap parallelism so we don't self-429.
// 6 concurrent DeepSeek calls measured clean (no 429s, 5.5s wall clock for 6
// listings). Lower this if the upstream starts rate-limiting.
export const BATCH_CONCURRENCY = 6;

// ---- Client-side downscale before upload -------------------------------------
// Gemini bills a FIXED prompt-token cost for an inline image regardless of its
// resolution (measured: 1229 prompt tokens for 512px, 1024px and 2048px alike),
// so anything above ~1280px buys zero extra detail and costs real upload time —
// a 2048px photo took 25.9s end-to-end vs 13.2s for the same shot at 512px.
// The browser resizes to these bounds before POSTing; served via /api/rules so
// the limits stay defined in one place.
export const CLIENT_IMAGE_MAX_DIM = 1280;
export const CLIENT_IMAGE_QUALITY = 0.85;

// ---- Reliability: retry/backoff for 429s (both APIs rate-limit) --------------
export const RETRY = {
  maxAttempts: 3,
  baseDelayMs: 500, // exponential: 500, 1000, 2000 ...
  maxDelayMs: 4000,
  retryStatuses: [429, 500, 502, 503, 504],
};

// Statuses where retrying the SAME endpoint is a waste of time and the caller
// should fail over instead. Gemini's 503 is literally "this model is
// experiencing high demand" — three backed-off retries against an overloaded
// model was the main cause of the occasional 35s extraction, while a sibling
// model answers in ~3s. Only applies where the caller has a fallback chain.
export const FAIL_FAST_STATUSES = [503];

// ---- Timeouts ----------------------------------------------------------------
// With thinking capped on Gemini and reasoning off on DeepSeek, calls land in
// 3–15s rather than 40–70s. Keep generous headroom over that for slow uploads
// and upstream hiccups, but low enough that a wedged call fails over to a retry
// instead of holding a batch slot for a minute and a half.
export const REQUEST_TIMEOUT_MS = 60_000;
