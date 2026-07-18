# Research Report: Building a Master Prompt for a Meesho Listing-Generator Web Panel (Gemini Vision + DeepSeek)

## TL;DR
- **The architecture is sound, with one hard correction: DeepSeek's public API is text-only (the deployed V4 models have no vision), so Gemini must do all image reading and DeepSeek all copywriting — and both must be called from a small backend, never from browser JavaScript, because client-side keys are always extractable.** Use `gemini-3.5-flash` (current default vision model, July 2026) for field extraction and `deepseek-v4-flash` for content generation.
- **Meesho publishes almost no exact character limits.** The description field's 1400-character cap is evidenced only by the seller's own screenshot counter ("183/1400"); the "Product Name"/title field has no documented hard cap — real seller guidance clusters at "under 100 characters" (range 50–120). The master prompt should treat 1400 (description) and ~100 (title) as configurable constants and hard-truncate defensively.
- **The highest-leverage, most enforceable rules are concrete:** primary images must show a solo product on a white/light background with no text/watermark/logo/price; titles and descriptions must avoid ALL-CAPS, emojis, contact info, promo text and false claims; and all mandatory catalog attributes (GST %, HSN, Net Weight, MRP, Meesho Price, Color, Material, Country of Origin, Manufacturer/Packer details) must be filled or the catalog fails QC.

## Key Findings

1. **Meesho gives very little official numeric guidance.** Neither the Product Name limit nor the 1400-character description limit is confirmed in any Meesho-published document. Build the tool with these as adjustable parameters and rely on the screenshot for the description cap.
2. **Meesho ranking is retention-driven, not keyword-stuffing-driven.** Meesho's own engineering blog ("Quality Focused Feed Re-ranking," meesho.io/blog) confirms the final rank combines a learn-to-rank (LTR) relevance score with an explicit quality component "based on the predicted NQD" (share of 1- and 2-star reviews out of total ratings), applied as `1 − NQD` with a tuning factor "α... finalized to 0.4 through rigorous A/B testing." In practice: keywords get you *indexed*; images, price, dispatch speed and low returns get you *ranked*.
3. **Gemini has two live API surfaces in 2026** — the classic `generateContent` REST endpoint and the newer "Interactions API." Both support structured JSON output and image input. The master prompt should pin one surface and pin the model string.
4. **DeepSeek is OpenAI-compatible and cheap**, with a JSON output mode, but requires the word "json" plus an example shape in the prompt, and has no image capability you should rely on.
5. **The secure pattern is a backend proxy** (Node/Express or Python/Flask) holding both keys in environment variables; the browser only ever talks to your own server.

## Details

### 1. Meesho listing fields, limits and mandatory attributes

**Character limits (flag: mostly unconfirmed by Meesho).**
- **Product Name / Title:** No Meesho-documented hard cap. Third-party seller guidance conflicts: "under 100 characters" is most commonly cited (StoreDropship); others say 50–120 (Lohar Studio) or 60–100 (Rekonsile). Treat ~100 as a soft target and expose it as a constant.
- **Product Description:** The "183/1400" counter in the seller's screenshot is the only evidence of a 1400-character cap; no published Meesho text confirms it, and Meesho's official bulk-upload guidance only warns to "avoid long descriptions ... to avoid rejection." Use 1400 as the working limit.
- **EAN/UPC:** the one field with a documented limit — 13 characters including spaces (leave blank if not applicable).

**Mandatory fields** (verified from real Meesho apparel Excel templates, marked "* Compulsory Field"): Product Name; Variation/Size; Meesho Price; Wrong/Defective Returns Price; MRP (must be ≥ Meesho Price); Product GST %; HSN ID (dropdown); Net Weight (gms); Inventory; Country of Origin; Manufacturer Details (name + address); Packer Details (name + address); Color; Combo of / Set Of; Fabric/Material; plus category-specific compulsory attributes (e.g. Length Size for kurtis; Fit/Shape and Occasion for dresses). **Mandatory vs optional is category-dependent.** Product ID / Style ID columns are system-generated (marked "to be filled by Meesho only"). Generic Name, Manufacturer/Packer/Importer name-address-pincode and Net Quantity are additionally required under the Legal Metrology Act declarations Meesho enforces (per supplier.meesho.com learning hub).

**Optional/recommended attributes that lift catalog quality:** SKU ID; Group ID; Brand Name; Product Description; Importer Details; EAN/UPC; Pattern / Print or Pattern Type; Sleeve Length; Sleeve Styling; Neck; Net Quantity (N); Ornamentation; Occasion; Fit/Shape; Surface Styling; Weave Type; and various size measurements. Filling more valid attributes raises the Catalog Quality Score and enables the product to appear in filtered searches.

