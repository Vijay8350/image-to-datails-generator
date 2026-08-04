/* Frontend logic. Talks ONLY to our own backend (never Gemini/DeepSeek directly). */

const $ = (id) => document.getElementById(id);

/**
 * Base-path aware API helper.
 *
 * The app may be served at the domain root (http://localhost:3000/) OR under a
 * sub-path behind an nginx proxy (https://host/meesho/). Absolute "/api/..."
 * URLs would escape the sub-path and hit a different app, so resolve every API
 * call against the directory of the current page instead.
 */
const API_BASE = location.pathname.replace(/\/[^/]*$/, "/");
const api = (path) => API_BASE + String(path).replace(/^\//, "");

const state = {
  files: [], // one or many selected photos
  rules: null, // from /api/rules
  extracted: null, // Gemini fields (combine / single mode)
  batchItems: null, // per-photo extracted fields (batch mode)
  mode: "combine", // "combine" | "batch"
  attributeSet: null, // mandatory/optional for current category
};

// Fallback if /api/rules hasn't loaded yet; the server is the source of truth.
const IMAGE_DEFAULTS = { max_dim: 1280, quality: 0.85 };

const photoMode = () =>
  document.querySelector('input[name="photoMode"]:checked')?.value || "combine";

// ---- Boot: load rules + health ----------------------------------------------
init().catch((e) => console.error(e));

async function init() {
  const [rules, health] = await Promise.all([
    fetch(api("/api/rules")).then((r) => r.json()),
    fetch(api("/api/health")).then((r) => r.json()).catch(() => null),
  ]);
  state.rules = rules;

  // Category dropdown
  const sel = $("category");
  rules.categories.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c.charAt(0).toUpperCase() + c.slice(1);
    sel.appendChild(opt);
  });

  // Health badge
  const badge = $("health");
  if (health) {
    const ok = health.gemini_key && health.deepseek_key;
    badge.textContent = ok ? "● keys ready" : "● keys missing";
    badge.style.color = ok ? "#c8f7dd" : "#ffd7d1";
  }

  wireUpload();
  wireCopyButtons();
}

// ---- Upload + preview --------------------------------------------------------
function wireUpload() {
  const dz = $("dropzone");
  const input = $("fileInput");

  dz.addEventListener("click", () => input.click());
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  input.addEventListener("change", () => {
    if (input.files.length) addFiles(input.files);
    input.value = ""; // allow re-picking the same file
  });

  $("extractBtn").addEventListener("click", runExtract);
  $("generateBtn").addEventListener("click", runGenerate);
}

/** Append to the selection (dropping twice adds, it does not replace). */
function addFiles(fileList) {
  const incoming = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
  for (const f of incoming) {
    const dup = state.files.some((x) => x.name === f.name && x.size === f.size);
    if (!dup) state.files.push(f);
  }
  renderThumbs();
}

function removeFile(idx) {
  state.files.splice(idx, 1);
  renderThumbs();
}

function renderThumbs() {
  const host = $("thumbs");
  host.innerHTML = "";
  state.files.forEach((f, i) => {
    const el = document.createElement("div");
    el.className = "thumb";
    el.innerHTML = `
      <img src="${URL.createObjectURL(f)}" alt="${escapeAttr(f.name)}" />
      <button class="thumb-x" data-i="${i}" title="Remove">×</button>
      <span class="thumb-name">${escapeHtml(f.name)}</span>`;
    host.appendChild(el);
  });
  host.querySelectorAll(".thumb-x").forEach((b) =>
    b.addEventListener("click", () => removeFile(Number(b.dataset.i)))
  );

  const n = state.files.length;
  $("dropText").hidden = n > 0;
  $("modeBox").classList.toggle("hidden", n < 2);
  $("extractBtn").disabled = n === 0;
  $("extractBtn").textContent =
    n <= 1
      ? "Extract fields from photo"
      : photoMode() === "batch"
      ? `Extract ${n} products`
      : `Extract from ${n} photos (1 product)`;
}

// ---- Image downscaling -------------------------------------------------------
/**
 * Shrink a photo in the browser before uploading it.
 *
 * Gemini charges a flat prompt-token cost per inline image no matter its
 * resolution, so a 12 MP phone photo costs exactly as much as a 1280px one but
 * takes many times longer to upload — which is most of the "generating takes
 * forever" wait, especially on a phone connection with several photos queued.
 *
 * Returns the ORIGINAL file untouched if anything goes wrong (e.g. HEIC, which
 * most browsers cannot decode to a canvas) — the server still accepts it.
 */
