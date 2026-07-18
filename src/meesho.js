/**
 * Meesho domain rules — single source of truth for compliance.
 *
 * FIELD SET IS VERIFIED against the real Meesho "Edit Product" seller screen
 * (Style ID 306649534_15, a Rakhi listing), not inferred. Groups, labels,
 * required markers (*) and the 1400-char description counter all mirror that form.
 *
 * Consumers:
 *   1. prompts.js — bakes CATALOG_RULES + AI-fillable keys into the DeepSeek prompt.
 *   2. server.js  — exposes everything via /api/rules so the UI mirrors it exactly.
 */

import { TITLE_MAX, DESC_MAX, EAN_MAX } from "./config.js";

// ---- Form sections, in the order Meesho shows them ---------------------------
export const FIELD_GROUPS = [
  { id: "pricing", label: "Price, Size and Inventory" },
  { id: "details", label: "Product Details" },
  { id: "other", label: "Other Attributes" },
];

/**
 * Every field on the Meesho Edit Product form.
 *   required : marked with * on the form (blocks submission)
 *   source   : "ai"     -> derivable from the photo, generated for you
 *              "seller" -> business/legal data ONLY you can supply.
 *
 * GST and HSN are deliberately "seller": a wrong tax code is a compliance and
 * financial risk, so the tool must never guess them.
 */
export const BASE_FIELDS = [
  // --- Price, Size and Inventory ---
  { key: "gst_percent", label: "GST %", group: "pricing", required: true, source: "seller", hint: "e.g. 3" },
  { key: "hsn_code", label: "HSN Code", group: "pricing", required: true, source: "seller", hint: "e.g. 7117 (imitation jewellery)" },
  { key: "net_weight_gms", label: "Net Weight (gms)", group: "pricing", required: true, source: "seller" },
  { key: "style_code", label: "Style code / Product ID", group: "pricing", required: false, source: "seller", hint: "optional" },
  { key: "product_name", label: "Product Name", group: "pricing", required: true, source: "ai" },
  { key: "size", label: "Size", group: "pricing", required: true, source: "ai", hint: "e.g. Free Size" },
  { key: "meesho_price", label: "Meesho Price", group: "pricing", required: true, source: "seller" },
  { key: "wrong_defective_returns_price", label: "Wrong/Defective Returns Price", group: "pricing", required: true, source: "seller" },
  { key: "prepaid_discount", label: "Prepaid Discount", group: "pricing", required: false, source: "seller" },
  { key: "mrp", label: "MRP", group: "pricing", required: true, source: "seller", hint: "must be ≥ Meesho Price" },
  { key: "inventory", label: "Inventory", group: "pricing", required: true, source: "seller" },

  // --- Product Details ---
  { key: "color", label: "Color", group: "details", required: true, source: "ai" },
  { key: "generic_name", label: "Generic Name", group: "details", required: true, source: "ai", hint: "Legal Metrology, e.g. Rakhi" },
  { key: "material", label: "Material", group: "details", required: true, source: "ai" },
  { key: "net_quantity", label: "Net Quantity (N)", group: "details", required: true, source: "ai", hint: "e.g. 1" },
  { key: "country_of_origin", label: "Country of Origin", group: "details", required: true, source: "seller" },
  { key: "manufacturer_name", label: "Manufacturer Name", group: "details", required: true, source: "seller" },
  { key: "manufacturer_address", label: "Manufacturer Address", group: "details", required: true, source: "seller" },
  { key: "manufacturer_pincode", label: "Manufacturer Pincode", group: "details", required: true, source: "seller" },
  { key: "packer_name", label: "Packer Name", group: "details", required: true, source: "seller" },
  { key: "packer_address", label: "Packer Address", group: "details", required: true, source: "seller" },
  { key: "packer_pincode", label: "Packer Pincode", group: "details", required: true, source: "seller" },
  { key: "importer_name", label: "Importer Name", group: "details", required: false, source: "seller", hint: "Not required if made in India" },
  { key: "importer_address", label: "Importer Address", group: "details", required: false, source: "seller" },
  { key: "importer_pincode", label: "Importer Pincode", group: "details", required: false, source: "seller" },

  // --- Other Attributes ---
  { key: "add_on", label: "Add On", group: "other", required: false, source: "ai", hint: "e.g. No Add on" },
  { key: "brand", label: "Brand", group: "other", required: false, source: "seller", hint: "leave blank if unbranded" },
  { key: "set_off", label: "Set Off", group: "other", required: false, source: "ai", hint: "e.g. 1" },
  { key: "type", label: "Type", group: "other", required: false, source: "ai", hint: "e.g. Religious" },
  { key: "description", label: "Description", group: "other", required: false, source: "ai", hint: `max ${DESC_MAX} chars` },
  { key: "ean_upc", label: "EAN/UPC", group: "other", required: false, source: "seller", hint: `max ${EAN_MAX} chars, blank if N/A` },
];