### 2. Meesho SEO / ranking best practices
- **How ranking works:** Meesho's engineering blog describes feed re-ranking that combines an LTR relevance score with an explicit product-quality factor (`1 − NQD`, α = 0.4). Additional signals per multiple seller sources: click-through rate; price competitiveness (Meesho is highly price-sensitive and tends to favour the cheapest seller of a given design); dispatch speed (Next Day Dispatch gives a documented visibility boost); inventory availability; ratings; and low return/cancellation rates.
- **Bad Quality Score (internal):** roughly the % of 1–2 star orders. Third-party tool OTO ECOM (from analysis of "over 5,000 catalogs") claims "Boost Mode" at 0–2% and suppression once a "soft threshold" of ~3–5% is crossed, with organic reach collapsing higher up. **These thresholds are third-party estimates, not Meesho-published — flag as such.**
- **Titles:** put the main keyword in the first few words; structure as [Attribute/Material] + [Product Type] + [For Whom] + [Use/Occasion]; include product type, material, style, main feature; avoid ALL-CAPS, emojis, symbols, and brand names if unbranded; keep it human-readable, not keyword-stuffed. Example: "Women's Cotton Printed Kurti – Casual Daily Wear – Soft Fabric."
- **Descriptions:** clear, factual, benefit-driven; bullet points for specs (material, measurements, care); set accurate expectations to reduce returns; no over-promising.
- **Keyword research:** use Meesho's own search-bar autocomplete; include occasion-based ("party wear kurti"), price-based ("kurti under 500") and regional/localised terms ("Lucknowi chikan kurti"); prioritise long-tail phrases.

### 3. Listing policy / QC rules
- **Images:** minimum 1 front image per SKU; solo product, no props; no text/watermark/logo/price on the primary image; no graphic/inverted/pixelated/blurred/cluttered images; not stretched/shrunk; not partial; not offensive. Format historically JPEG only in RGB color space (no CMYK); minimum 500×500 px, recommended 1000×1000 px square (1:1); newer guidance also cites PNG and a ~5 MB max. Meesho runs duplicate-image detection, so cross-posted Amazon/Flipkart images need meaningful variation.
- **Text rules:** no misleading/exaggerated claims, no false guarantees, no MRP inflation, no contact info, no promotional text, no unauthorised brand names.
- **Common rejection reasons:** poor image quality, watermark/text on image, wrong category, misleading descriptions, counterfeit items, duplicate listings, incomplete attributes, inaccurate size charts.
- **Prohibited/restricted:** counterfeits, drugs/medicines, narcotics, tobacco/e-cigarettes, alcohol, fireworks, currencies, obscene material, illegal animal parts, adulterated food, free/FOC samples — full enumerated list in Meesho's Prohibited and Restricted Products Policy (operated by Fashnear Technologies Pvt Ltd).

### 4. Google Gemini API (2026) — vision + structured output
- **Model:** current default is `gemini-3.5-flash` (Gemini 3.5 is the "current" family as of July 2026; the 2.5 family is being superseded). Use Flash for cost-effective, high-volume image understanding.
- **Two API surfaces:**
  - *Classic:* `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`, key via `?key=$GEMINI_API_KEY` or header `x-goog-api-key`. Image as inline base64 in `contents[].parts[].inline_data{mime_type,data}` or via the Files API. Structured output via `generationConfig.responseMimeType: "application/json"` + `responseSchema`.
  - *Interactions API:* `POST https://generativelanguage.googleapis.com/v1beta/interactions`, header `x-goog-api-key`, model + `input` array of typed parts, `response_format` carrying a JSON schema.