async function downscaleImage(file, maxDim, quality) {
  try {
    if (!("createImageBitmap" in window)) return file;

    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = bitmap;
    const scale = Math.min(1, maxDim / Math.max(width, height));

    // Already small enough and already a compact format — leave it alone.
    if (scale === 1 && file.type === "image/jpeg") {
      bitmap.close?.();
      return file;
    }

    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    // PNGs with transparency would flatten to black on a JPEG, and Meesho wants
    // a plain white background anyway.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    if (!blob || blob.size >= file.size) return file; // no win — keep the original

    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file; // undecodable (HEIC etc.) — let the server deal with it
  }
}

/** Ticking "N s" suffix so a long call never looks like a hang. */
function startElapsed(el, prefix) {
  const t0 = Date.now();
  const tick = () => {
    el.textContent = `${prefix} ${Math.round((Date.now() - t0) / 1000)}s`;
  };
  tick();
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}

// ---- STEP 1: extract ---------------------------------------------------------
async function runExtract() {
  const status = $("extractStatus");
  const n = state.files.length;
  state.mode = n > 1 ? photoMode() : "combine";

  $("extractBtn").disabled = true;
  let stopTimer = () => {};

  try {
    const img = state.rules?.image_processing || IMAGE_DEFAULTS;
    setStatus(status, `Preparing ${n} photo${n > 1 ? "s" : ""}…`, "busy");

    const before = state.files.reduce((sum, f) => sum + f.size, 0);
    const upload = await Promise.all(
      state.files.map((f) => downscaleImage(f, img.max_dim, img.quality))
    );
    const after = upload.reduce((sum, f) => sum + f.size, 0);
    const saved = before > 0 ? Math.round((1 - after / before) * 100) : 0;

    const label =
      state.mode === "batch"
        ? `Reading ${n} photos with Gemini (one product each)…`
        : n > 1
        ? `Reading ${n} photos with Gemini (same product)…`
        : "Reading image with Gemini…";
    setStatus(status, label, "busy");
    stopTimer = startElapsed(
      status,
      label + (saved > 5 ? ` (upload shrunk ${saved}%)` : "")
    );

    const fd = new FormData();
    upload.forEach((f) => fd.append("images", f));
    fd.append("mode", state.mode);

    const res = await fetch(api("/api/extract"), { method: "POST", body: fd });
    const data = await res.json();
    stopTimer();
    if (!res.ok) throw new Error(data.error || "Extraction failed");

    if (data.mode === "batch") {
      state.batchItems = data.items;
      state.extracted = null;
      const failed = data.count - data.succeeded;
      renderBatchExtracted(data);
      setStatus(
        status,
        `Extracted ${data.succeeded}/${data.count} photos.` + (failed ? ` ${failed} failed.` : ""),
        failed ? "warn" : "ok"
      );
    } else {
      state.batchItems = null;
      state.extracted = data.fields;
      renderExtracted(data.fields, data.warnings || [], data.image_count || 1);
      setStatus(
        status,
        data.image_count > 1
          ? `Fields extracted from ${data.image_count} photos.`
          : "Fields extracted.",
        "ok"
      );
    }

    $("step-extracted").classList.remove("hidden");
    $("step-extracted").scrollIntoView({ behavior: "smooth", block: "start" });

    // Chain straight into the write step. Waiting for a second click adds the
    // user's own reaction time to every listing for no benefit — the category
    // is auto-detected, and the Generate button stays live to rewrite the copy
    // if they correct it afterwards.
    if ($("autoRun")?.checked) {
      const anyExtracted =
        data.mode === "batch" ? data.items.some((i) => i.ok) : Boolean(data.fields);
      if (anyExtracted) await runGenerate();
    }
  } catch (err) {
    stopTimer();
    setStatus(status, err.message, "err");
  } finally {
    $("extractBtn").disabled = false;
  }
}