// ---- Category-specific extras / defaults --------------------------------------
// Meesho's compulsory set varies by category; these layer on top of BASE_FIELDS.
export const CATEGORY_ATTRIBUTES = {
  generic: { extra: [] },
  rakhi: {
    extra: [
      // Who it's for + what it is — the two biggest rakhi search drivers.
      { key: "rakhi_for", label: "Rakhi For", group: "details", required: true, source: "ai", hint: "Brother / Bhabhi / Kids / Couple" },
      { key: "rakhi_type", label: "Rakhi Type", group: "details", required: true, source: "ai", hint: "Single / Set / Lumba / Bracelet" },
      { key: "pack_of", label: "Pack Of", group: "details", required: true, source: "ai", hint: "number of rakhis, e.g. 1" },
      // Design / craft attributes buyers filter on.
      { key: "motif_design", label: "Motif / Design", group: "other", required: false, source: "ai", hint: "e.g. Surya, Om, Swastik, Ganesha, Cartoon" },
      { key: "work_type", label: "Work / Ornamentation", group: "other", required: false, source: "ai", hint: "e.g. Meenakari, Kundan, Stone, Pearl, Beads" },
      { key: "thread_material", label: "Thread Material", group: "other", required: false, source: "ai", hint: "e.g. Silk Thread, Cotton Dori" },
      { key: "occasion", label: "Occasion", group: "other", required: false, source: "ai", hint: "e.g. Raksha Bandhan" },
      // Roli-chawal style inclusions are a common Meesho rakhi add-on.
      { key: "includes", label: "Includes", group: "other", required: false, source: "ai", hint: "e.g. Roli Chawal, Greeting Card" },
    ],
  },
  kurti: {
    extra: [
      { key: "length_size", label: "Length Size", group: "details", required: true, source: "ai" },
      { key: "sleeve_length", label: "Sleeve Length", group: "other", required: false, source: "ai" },
      { key: "neck", label: "Neck", group: "other", required: false, source: "ai" },
      { key: "pattern", label: "Pattern / Print Type", group: "other", required: false, source: "ai" },
    ],
  },
  dress: {
    extra: [
      { key: "fit_shape", label: "Fit / Shape", group: "details", required: true, source: "ai" },
      { key: "occasion", label: "Occasion", group: "details", required: true, source: "ai" },
      { key: "sleeve_length", label: "Sleeve Length", group: "other", required: false, source: "ai" },
      { key: "pattern", label: "Pattern / Print Type", group: "other", required: false, source: "ai" },
    ],
  },
  saree: {
    extra: [
      { key: "blouse_piece", label: "Blouse Piece (With/Without)", group: "details", required: true, source: "ai" },
      { key: "weave_type", label: "Weave Type", group: "other", required: false, source: "ai" },
      { key: "border", label: "Border", group: "other", required: false, source: "ai" },
    ],
  },
  jewellery: {
    extra: [
      { key: "plating", label: "Plating", group: "other", required: false, source: "ai" },
      { key: "stone_type", label: "Stone Type", group: "other", required: false, source: "ai" },
      { key: "occasion", label: "Occasion", group: "other", required: false, source: "ai" },
    ],
  },
};

export const CATEGORIES = Object.keys(CATEGORY_ATTRIBUTES);

/**
 * Backstop category inference from the extracted product type.
 * The vision model sometimes answers "generic" even when the product clearly
 * belongs to a real category, which would silently drop all the
 * category-specific fields — so re-derive it from the product wording.
 */
const CATEGORY_KEYWORDS = {
  rakhi: ["rakhi", "raksha bandhan", "lumba"],
  kurti: ["kurti", "kurta"],
  saree: ["saree", "sari"],
  dress: ["dress", "gown", "frock"],
  jewellery: [
    "jewellery", "jewelry", "necklace", "earring", "bracelet", "bangle",
    "pendant", "ring", "anklet", "chain", "mangalsutra", "bead",
  ],
};

export function inferCategory(extracted, fallback = "generic") {
  const hay = [
    extracted?.product_type,
    extracted?.suggested_category,
    extracted?.style,
    ...(extracted?.key_features || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some((w) => hay.includes(w))) return cat;
  }
  return CATEGORIES.includes(fallback) ? fallback : "generic";
}

/** Full field list for a category, in form order. */
export function attributeSetFor(category) {
  const cat = CATEGORY_ATTRIBUTES[category] ? category : "generic";
  const fields = [...BASE_FIELDS, ...CATEGORY_ATTRIBUTES[cat].extra];
  return {
    category: cat,
    groups: FIELD_GROUPS,
    fields,
    mandatory: fields.filter((f) => f.required),
    optional: fields.filter((f) => !f.required),
    aiFillable: fields.filter((f) => f.source === "ai"),
    sellerOnly: fields.filter((f) => f.source === "seller"),
  };
}

