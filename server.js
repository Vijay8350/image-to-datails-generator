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

import {
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_REQUEST,
  MAX_COMBINED_BYTES,
  BATCH_CONCURRENCY,
  CLIENT_IMAGE_MAX_DIM,
  CLIENT_IMAGE_QUALITY,
} from "./src/config.js";
import { extractFieldsFromImages } from "./src/gemini.js";
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

// Batch generate posts one fields object per image, so allow a larger body.
app.use(express.json({ limit: "4mb" }));

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
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_REQUEST },
  fileFilter(_req, file, cb) {
    if (ALLOWED_IMAGE_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new UpstreamError(`Unsupported image type: ${file.mimetype}`, { status: 415 }));
  },
});

/**
 * Run async work over items with a small concurrency cap.
 * Batch mode fires one Gemini call per photo; unbounded parallelism would
 * trip the upstream rate limits (both APIs 429 under load).
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        // One bad photo must not sink the whole batch.
        results[i] = { ok: false, error: err.message || "failed", status: err.status || 500 };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

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
    // The browser downscales to these bounds before uploading — Gemini bills a
    // fixed token cost per image regardless of resolution, so extra pixels are
    // pure upload latency.
    image_processing: {
      max_dim: CLIENT_IMAGE_MAX_DIM,
      quality: CLIENT_IMAGE_QUALITY,
      max_images: MAX_IMAGES_PER_REQUEST,
    },
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

/** Post-process a raw Gemini field set: fix category, flag prohibited goods. */
function finaliseFields(fields) {
  // Re-derive the category from the product wording. The vision model can
  // answer "generic" for an obvious Rakhi/Saree/etc, which would silently
  // drop every category-specific field from the generated listing.
  fields.suggested_category = inferCategory(fields, fields.suggested_category);

  const productType = String(fields.product_type || "").toLowerCase();
  const prohibitedHit = PROHIBITED_CATEGORIES.find((p) => productType.includes(p));

  return {
    fields,
    warnings: prohibitedHit
      ? [`Detected "${prohibitedHit}" — this may be a prohibited/restricted product on Meesho.`]
      : [],
  };
}

// ---- STEP 1: photo(s) -> Gemini -> extracted fields --------------------------
// mode="combine" (default for >1 file): all images are ONE product, different
//   angles -> a single consolidated field set.
// mode="batch": every image is a DIFFERENT product -> one field set per image.
app.post("/api/extract", upload.any(), async (req, res, next) => {
  try {
    const files = (req.files || []).filter((f) => f.fieldname === "image" || f.fieldname === "images");
    if (!files.length) {
      throw new UpstreamError("No image uploaded (field name: 'image' or 'images').", { status: 400 });
    }
    if (files.length > MAX_IMAGES_PER_REQUEST) {
      throw new UpstreamError(
        `Too many images: ${files.length} (max ${MAX_IMAGES_PER_REQUEST}).`,
        { status: 413 }
      );
    }

    const mode = req.body?.mode === "batch" ? "batch" : "combine";
    const images = files.map((f) => ({
      buffer: f.buffer,
      mimeType: f.mimetype,
      filename: f.originalname,
    }));

    if (mode === "batch") {
      // One Gemini call per photo, bounded concurrency.
      const settled = await mapWithConcurrency(images, BATCH_CONCURRENCY, async (img) =>
        finaliseFields(await extractFieldsFromImages([img]))
      );

      const items = settled.map((r, i) => ({
        index: i,
        filename: images[i].filename,
        ...(r.ok
          ? { ok: true, fields: r.value.fields, warnings: r.value.warnings }
          : { ok: false, error: r.error }),
      }));

      return res.json({
        mode,
        count: items.length,
        succeeded: items.filter((i) => i.ok).length,
        items,
      });
    }

    // combine: every image goes into ONE request, so guard the total size
    // against Gemini's per-request ceiling.
    const total = images.reduce((n, i) => n + i.buffer.length, 0);
    if (total > MAX_COMBINED_BYTES) {
      throw new UpstreamError(
        `Combined image size ${(total / 1024 / 1024).toFixed(1)} MB exceeds the ${
          MAX_COMBINED_BYTES / 1024 / 1024
        } MB limit for a single product. Use fewer or smaller photos.`,
        { status: 413 }
      );
    }

    const result = finaliseFields(await extractFieldsFromImages(images));
    res.json({
      mode,
      count: 1,
      succeeded: 1,
      image_count: images.length,
      filenames: images.map((i) => i.filename),
      // Kept flat for backwards compatibility with the single-photo flow.
      fields: result.fields,
      warnings: result.warnings,
      items: [{ index: 0, ok: true, fields: result.fields, warnings: result.warnings }],
    });
  } catch (err) {
    next(err);
  }
});

/** fields (+ optional category) -> one validated listing payload. */
async function buildListing(fields, category) {
  if (!fields || typeof fields !== "object") {
    throw new UpstreamError("Missing 'fields' object.", { status: 400 });
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

  return {
    listing,
    category: cat,
    validation,
    attribute_set: attributeSetFor(cat),
    // Which * fields are still blank — these block submission on Meesho.
    missing_required: missingRequired(listing.attributes, cat),
  };
}

// ---- STEP 2: fields -> DeepSeek -> compliant listing -------------------------
// Single:  { fields, category }            -> flat listing payload
// Batch:   { items: [{ fields, category }] } -> { items: [...] }, one per photo
app.post("/api/generate", async (req, res, next) => {
  try {
    const body = req.body || {};

    if (Array.isArray(body.items)) {
      if (!body.items.length) {
        throw new UpstreamError("'items' array is empty.", { status: 400 });
      }
      if (body.items.length > MAX_IMAGES_PER_REQUEST) {
        throw new UpstreamError(
          `Too many items: ${body.items.length} (max ${MAX_IMAGES_PER_REQUEST}).`,
          { status: 413 }
        );
      }

      const settled = await mapWithConcurrency(body.items, BATCH_CONCURRENCY, (it) =>
        buildListing(it.fields, it.category)
      );

      const items = settled.map((r, i) => ({
        index: i,
        filename: body.items[i]?.filename,
        ...(r.ok ? { ok: true, ...r.value } : { ok: false, error: r.error }),
      }));

      return res.json({
        mode: "batch",
        count: items.length,
        succeeded: items.filter((i) => i.ok).length,
        items,
      });
    }

    res.json(await buildListing(body.fields, body.category));
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