/** Batch mode: summarise each photo's detected product before generating. */
function renderBatchExtracted(data) {
  $("imageCompliance").innerHTML = "";
  $("rawExtract").style.display = "none";

  const rows = data.items
    .map((it) => {
      if (!it.ok) {
        return `<li class="batch-row bad"><strong>${escapeHtml(it.filename || "photo " + (it.index + 1))}</strong> — failed: ${escapeHtml(it.error)}</li>`;
      }
      const f = it.fields;
      const set = state.rules.attribute_sets[f.suggested_category] || state.rules.attribute_sets.generic;
      return `<li class="batch-row"><strong>${escapeHtml(f.product_type || "product")}</strong>
        <span class="cat-pill">${escapeHtml(f.suggested_category)}</span>
        <small>${escapeHtml(it.filename || "")} · ${set.fields.length} fields</small></li>`;
    })
    .join("");

  $("detectedLine").innerHTML =
    `<strong>${data.succeeded}</strong> of <strong>${data.count}</strong> photos read as separate products:
     <ul class="batch-list">${rows}</ul>`;
  $("generateBtn").textContent = `Generate ${data.succeeded} Meesho listings`;
}

function renderExtracted(fields, warnings, imageCount = 1) {
  $("rawExtract").style.display = "";
  $("generateBtn").textContent = "Generate Meesho listing fields";

  // Image compliance chips
  const comp = $("imageCompliance");
  comp.innerHTML = "";

  const chipRow = (ic, label) => {
    const wrap = document.createElement("div");
    wrap.className = "chip-row";
    if (label) wrap.innerHTML = `<span class="chip-label">${escapeHtml(label)}</span>`;
    [
      ["Plain white bg", ic.background_is_plain_white],
      ["No watermark/text", !ic.has_watermark_or_text],
      ["No logo", !ic.has_logo],
      ["Solo product", ic.solo_product_no_props],
    ].forEach(([t, pass]) => {
      const el = document.createElement("span");
      el.className = "chip " + (pass ? "pass" : "fail");
      el.textContent = (pass ? "✓ " : "✗ ") + t;
      wrap.appendChild(el);
    });
    return wrap;
  };

  // With several photos, show QC per image — Meesho checks each uploaded shot.
  const per = fields.per_image_compliance;
  if (imageCount > 1 && Array.isArray(per) && per.length) {
    per.forEach((p, i) =>
      comp.appendChild(chipRow(p, `Image ${p.image_index || i + 1}${p.shot_type ? ` · ${p.shot_type}` : ""}`))
    );
  } else {
    comp.appendChild(chipRow(fields.image_compliance || {}, imageCount > 1 ? "Primary image" : ""));
  }
  if (warnings.length) {
    const wrap = document.createElement("div");
    wrap.className = "chip-row";
    warnings.forEach((w) => {
      const el = document.createElement("span");
      el.className = "chip fail";
      el.textContent = "⚠ " + w;
      wrap.appendChild(el);
    });
    comp.appendChild(wrap);
  }

  // Key/value grid of extracted fields
  const grid = $("extractedFields");
  grid.innerHTML = "";
  const show = {
    "Product type": fields.product_type,
    "Suggested category": fields.suggested_category,
    "Primary color": fields.primary_color,
    "Secondary colors": (fields.secondary_colors || []).join(", "),
    Material: fields.material,
    Pattern: fields.pattern,
    Style: fields.style,
    Gender: fields.target_gender,
    "Age group": fields.age_group,
    Occasion: fields.occasion,
    "Key features": (fields.key_features || []).join(", "),
    "Visible text": fields.visible_text,
  };
  for (const [k, v] of Object.entries(show)) {
    const cell = document.createElement("div");
    cell.className = "kv";
    const empty = !v || !String(v).trim();
    cell.innerHTML = `<div class="k">${k}</div><div class="v ${empty ? "empty" : ""}">${
      empty ? "—" : escapeHtml(String(v))
    }</div>`;
    grid.appendChild(cell);
  }

  // Auto-select the detected category and say so plainly, so it is obvious
  // which Meesho field set is about to be generated.
  const cat = fields.suggested_category;
  if (state.rules.categories.includes(cat)) $("category").value = cat;
  const set = state.rules.attribute_sets[cat] || state.rules.attribute_sets.generic;
  $("detectedLine").innerHTML =
    `Detected <strong>${escapeHtml(fields.product_type || "product")}</strong> → category ` +
    `<strong>${escapeHtml(cat)}</strong> · will generate <strong>${set.fields.length}</strong> Meesho fields ` +
    `(<strong>${set.mandatory.length}</strong> required). Change the category above if this is wrong.`;
}

