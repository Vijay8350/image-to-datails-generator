/**
 * fetch wrapper with timeout + exponential-backoff retry.
 * Both Gemini and DeepSeek return 429 under load (report §5/§6), so every
 * outbound model call goes through here.
 */

import { RETRY, REQUEST_TIMEOUT_MS } from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Named error so callers can surface a clean message + status to the client. */
export class UpstreamError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {string} url
 * @param {RequestInit} options
 * @param {string} label  Upstream name for error messages ("Gemini"/"DeepSeek").
 * @returns {Promise<any>} Parsed JSON body.
 */
export async function fetchJsonWithRetry(url, options, label) {
  let lastErr;

  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) return await res.json();

      const text = await res.text().catch(() => "");
      const retryable = RETRY.retryStatuses.includes(res.status);

      if (retryable && attempt < RETRY.maxAttempts) {
        await sleep(backoffDelay(attempt, res.headers.get("retry-after")));
        lastErr = new UpstreamError(`${label} responded ${res.status}`, {
          status: res.status,
          body: text,
        });
        continue;
      }

      throw new UpstreamError(
        `${label} request failed (${res.status}): ${truncate(text)}`,
        { status: res.status, body: text }
      );
    } catch (err) {
      clearTimeout(timer);

      if (err instanceof UpstreamError) throw err;

      // Network error or timeout/abort — retry if attempts remain.
      const isAbort = err.name === "AbortError";
      lastErr = new UpstreamError(
        `${label} ${isAbort ? "timed out" : "network error"}: ${err.message}`,
        { status: 504 }
      );
      if (attempt < RETRY.maxAttempts) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastErr;
    }
  }

  throw lastErr ?? new UpstreamError(`${label} failed after retries`);
}

function backoffDelay(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000, RETRY.maxDelayMs);
    }
  }
  const exp = RETRY.baseDelayMs * 2 ** (attempt - 1);
  const jitter = exp * 0.25 * Math.random();
  return Math.min(exp + jitter, RETRY.maxDelayMs);
}

function truncate(s, n = 300) {
  return s && s.length > n ? s.slice(0, n) + "…" : s;
}
