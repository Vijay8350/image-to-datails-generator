# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This is a **greenfield project with no code yet.** The only file present is a research report
(`compass_artifact_...markdown.md`) that acts as the spec/master prompt for the app to be built:
a **Meesho listing-generator web panel** that turns a product photo into a compliant Meesho catalog
listing (title, description, keywords, attributes).

There is no build, lint, or test tooling yet — set it up when you scaffold the app. Read the research
report in full before writing code; it contains verified constraints, flagged unknowns, and version
pins that must survive into the implementation.

## Non-negotiable architecture

The report's core correction drives the whole design:

- **Two models, split by capability.** Gemini reads the image (vision); DeepSeek writes the copy (text).
  DeepSeek's deployed V4 models are **text-only** — never route the image to DeepSeek, and ignore any
  "deepseek-vision" claim (not in the official model list).
- **Backend proxy is mandatory.** Both API keys live in backend env vars only. The browser talks solely
  to your own server — never call Gemini or DeepSeek from browser JS (build-time env vars are extractable
  via DevTools too). Lock CORS to the frontend origin; add rate limiting + retry/backoff (both APIs return
  429 under load).
- **Two endpoints, in sequence:** `/api/extract` (photo → Gemini → extracted fields JSON) then
  `/api/generate` (fields + Meesho rules → DeepSeek → title/description/keywords/attributes JSON).
  Frontend renders results in an editable form with per-field character counters and copy-to-clipboard.

## Version pins (define as top-of-file constants so they can be swapped)

- Vision model: `gemini-3.5-flash` (classic `generateContent` REST surface; structured output via
  `generationConfig.responseMimeType: "application/json"` + `responseSchema`).
- Text model: `deepseek-v4-flash` (OpenAI-compatible, `https://api.deepseek.com/chat/completions`).
  For DeepSeek JSON mode you must set `response_format={"type":"json_object"}` **and** include the word
  "json" plus an example shape in the prompt; JSON mode guarantees syntax, not schema — validate the
  parsed object app-side.
- **Re-verify DeepSeek model names before 2026/07/24 15:59 UTC** — the legacy `deepseek-chat` /
  `deepseek-reasoner` aliases retire then.

## Meesho domain rules to encode

- Character limits are **undocumented by Meesho** — treat as configurable constants and hard-truncate
  defensively: `TITLE_MAX=100` (soft target, guidance ranges 50–120), `DESC_MAX=1400` (evidenced only by
  a seller screenshot). EAN/UPC is the one documented cap: 13 chars.
- Encode compliance as a **rejectable checklist** in the DeepSeek system prompt AND mirror it as
  client-side validators: no ALL-CAPS, no emojis/symbols, no contact info, no unauthorised brand names,
  no false/exaggerated claims, main keyword in the first ~5 words, bullet-point specs.
- Validate mandatory catalog attributes (GST %, HSN, Net Weight, MRP ≥ Meesho Price, Color, Material,
  Country of Origin, Manufacturer/Packer details, etc.). **Mandatory vs optional is category-dependent** —
  pull the correct attribute set per selected Meesho category rather than assuming a fixed schema.
- Ranking is retention-driven, not keyword-stuffing: keywords get you indexed; images, price, dispatch
  speed and low returns get you ranked. Keep generated copy factual to reduce returns.
