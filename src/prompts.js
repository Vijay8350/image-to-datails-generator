/**
 * Prompt + schema builders for both models.
 *
 *  - Gemini: extraction instruction + responseSchema (structured JSON output).
 *  - DeepSeek: system prompt (compliance checklist) + user prompt with an
 *    example JSON shape (required for DeepSeek JSON mode) + the word "json".
 */

import { CATALOG_RULES, attributeSetFor, CATEGORIES } from "./meesho.js";
import { TITLE_MAX, DESC_MAX, KEYWORDS_TARGET } from "./config.js";

// ---------------------------------------------------------------------------
// GEMINI — vision field extraction
// ---------------------------------------------------------------------------

/** JSON Schema passed as generationConfig.responseSchema. Kept flat/shallow. */
export const GEMINI_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    product_type: { type: "string", description: "e.g. Kurti, Running Shoes, Wall Clock" },
    suggested_category: {
      type: "string",
      // Built from CATEGORIES so this can never drift out of sync again.
      enum: CATEGORIES,
      description: `Best-guess Meesho category slug. Must be exactly one of: ${CATEGORIES.join(
        ", "
      )}. Use "generic" ONLY when none of the others fit.`,
    },
    primary_color: { type: "string" },
    secondary_colors: { type: "array", items: { type: "string" } },
    material: { type: "string", description: "Fabric or material if inferable, else empty" },
    pattern: { type: "string", description: "e.g. Solid, Floral Print, Striped" },
    style: { type: "string" },
    target_gender: { type: "string", description: "Men, Women, Unisex, Kids, or empty" },
    age_group: { type: "string", description: "Adult, Kids, Infant, or empty" },
    occasion: { type: "string", description: "e.g. Casual, Party, Festive, or empty" },
    key_features: {
      type: "array",
      items: { type: "string" },
      description: "Visible, factual selling points only — no invented specs",
    },
    visible_text: {
      type: "string",
      description: "Any text/logo/watermark visible ON the product or image, else empty",
    },
    image_compliance: {
      type: "object",
      description:
        "QC for the PRIMARY (first) image against Meesho image rules. With multiple images this describes image 1.",
      properties: {
        background_is_plain_white: { type: "boolean" },
        has_watermark_or_text: { type: "boolean" },
        has_logo: { type: "boolean" },
        solo_product_no_props: { type: "boolean" },
        notes: { type: "string" },
      },
      required: [
        "background_is_plain_white",
        "has_watermark_or_text",
        "has_logo",
        "solo_product_no_props",
      ],
    },
    per_image_compliance: {
      type: "array",
      description:
        "One entry per supplied image, in the same order. Only fill when more than one image is given.",
      items: {
        type: "object",
        properties: {
          image_index: { type: "integer", description: "1-based index of the image" },
          background_is_plain_white: { type: "boolean" },
          has_watermark_or_text: { type: "boolean" },
          has_logo: { type: "boolean" },
          solo_product_no_props: { type: "boolean" },
          shot_type: {
            type: "string",
            description: "Best guess: Front, Zoomed In, Table top, or Other",
          },
        },
      },
    },
  },
  required: [
    "product_type",
    "suggested_category",
    "primary_color",
    "key_features",
    "image_compliance",
  ],
};

export const GEMINI_EXTRACT_INSTRUCTION = [
  "You are a product-catalog vision analyst for an Indian e-commerce marketplace.",
  "Look ONLY at the provided product image and extract factual attributes.",
  "Rules:",
  "- Report only what is visually evident. If a field cannot be determined from the",
  "  image, return an empty string (or empty array) — never guess or invent specs.",
  "- key_features must be concrete and visible (e.g. 'V-neck', 'three-quarter sleeves',",
  "  'printed floral pattern') — not marketing language.",
  "- Fill image_compliance honestly; it is used to warn the seller about Meesho image QC.",
  "Return the result strictly as JSON matching the provided schema.",
].join("\n");

/**
 * Used when several images of the SAME product are supplied (Meesho wants a
 * front, a zoomed-in and a table-top shot). Consolidate them into ONE field set.
 */
export const GEMINI_COMBINE_INSTRUCTION = [
  "You are a product-catalog vision analyst for an Indian e-commerce marketplace.",
  "You are given MULTIPLE images of the SAME single product, from different angles",
  "(typically a front view, a close-up/zoomed view and a top-down view).",
  "",
  "Produce ONE consolidated set of fields describing that single product:",
  "- Merge evidence across all images. A detail visible in any image counts.",
  "- Use the close-up images for material, texture and workmanship detail.",
  "- Do NOT describe the images as separate products and do NOT multiply the",
  "  quantity just because there are several photos.",
  "- Report only what is visually evident. If a field cannot be determined from",
  "  any image, return an empty string (or empty array) — never guess.",
  "- key_features must be concrete and visible, not marketing language.",
  "",
  "Fill `image_compliance` for IMAGE 1 (the primary image), and fill",
  "`per_image_compliance` with one entry per image in the given order, including",
  "your best guess of each image's shot_type.",
  "Return the result strictly as JSON matching the provided schema.",
].join("\n");

// ---------------------------------------------------------------------------
// DEEPSEEK — compliant copy generation
// ---------------------------------------------------------------------------

