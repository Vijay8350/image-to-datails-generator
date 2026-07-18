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
export const GEMINI_MODEL_FALLBACKS = ["gemini-flash-latest"];
export const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

// ---- Text model: DeepSeek (writes the copy — TEXT ONLY, never the image) ------
// OpenAI-compatible chat/completions endpoint.
export const DEEPSEEK_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_API_BASE = "https://api.deepseek.com";
export const DEEPSEEK_CHAT_PATH = "/chat/completions";

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
export const BATCH_CONCURRENCY = 3;

// ---- Reliability: retry/backoff for 429s (both APIs rate-limit) --------------
export const RETRY = {
  maxAttempts: 3,
  baseDelayMs: 500, // exponential: 500, 1000, 2000 ...
  maxDelayMs: 4000,
  retryStatuses: [429, 500, 502, 503, 504],
};

// ---- Timeouts ----------------------------------------------------------------
// gemini-3.5-flash is a reasoning model; vision calls routinely take 40–60s, so
// the per-attempt cap sits above that to avoid spurious aborts + retry storms.
export const REQUEST_TIMEOUT_MS = 90_000;