// ---- STEP 2: generate --------------------------------------------------------
async function runGenerate() {
  const status = $("generateStatus");
  $("generateBtn").disabled = true;
  let stopTimer = () => {};

  try {
    if (state.mode === "batch" && state.batchItems) {
      const good = state.batchItems.filter((i) => i.ok);
      if (!good.length) throw new Error("No photos were extracted successfully — nothing to generate.");
      stopTimer = startElapsed(status, `Writing ${good.length} listings with DeepSeek…`);

      const res = await fetch(api("/api/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: good.map((i) => ({
            fields: i.fields,
            category: i.fields.suggested_category,
            filename: i.filename,
          })),
        }),
      });
      const data = await res.json();
      stopTimer();
      if (!res.ok) throw new Error(data.error || "Generation failed");

      renderBatchListings(data);
      const failed = data.count - data.succeeded;
      // Surface WHY items failed instead of only a count — a shared upstream
      // cause (rate limit, truncation) is otherwise invisible from the summary.
      const reasons = [
        ...new Set(data.items.filter((i) => !i.ok).map((i) => i.error).filter(Boolean)),
      ];
      setStatus(
        status,
        `Generated ${data.succeeded}/${data.count} listings.` +
          (failed ? ` ${failed} failed: ${reasons.join(" | ")}` : ""),
        failed ? "warn" : "ok"
      );
      $("step-batch").classList.remove("hidden");
      $("step-listing").classList.add("hidden");
      $("step-batch").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    stopTimer = startElapsed(status, "Writing compliant copy with DeepSeek…");
    const category = $("category").value;
    const res = await fetch(api("/api/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: state.extracted, category }),
    });
    const data = await res.json();
    stopTimer();
    if (!res.ok) throw new Error(data.error || "Generation failed");

    state.attributeSet = data.attribute_set;
    renderListing(data.listing, data.attribute_set);
    setStatus(status, "Listing generated. Edit any field — validation updates live.", "ok");
    $("step-batch").classList.add("hidden");
    $("step-listing").classList.remove("hidden");
    $("step-listing").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    stopTimer();
    setStatus(status, err.message, "err");
  } finally {
    $("generateBtn").disabled = false;
  }
}

/** Batch mode: one collapsible card per generated listing. */
function renderBatchListings(data) {
  state.batchListings = data.items;
  $("batchSummary").textContent = `${data.succeeded} of ${data.count} generated`;

  const host = $("batchResults");
  host.innerHTML = "";

  data.items.forEach((it) => {
    const card = document.createElement("details");
    card.className = "batch-item";
    if (!it.ok) {
      card.innerHTML = `<summary class="bad">${escapeHtml(it.filename || "photo " + (it.index + 1))} — failed: ${escapeHtml(it.error)}</summary>`;
      host.appendChild(card);
      return;
    }

    const L = it.listing;
    const missing = it.missing_required.length;
    const issues = Object.values(it.validation).flat().filter((v) => v.level === "error").length;
    const filled = it.attribute_set.fields.filter((f) => String(L.attributes[f.key] ?? "").trim());

    card.innerHTML = `
      <summary>
        <span class="bi-title">${escapeHtml(L.title)}</span>
        <span class="cat-pill">${escapeHtml(it.category)}</span>
        <span class="bi-meta">${L.title.length}/100 · ${filled.length} filled · ${missing} required empty${
          issues ? ` · <span class="bad">${issues} issue(s)</span>` : ""
        }</span>
      </summary>
      <div class="bi-body">
        <div class="bi-row"><label>Product Name</label>
          <input class="editable" value="${escapeAttr(L.title)}" data-bi="title" data-idx="${it.index}" /></div>
        <div class="bi-row"><label>Description</label>
          <textarea class="editable" rows="7" data-bi="description" data-idx="${it.index}">${escapeHtml(L.description)}</textarea></div>
        <div class="bi-row"><label>Keywords (${L.keywords.length})</label>
          <textarea class="editable" rows="3" data-bi="keywords" data-idx="${it.index}">${escapeHtml(L.keywords.join(", "))}</textarea></div>
        <div class="bi-row"><label>Filled Meesho fields</label>
          <div class="bi-attrs">${filled
            .map((f) => `<span class="bi-attr"><b>${escapeHtml(f.label)}</b>: ${escapeHtml(String(L.attributes[f.key]))}</span>`)
            .join("")}</div></div>
        <div class="missing-summary warn">${missing} required field${missing === 1 ? "" : "s"} you must fill: ${escapeHtml(
          it.missing_required.map((m) => m.label).join(", ")
        )}</div>
        <button class="copy bi-copy" data-idx="${it.index}">Copy this listing as JSON</button>
      </div>`;
    host.appendChild(card);
  });

  // Per-listing copy
  host.querySelectorAll(".bi-copy").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const it = data.items.find((x) => x.index === Number(btn.dataset.idx));
      await copyText(JSON.stringify(listingPayload(it), null, 2), btn);
    })
  );
}

