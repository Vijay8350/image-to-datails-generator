/**
 * fetch wrapper with timeout + exponential-backoff retry.
 * Both Gemini and DeepSeek return 429 under load (report §5/§6), so every
 * outbound model call goes through here.
 */

import { RETRY, REQUEST_TIMEOUT_MS, FAIL_FAST_STATUSES } from "./config.js";

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
    const started = Date.now();

    // Callers may pass their own signal (hedged requests cancel the loser).
    // Combine it with the timeout signal rather than letting one clobber the other.
    const signal =
      options.signal && AbortSignal.any
        ? AbortSignal.any([controller.signal, options.signal])
        : options.signal || controller.signal;

    try {
      const res = await fetch(url, { ...options, signal });
      clearTimeout(timer);

      if (res.ok) {
        // Read the body BEFORE logging: these APIs stream, so headers arrive
        // almost immediately while the completion trickles in. Timing at the
        // header makes a 5s call look like a 0.2s one.
        const parsed = await res.json();
        console.log(
          `[upstream] ${label} ${res.status} in ${Date.now() - started}ms (attempt ${attempt})`
        );
        return parsed;
      }

      const text = await res.text().catch(() => "");
      const retryable = RETRY.retryStatuses.includes(res.status);

      // 503 means THIS model is shedding load. Retrying the same overloaded
      // model just burns the backoff budget — the caller has a fallback chain,
      // so hand back immediately and let it try a different model.
      if (res.status === 503 && FAIL_FAST_STATUSES.includes(503)) {
        console.warn(`[upstream] ${label} 503 after ${Date.now() - started}ms — failing over`);
        throw new UpstreamError(`${label} responded 503`, { status: 503, body: text });
      }

      if (retryable && attempt < RETRY.maxAttempts) {
        const delay = backoffDelay(attempt, res.headers.get("retry-after"));
        console.warn(
          `[upstream] ${label} ${res.status} after ${Date.now() - started}ms — ` +
            `retry ${attempt + 1}/${RETRY.maxAttempts} in ${Math.round(delay)}ms`
        );
        await sleep(delay);
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

      // Deliberately cancelled by the caller (a hedge that lost the race).
      // Retrying it would defeat the point of cancelling.
      if (options.signal?.aborted) {
        throw new UpstreamError(`${label} cancelled`, { status: 499 });
      }

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
