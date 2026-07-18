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
  file: null,
  rules: null, // from /api/rules
  extracted: null, // Gemini fields
  attributeSet: null, // mandatory/optional for current category
};

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
    if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });
  input.addEventListener("change", () => {
    if (input.files[0]) setFile(input.files[0]);
  });

  $("extractBtn").addEventListener("click", runExtract);
  $("generateBtn").addEventListener("click", runGenerate);
}

function setFile(file) {
  state.file = file;
  const img = $("preview");
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  $("dropText").hidden = true;
  $("extractBtn").disabled = false;
}

// ---- STEP 1: extract ---------------------------------------------------------
async function runExtract() {
  const status = $("extractStatus");
  setStatus(status, "Reading image with Gemini…", "busy");
  $("extractBtn").disabled = true;

  try {
    const fd = new FormData();
    fd.append("image", state.file);
    const res = await fetch(api("/api/extract"), { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Extraction failed");

    state.extracted = data.fields;
    renderExtracted(data.fields, data.warnings || []);
    setStatus(status, "Fields extracted.", "ok");
    $("step-extracted").classList.remove("hidden");
    $("step-extracted").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setStatus(status, err.message, "err");
  } finally {
    $("extractBtn").disabled = false;
  }
}

function renderExtracted(fields, warnings) {
  // Image compliance chips
  const comp = $("imageCompliance");
  comp.innerHTML = "";
  const ic = fields.image_compliance || {};
  const chips = [
    ["Plain white bg", ic.background_is_plain_white],
    ["No watermark/text", !ic.has_watermark_or_text],
    ["No logo", !ic.has_logo],
    ["Solo product", ic.solo_product_no_props],
  ];
  chips.forEach(([label, pass]) => {
    const el = document.createElement("span");
    el.className = "chip " + (pass ? "pass" : "fail");
    el.textContent = (pass ? "✓ " : "✗ ") + label;
    comp.appendChild(el);
  });
  warnings.forEach((w) => {
    const el = document.createElement("span");
    el.className = "chip fail";
    el.textContent = "⚠ " + w;
    comp.appendChild(el);
  });

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
  setStatus(status, "Writing compliant copy with DeepSeek…", "busy");
  $("generateBtn").disabled = true;

  try {
    const category = $("category").value;
    const res = await fetch(api("/api/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: state.extracted, category }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Generation failed");

    state.attributeSet = data.attribute_set;
    renderListing(data.listing, data.attribute_set);
    setStatus(status, "Listing generated. Edit any field — validation updates live.", "ok");
    $("step-listing").classList.remove("hidden");
    $("step-listing").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setStatus(status, err.message, "err");
  } finally {
    $("generateBtn").disabled = false;
  }
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
function wireCopyButtons() {
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("button.copy, #copyAttrs");
    if (!btn) return;

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