function listingPayload(it) {
  return {
    filename: it.filename,
    category: it.category,
    product_name: it.listing.title,
    description: it.listing.description,
    keywords: it.listing.keywords,
    attributes: it.listing.attributes,
    required_still_empty: it.missing_required.map((m) => m.label),
  };
}

function renderListing(listing, attrSet) {
  $("titleField").value = listing.title || "";
  $("descField").value = listing.description || "";
  $("keywordsField").value = (listing.keywords || []).join(", ");

  // Live validation on edit
  ["titleField", "descField", "keywordsField"].forEach((id) => {
    const el = $(id);
    el.oninput = revalidate;
  });
  revalidate();

  renderAttributes(listing.attributes || {}, attrSet);
  renderImageRequirements();
}

/** Meesho requires three specific shots + three image content rules. */
function renderImageRequirements() {
  const host = $("imageReqs");
  if (!host || !state.rules.image_requirements) return;
  const { required, guidelines } = state.rules.image_requirements;
  host.innerHTML = `
    <div class="req-shots">
      ${required
        .map((r) => `<div class="shot"><strong>${escapeHtml(r.label)}</strong><span>${escapeHtml(r.note)}</span></div>`)
        .join("")}
    </div>
    <ul class="req-rules">
      ${guidelines.map((g) => `<li>${escapeHtml(g)}</li>`).join("")}
    </ul>`;
}

function renderAttributes(values, attrSet) {
  const host = $("attributes");
  host.innerHTML = "";
  const fields = attrSet.fields || [];

  // Render in the same three sections Meesho's Edit Product form uses.
  attrSet.groups.forEach((group) => {
    const inGroup = fields.filter((f) => f.group === group.id);
    if (!inGroup.length) return;

    const section = document.createElement("div");
    section.className = "attr-section";
    section.innerHTML = `<h3 class="attr-group">${escapeHtml(group.label)}</h3>`;
    const grid = document.createElement("div");
    grid.className = "attr-grid";

    inGroup.forEach((f) => {
      const val = values[f.key] ?? "";
      const missing = f.required && !String(val).trim();
      const wrap = document.createElement("div");
      wrap.className = "attr" + (f.source === "seller" ? " seller" : "");
      wrap.innerHTML = `
        <label class="k">
          ${escapeHtml(f.label)}${f.required ? ' <span class="req">*</span>' : ""}
          ${f.source === "seller" ? '<span class="tag">you fill</span>' : '<span class="tag ai">AI</span>'}
        </label>
        <input data-attr="${f.key}" value="${escapeAttr(String(val))}"
               placeholder="${escapeAttr(f.hint || "")}" class="${missing ? "missing" : ""}" />`;
      grid.appendChild(wrap);
    });

    section.appendChild(grid);
    host.appendChild(section);
  });

  // Live "still required" counter as the seller fills fields in.
  const updateMissing = () => {
    const blank = fields.filter(
      (f) => f.required && !String(host.querySelector(`[data-attr="${f.key}"]`)?.value || "").trim()
    );
    const el = $("missingSummary");
    el.textContent = blank.length
      ? `${blank.length} required field${blank.length > 1 ? "s" : ""} still empty: ${blank.map((f) => f.label).join(", ")}`
      : "All required fields filled — ready to submit on Meesho.";
    el.className = "missing-summary " + (blank.length ? "warn" : "ok");
  };

  host.querySelectorAll("input[data-attr]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const f = fields.find((x) => x.key === inp.dataset.attr);
      inp.classList.toggle("missing", f?.required && !inp.value.trim());
      updateMissing();
    });
  });
  updateMissing();
}

// ---- Client-side validators (mirror src/meesho.js validateListing) -----------
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const CONTACT_RE =
  /(\b\d{10}\b|\+\d{6,}|@[a-z0-9._-]+|https?:\/\/|www\.|\b[\w.+-]+@[\w-]+\.[\w.-]+\b)/i;

function countAllCapsWords(text) {
  return String(text)
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => {
      const letters = w.replace(/[^A-Za-z]/g, "");
      return letters.length >= 2 && letters === letters.toUpperCase();
    });
}

