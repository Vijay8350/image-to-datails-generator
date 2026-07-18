/**
 * Backend proxy — the ONLY thing that ever holds the API keys.
 *
 * The browser talks solely to this server; it never sees GEMINI_API_KEY or
 * DEEPSEEK_API_KEY. Two sequential endpoints:
 *   POST /api/extract   photo        -> Gemini -> extracted fields JSON
 *   POST /api/generate  fields+cat   -> DeepSeek -> title/desc/keywords/attrs JSON
 * Plus GET /api/rules for the frontend to mirror validators/attribute sets.
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ALLOWED_IMAGE_MIME, MAX_IMAGE_BYTES } from "./src/config.js";
import { extractFieldsFromImage } from "./src/gemini.js";
import { generateListing } from "./src/deepseek.js";
import { UpstreamError } from "./src/http.js";
import {
  CATEGORIES,
  CATALOG_RULES,
  FIELD_GROUPS,
  IMAGE_REQUIREMENTS,
  attributeSetFor,
  validateListing,
  missingRequired,
  inferCategory,
  PROHIBITED_CATEGORIES,
} from "./src/meesho.js";
import {
  PRICING_DEFAULTS,
  PRICING_FIELDS,
  computeSettlement,
  requiredPriceForMargin,
} from "./src/pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable("x-powered-by");

// ---- CORS locked to the configured frontend origin(s) ------------------------
const allowedOrigins = (process.env.FRONTEND_ORIGIN || `http://localhost:${PORT}`)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      // Same-origin / curl / server-to-server requests have no Origin header.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
  })
);

app.use(express.json({ limit: "1mb" }));

// ---- Rate limiting (both upstream APIs 429 under load) -----------------------
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 30, // per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — slow down and retry shortly." },
});
app.use("/api/", apiLimiter);

// ---- Upload handling (in-memory; image never touches disk) -------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (ALLOWED_IMAGE_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new UpstreamError(`Unsupported image type: ${file.mimetype}`, { status: 415 }));
  },
});

// ---- Health + rules ----------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    gemini_key: Boolean(process.env.GEMINI_API_KEY),
    deepseek_key: Boolean(process.env.DEEPSEEK_API_KEY),
  });
});

app.get("/api/rules", (_req, res) => {
  res.json({
    categories: CATEGORIES,
    limits: CATALOG_RULES.limits,
    rules: CATALOG_RULES,
    field_groups: FIELD_GROUPS,
    image_requirements: IMAGE_REQUIREMENTS,
    attribute_sets: Object.fromEntries(CATEGORIES.map((c) => [c, attributeSetFor(c)])),
    prohibited: PROHIBITED_CATEGORIES,
    pricing_defaults: PRICING_DEFAULTS,
    pricing_fields: PRICING_FIELDS,
  });
});

// ---- Price & profit calculator (pure arithmetic — no upstream model call) ----
// The client mirrors this same formula for live typing; this endpoint is the
// authoritative implementation and keeps the math testable server-side.
app.post("/api/price", (req, res, next) => {
  try {
    const { mode, target_margin_percent, ...input } = req.body || {};

    if (mode === "target-margin") {
      const result = requiredPriceForMargin(target_margin_percent, input);
      if (!result) {
        throw new UpstreamError(
          "That margin is unreachable with these costs/fees — lower the target or reduce costs.",
          { status: 422 }
        );
      }
      return res.json({ mode, ...result });
    }

    res.json({ mode: "settlement", ...computeSettlement(input) });
  } catch (err) {
    next(err);
  }
});

// ---- STEP 1: photo -> Gemini -> extracted fields -----------------------------
app.post("/api/extract", upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) throw new UpstreamError("No image uploaded (field name: 'image').", { status: 400 });

    const fields = await extractFieldsFromImage(req.file.buffer, req.file.mimetype);

    // Re-derive the category from the product wording. The vision model can
    // answer "generic" for an obvious Rakhi/Saree/etc, which would silently
    // drop every category-specific field from the generated listing.
    fields.suggested_category = inferCategory(fields, fields.suggested_category);

    // Surface a prohibited-category warning based on the detected product type.
    const productType = String(fields.product_type || "").toLowerCase();
    const prohibitedHit = PROHIBITED_CATEGORIES.find((p) => productType.includes(p));

    res.json({
      fields,
      warnings: prohibitedHit
        ? [`Detected "${prohibitedHit}" — this may be a prohibited/restricted product on Meesho.`]
        : [],
    });
  } catch (err) {
    next(err);
  }
});

// ---- STEP 2: fields -> DeepSeek -> compliant listing -------------------------
app.post("/api/generate", async (req, res, next) => {
  try {
    const { fields, category } = req.body || {};
    if (!fields || typeof fields !== "object") {
      throw new UpstreamError("Missing 'fields' object in request body.", { status: 400 });
    }
    // Honour an explicit valid choice; otherwise infer rather than silently
    // falling back to "generic" and losing the category-specific fields.
    const cat = CATEGORIES.includes(category) ? category : inferCategory(fields);

    const listing = await generateListing(fields, cat);

    // Server-side validation mirrors the client so nothing slips through.
    const validation = validateListing({
      title: listing.title,
      description: listing.description,
      keywords: listing.keywords,
    });

    // Which * fields are still blank — these block submission on Meesho.
    const missing = missingRequired(listing.attributes, cat);

    res.json({
      listing,
      category: cat,
      validation,
      attribute_set: attributeSetFor(cat),
      missing_required: missing,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Static frontend (served same-origin) ------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// ---- Central error handler (never leaks keys) --------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || (err instanceof multer.MulterError ? 400 : 500);
  const message = err.message || "Internal server error";
  if (status >= 500) console.error("[error]", err);
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`\n  Meesho listing generator running: http://localhost:${PORT}`);
  console.log(`  CORS allowed origins: ${allowedOrigins.join(", ")}`);
  if (!process.env.GEMINI_API_KEY || !process.env.DEEPSEEK_API_KEY) {
    console.warn(
      "  ⚠  Missing API key(s). Copy .env.example to .env and fill GEMINI_API_KEY / DEEPSEEK_API_KEY.\n"
    );
  } else {
    console.log("  ✓ Both API keys detected.\n");
  }
});