/**
 * The example shape DeepSeek must return. JSON mode needs an example + "json".
 * Modelled on a REAL approved Meesho Rakhi listing (Style ID 306649534_15) so
 * the tone, title structure and attribute style match what actually passes QC.
 */
export const DEEPSEEK_OUTPUT_EXAMPLE = {
  title:
    "Surya Sun Rakhi for Brother Bhaiya - Traditional Meenakari Beaded Rakhi for Raksha Bandhan",
  description:
    "A bold Surya (sun) design rakhi with golden meenakari work, red and green beads. A traditional and auspicious rakhi for your brother.\n\n• Material: Alloy\n• Design: Surya (sun) motif with meenakari work\n• Colour: Multicolor\n• Thread: Traditional red and green beaded thread\n• Set: 1 rakhi\n\nIdeal for Raksha Bandhan gifting.",
  keywords: [
    "surya sun rakhi for brother",
    "meenakari rakhi for raksha bandhan",
    "traditional beaded rakhi bhaiya",
    "designer rakhi under 100",
  ],
  attributes: {
    product_name: "Surya Sun Rakhi for Brother Bhaiya - Traditional Meenakari Beaded Rakhi",
    generic_name: "Rakhi",
    color: "Multicolor",
    material: "Alloy",
    net_quantity: "1",
    size: "Free Size",
    type: "Religious",
    add_on: "No Add on",
    set_off: "1",
    occasion: "Raksha Bandhan",
  },
  compliance_self_check: {
    title_within_limit: true,
    no_all_caps: true,
    no_emoji: true,
    no_contact_info: true,
    keyword_in_first_5_words: true,
  },
};

export function buildDeepSeekSystemPrompt() {
  const lines = [
    "You are a Meesho catalog copywriter. You write listing copy that passes Meesho's",
    "quality control (QC) on the first try. Meesho ranking is retention-driven: keywords",
    "get a product indexed, but accurate, non-exaggerated copy reduces returns and lifts",
    "ranking. Never over-promise.",
    "",
    "You output ONLY valid json. Follow this rejectable compliance checklist exactly — any",
    "violation means the listing is REJECTED, so self-correct before answering:",
    "",
    "TITLE:",
    ...CATALOG_RULES.title.map((r) => `  - ${r}`),
    "",
    "DESCRIPTION:",
    ...CATALOG_RULES.description.map((r) => `  - ${r}`),
    "",
    "KEYWORDS:",
    ...CATALOG_RULES.keywords.map((r) => `  - ${r}`),
    "",
    "GENERAL:",
    "  - Use ONLY the facts provided from the image extraction. Do not invent materials,",
    "    measurements, certifications, or origins that were not given.",
    "  - If a mandatory attribute cannot be derived from the provided facts, leave its",
    "    value as an empty string so the seller fills it in — never fabricate it.",
  ];
  return lines.join("\n");
}

/**
 * ORDERING MATTERS: every byte that is stable for a given category goes FIRST,
 * and the per-product extracted facts go LAST.
 *
 * DeepSeek caches prompts by matching a common PREFIX, so anything placed above
 * the variable facts is re-cached on every product. The facts used to sit near
 * the top, which capped cache hits at 384 of ~1450 prompt tokens. Moving them to
 * the end lifts that to 1280 (27% -> 88% cached), which is both cheaper and
 * measurably faster (~5.4s -> ~4.8s per listing, and it compounds across a batch).
 *
 * If you add anything to this prompt, keep it ABOVE the EXTRACTED FACTS block.
 *
 * @param {object} extracted  Gemini's extracted fields.
 * @param {string} category   Selected Meesho category slug.
 */
export function buildDeepSeekUserPrompt(extracted, category) {
  const attrSet = attributeSetFor(category);
  const aiKeys = attrSet.aiFillable.map(
    (f) => `${f.key}${f.hint ? ` (${f.hint})` : ""}${f.required ? " [required]" : ""}`
  );
  const sellerKeys = attrSet.sellerOnly.map((f) => f.key);

  return [
    // ---- stable for this category (cacheable prefix) ----
    `Generate a Meesho listing as json for this ${category} product.`,
    "",
    `TITLE_MAX=${TITLE_MAX} characters. DESC_MAX=${DESC_MAX} characters.`,
    `Provide about ${KEYWORDS_TARGET} long-tail keywords.`,
    "",
    "Fill ONLY these `attributes` keys — they are derivable from the photo.",
    "Leave any key as an empty string if the extracted facts do not support a value:",
    ...aiKeys.map((k) => `  - ${k}`),
    "",
    "DO NOT output these keys at all — they are seller business/legal data that you",
    "must never guess (wrong tax codes and prices are a compliance risk):",
    `  ${sellerKeys.join(", ")}`,
    "",
    "Return json with EXACTLY these top-level keys: title, description, keywords,",
    "attributes, compliance_self_check. `title` is the Meesho Product Name.",
    "Example of the required shape (from a real approved Meesho listing):",
    JSON.stringify(DEEPSEEK_OUTPUT_EXAMPLE, null, 2),
    "",
    // ---- varies per product (must stay LAST) ----
    "EXTRACTED FACTS (from the product image — treat as ground truth, do not contradict):",
    JSON.stringify(extracted, null, 2),
  ].join("\n");
}