function revalidate() {
  const limits = state.rules.limits;
  const title = $("titleField").value;
  const desc = $("descField").value;
  const keywords = $("keywordsField").value.split(",").map((s) => s.trim()).filter(Boolean);

  // Counters
  setCounter("titleCounter", title.length, limits.TITLE_MAX);
  setCounter("descCounter", desc.length, limits.DESC_MAX);
  $("keywordsCounter").textContent = `${keywords.length} keywords`;
  $("keywordsCounter").className = "counter";

  // Issues
  const titleIssues = [];
  if (!title.trim()) titleIssues.push(err("Title is empty."));
  else {
    if (title.length > limits.TITLE_MAX)
      titleIssues.push(err(`Over limit: ${title.length}/${limits.TITLE_MAX}.`));
    if (EMOJI_RE.test(title)) titleIssues.push(err("Contains emoji/symbols."));
    if (CONTACT_RE.test(title)) titleIssues.push(err("Looks like it contains contact info."));
    const caps = countAllCapsWords(title);
    if (caps.length) titleIssues.push(warn(`ALL-CAPS word(s): ${caps.slice(0, 3).join(", ")}.`));
    // keyword-in-first-5-words heuristic
    if (title.trim().split(/\s+/).length < 3)
      titleIssues.push(warn("Very short — ensure the main keyword leads."));
  }

  const descIssues = [];
  if (!desc.trim()) descIssues.push(err("Description is empty."));
  else {
    if (desc.length > limits.DESC_MAX)
      descIssues.push(err(`Over limit: ${desc.length}/${limits.DESC_MAX}.`));
    if (EMOJI_RE.test(desc)) descIssues.push(err("Contains emoji/symbols."));
    if (CONTACT_RE.test(desc)) descIssues.push(err("Looks like it contains contact info."));
    if (!/[•\-\n]/.test(desc)) descIssues.push(warn("No bullet points — add spec bullets."));
    const caps = countAllCapsWords(desc);
    if (caps.length > 2) descIssues.push(warn(`Several ALL-CAPS words (${caps.length}).`));
  }

  const kwIssues = [];
  if (!keywords.length) kwIssues.push(warn("No keywords."));

  renderIssues("titleIssues", titleIssues);
  renderIssues("descIssues", descIssues);
  renderIssues("keywordsIssues", kwIssues);
}

const err = (message) => ({ level: "error", message });
const warn = (message) => ({ level: "warn", message });

function renderIssues(id, issues) {
  const ul = $(id);
  ul.innerHTML = "";
  issues.forEach((i) => {
    const li = document.createElement("li");
    li.className = i.level;
    li.textContent = i.message;
    ul.appendChild(li);
  });
}

function setCounter(id, len, max) {
  const el = $(id);
  el.textContent = `${len} / ${max}`;
  el.classList.toggle("over", len > max);
}

// ---- Copy buttons ------------------------------------------------------------
/** Shared clipboard write with button feedback. */
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = "Copied ✓";
    btn.classList.add("done");
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove("done");
    }, 1200);
  } catch {
    /* clipboard blocked — no-op */
  }
}

function wireCopyButtons() {
  // Copy every generated listing in the batch as one JSON array.
  $("copyAllBatch")?.addEventListener("click", async (e) => {
    if (!state.batchListings) return;
    const payload = state.batchListings.filter((i) => i.ok).map(listingPayload);
    await copyText(JSON.stringify(payload, null, 2), e.currentTarget);
  });

  // Re-label the extract button when the user flips the mode.
  document.querySelectorAll('input[name="photoMode"]').forEach((r) =>
    r.addEventListener("change", renderThumbs)
  );

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("button.copy, #copyAttrs");
    if (!btn || btn.id === "copyAllBatch" || btn.classList.contains("bi-copy")) return;

    let text = "";
    if (btn.id === "copyAttrs") {
      const obj = {};
      document.querySelectorAll("#attributes input[data-attr]").forEach((inp) => {
        if (inp.value.trim()) obj[inp.dataset.attr] = inp.value.trim();
      });
      text = JSON.stringify(obj, null, 2);
    } else {
      text = $(btn.dataset.copy).value;
    }

    try {
      await navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = "Copied ✓";
      btn.classList.add("done");
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove("done");
      }, 1200);
    } catch {
      /* clipboard blocked — no-op */
    }
  });
}

// ---- utils -------------------------------------------------------------------
function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = "status " + (kind || "");
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return s.replace(/"/g, "&quot;");
}