- **Image input:** inline base64 (per Google's docs the max total request size is 20 MB "which includes text prompts, system instructions, and all files provided inline"; the inline payload ceiling was raised to 100 MB on Jan 12, 2026) or the Files API (for >20 MB or reuse; uploaded files persist 48 hours). Supported formats, verbatim from Google's Image-understanding docs: PNG (image/png), JPEG (image/jpeg), WEBP (image/webp), HEIC (image/heic), HEIF (image/heif).
- **Structured JSON:** define a `responseSchema`/response schema; note that not all JSON-Schema features are supported and very large/deeply nested schemas can return a 400.
- **Rate limits/pricing:** tier-based; verify current per-model rates on the official pricing page before shipping.

### 5. DeepSeek API (2026) — text generation + JSON
- **Models:** `deepseek-v4-flash` (cheap, high-volume — use this for content generation) and `deepseek-v4-pro` (harder reasoning). Legacy `deepseek-chat`/`deepseek-reasoner` are compatibility aliases; per DeepSeek's official pricing docs they "will be deprecated on 2026/07/24 15:59 UTC," with `deepseek-chat` mapping to v4-flash non-thinking mode and `deepseek-reasoner` to its thinking mode.
- **No vision:** the deployed V4 chat models are text-only; do not use DeepSeek to read the image. (A third-party page mentions a "deepseek-vision-preview" beta, but this is not in the official model list — do not rely on it.)
- **Endpoint:** OpenAI-compatible, base URL `https://api.deepseek.com`, path `/chat/completions`; auth `Authorization: Bearer $DEEPSEEK_API_KEY`. An Anthropic-compatible base URL (`/anthropic`) also exists.
- **JSON output:** set `response_format={"type":"json_object"}` AND include the word "json" plus an example shape in the prompt; set `max_tokens` high enough to avoid truncation (`finish_reason:"length"`); validate the parsed object yourself (JSON mode guarantees syntax, not schema).
- **Pricing (official DeepSeek Models & Pricing page, verified July 10, 2026):** `deepseek-v4-flash` = $0.0028 cache-hit input / $0.14 cache-miss input / $0.28 output per 1M tokens; `deepseek-v4-pro` = $0.435 cache-miss input / $0.87 output (promotional; standard $1.74/$3.48). 1M-token context; concurrency is dynamically limited (HTTP 429 on overload) — add retry/backoff.

### 6. Build considerations for the web panel
- **Never call either API from browser JS.** Anything shipped to the browser (including build-time env vars) is extractable via DevTools. Route all calls through a backend proxy (Node/Express or Python/Flask) that reads keys from environment variables / a secrets manager, restricts CORS to your own frontend origin, adds rate limiting and retries, and returns only the model response (never the key).
- **Recommended flow:** Browser uploads photo → backend `/api/extract` sends the image to Gemini and returns extracted fields as JSON → backend `/api/generate` sends those fields + Meesho rules to DeepSeek and returns generated title/description/keywords/attributes as JSON → frontend renders everything in an editable form with per-field character counters (title ~100, description 1400) and copy-to-clipboard buttons.
- **UX:** show extracted vs generated fields side by side; validate against the mandatory-field list and character limits client-side before the user copies into Meesho; flag prohibited words and policy risks inline.

## Recommendations
1. **Pin versions in the master prompt.** Instruct Claude Code to use `gemini-3.5-flash` and `deepseek-v4-flash`, defined as top-of-file constants so they can be swapped when versions change.
2. **Build the backend proxy first**, with two endpoints (`/api/extract`, `/api/generate`), keys in `.env`, CORS locked to the frontend origin, and JSON-schema validation on both model outputs (Gemini's `responseSchema`; app-side validation for DeepSeek).
3. **Make limits configurable constants** (`TITLE_MAX=100`, `DESC_MAX=1400`) and hard-truncate defensively, since Meesho's real limits are undocumented.
4. **Encode compliance as a rejectable checklist** in the DeepSeek system prompt (no ALL-CAPS, no emojis, no contact info, no brand misuse, no false claims, keyword in first 5 words, bullet-point specs) and mirror it as client-side validators.
5. **Change triggers:** if Gemini/DeepSeek deprecate a model or Meesho publishes official limits, update the constants; specifically re-verify DeepSeek model names before **2026/07/24 15:59 UTC** when the legacy aliases retire.

## Caveats
- Meesho's title limit and the 1400 description limit are **not** officially documented; the description figure rests solely on the seller's screenshot, and title guidance (50–120, most often "under 100") comes only from third-party sellers/tools.
- Bad Quality Score suppression thresholds (3–5% soft threshold, etc.) are third-party estimates (OTO ECOM), not Meesho-published; only the NQD/α = 0.4 re-ranking mechanism is confirmed by Meesho's own blog.
- Gemini model naming and the two API surfaces (classic `generateContent` vs Interactions API) are evolving; verify the exact current model string and endpoint before building.
- DeepSeek "vision" is not available in the deployed models despite one third-party claim; keep image reading strictly on Gemini.
- Mandatory vs optional attribute status varies by product category, which matters for a multi-category seller — the tool should pull the correct attribute set per selected Meesho category rather than assume a fixed schema.