// ---- Image requirements (verbatim from the seller panel) ----------------------
export const IMAGE_REQUIREMENTS = {
  required: [
    { key: "front", label: "Front Image", note: "Upload Front View Image" },
    { key: "zoomed", label: "Zoomed In Image", note: "Upload Close Up View" },
    { key: "tabletop", label: "Table top Image", note: "Add top view" },
  ],
  guidelines: [
    "Images with text/Watermark are not acceptable in primary images.",
    "Product image should not have any text.",
    "Please add solo product image without any props.",
  ],
};

// ---- Compliance checklist (rejectable rules) ---------------------------------
export const CATALOG_RULES = {
  limits: { TITLE_MAX, DESC_MAX, EAN_MAX },
  title: [
    `Keep the Product Name within ${TITLE_MAX} characters.`,
    "Put the main keyword within the first ~5 words.",
    "Structure: [Attribute/Material] + [Product Type] + [For Whom] + [Use/Occasion].",
    "No ALL-CAPS words, no emojis, no symbols.",
    "No brand names unless the product is genuinely that authorised brand.",
    "Human-readable — not keyword-stuffed.",
  ],
  description: [
    `Keep the description within ${DESC_MAX} characters.`,
    "Factual and benefit-driven; set accurate expectations to reduce returns.",
    "Use bullet points for specs (material, measurements, care).",
    "No false/exaggerated claims, no false guarantees, no MRP inflation.",
    "No contact info (phone, email, URLs, social handles).",
    "No promotional text and no unauthorised brand names.",
    "No emojis or ALL-CAPS.",
  ],
  keywords: [
    "Prioritise long-tail phrases over single words.",
    "Mix occasion-based, price-based and regional/localised terms.",
    "Keep every keyword factual and relevant to the actual product.",
  ],
  images: IMAGE_REQUIREMENTS.guidelines,
};

// ---- Prohibited / restricted products -----------------------------------------
export const PROHIBITED_CATEGORIES = [
  "counterfeit", "drugs", "medicine", "narcotics", "tobacco",
  "e-cigarette", "alcohol", "fireworks", "currency", "obscene", "animal parts",
];

// ---- Validators ---------------------------------------------------------------
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const CONTACT_RE =
  /(\b\d{10}\b|\+\d{6,}|@[a-z0-9._-]+|https?:\/\/|www\.|\b[\w.+-]+@[\w-]+\.[\w.-]+\b)/i;

function countAllCapsWords(text) {
  return String(text).split(/\s+/).filter(Boolean).filter((w) => {
    const letters = w.replace(/[^A-Za-z]/g, "");
    return letters.length >= 2 && letters === letters.toUpperCase();
  });
}

export function validateListing({ title = "", description = "", keywords = [] } = {}) {
  const issues = { title: [], description: [], keywords: [] };

  if (!title.trim()) issues.title.push({ level: "error", message: "Product Name is empty." });
  else {
    if (title.length > TITLE_MAX)
      issues.title.push({ level: "error", message: `Product Name is ${title.length} chars (max ${TITLE_MAX}).` });
    if (EMOJI_RE.test(title))
      issues.title.push({ level: "error", message: "Product Name contains emoji/symbols." });
    const caps = countAllCapsWords(title);
    if (caps.length)
      issues.title.push({ level: "warn", message: `Possible ALL-CAPS word(s): ${caps.slice(0, 3).join(", ")}.` });
    if (CONTACT_RE.test(title))
      issues.title.push({ level: "error", message: "Product Name looks like it contains contact info." });
  }

  if (!description.trim()) issues.description.push({ level: "error", message: "Description is empty." });
  else {
    if (description.length > DESC_MAX)
      issues.description.push({ level: "error", message: `Description is ${description.length} chars (max ${DESC_MAX}).` });
    if (EMOJI_RE.test(description))
      issues.description.push({ level: "error", message: "Description contains emoji/symbols." });
    if (CONTACT_RE.test(description))
      issues.description.push({ level: "error", message: "Description looks like it contains contact info." });
    const caps = countAllCapsWords(description);
    if (caps.length > 2)
      issues.description.push({ level: "warn", message: `Several ALL-CAPS words (${caps.length}). Review for shouting.` });
  }

  if (!Array.isArray(keywords) || keywords.length === 0)
    issues.keywords.push({ level: "warn", message: "No keywords generated." });

  return issues;
}

/** Which required form fields are still empty (blocks Meesho submission). */
export function missingRequired(values, category) {
  const { mandatory } = attributeSetFor(category);
  return mandatory
    .filter((f) => !String(values?.[f.key] ?? "").trim())
    .map((f) => ({ key: f.key, label: f.label, source: f.source }));
}

export function hasBlockingIssues(issues) {
  return Object.values(issues).flat().some((i) => i.level === "error");
}
