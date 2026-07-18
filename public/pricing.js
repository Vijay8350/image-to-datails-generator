/**
 * Price & profit calculator — self-contained panel.
 *
 * Injects its own <section> into <main> so it stays decoupled from app.js.
 * The formula MIRRORS src/pricing.js exactly (same pattern the validators use):
 * math runs locally for instant feedback as you type; /api/price is the
 * authoritative implementation if you ever want to cross-check.
 *
 * ⚠ Every fee rate here is a PLACEHOLDER. Meesho's commission/shipping/return
 * charges are category-, weight- and zone-dependent. Fill them from your own
 * Supplier Panel rate card before trusting any number on screen.
 */

(function () {
  const INR = (n) =>
    (n < 0 ? "-₹" : "₹") +
    Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const FIELDS = [
    { key: "cogs", label: "Product cost (COGS)", unit: "₹", group: "Your costs" },
    { key: "packaging_cost", label: "Packaging cost", unit: "₹", group: "Your costs" },
    { key: "commission_percent", label: "Meesho commission", unit: "%", group: "Meesho fees" },
    { key: "shipping_charge", label: "Shipping charge", unit: "₹", group: "Meesho fees" },
    { key: "gst_on_fees_percent", label: "GST on Meesho fees", unit: "%", group: "Meesho fees" },
    { key: "product_gst_percent", label: "Product GST", unit: "%", group: "Taxes" },
    { key: "tcs_percent", label: "TCS", unit: "%", group: "Taxes" },
    { key: "tds_percent", label: "TDS (194-O)", unit: "%", group: "Taxes" },
    { key: "return_rate_percent", label: "Expected return/RTO rate", unit: "%", group: "Returns" },
    { key: "rto_cost", label: "Cost per returned order", unit: "₹", group: "Returns" },
  ];

  const DEFAULTS = {
    commission_percent: 0, shipping_charge: 0, gst_on_fees_percent: 18,
    product_gst_percent: 5, tcs_percent: 1, tds_percent: 1,
    return_rate_percent: 0, rto_cost: 0, packaging_cost: 0, cogs: 0,
  };

  const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  const r2 = (n) => Math.round(n * 100) / 100;

  /** MIRROR of computeSettlement() in src/pricing.js — keep in sync. */
  function computeSettlement(input) {
    const r = { ...DEFAULTS, ...input };
    const price = num(r.meesho_price), cogs = num(r.cogs), packaging = num(r.packaging_cost);
    const gstRate = num(r.product_gst_percent) / 100;
    const taxableValue = price / (1 + gstRate);
    const outputGst = price - taxableValue;
    const commission = price * (num(r.commission_percent) / 100);
    const shipping = num(r.shipping_charge);
    const feesSubtotal = commission + shipping;
    const gstOnFees = feesSubtotal * (num(r.gst_on_fees_percent) / 100);
    const tcs = taxableValue * (num(r.tcs_percent) / 100);
    const tds = taxableValue * (num(r.tds_percent) / 100);
    const totalDeductions = feesSubtotal + gstOnFees + tcs + tds;
    const netPayout = price - totalDeductions;
    const profitPerDelivered = netPayout - outputGst - cogs - packaging;
    const returnRate = Math.min(Math.max(num(r.return_rate_percent) / 100, 0), 1);
    const expectedProfit = profitPerDelivered * (1 - returnRate) - num(r.rto_cost) * returnRate;
    return {
      taxable_value: r2(taxableValue), output_gst: r2(outputGst), commission: r2(commission),
      shipping: r2(shipping), gst_on_fees: r2(gstOnFees), tcs: r2(tcs), tds: r2(tds),
      total_deductions: r2(totalDeductions), net_payout: r2(netPayout),
      profit_per_delivered: r2(profitPerDelivered), expected_profit: r2(expectedProfit),
      margin_percent: price > 0 ? r2((expectedProfit / price) * 100) : 0,
      profitable: expectedProfit > 0,
    };
  }

  /** MIRROR of requiredPriceForMargin() — bisection, same as server. */
  function requiredPriceForMargin(target, input) {
    const marginAt = (p) => computeSettlement({ ...input, meesho_price: p }).margin_percent;
    let lo = 0.01, hi = 100000;
    if (marginAt(hi) < target) return null;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (marginAt(mid) < target) lo = mid; else hi = mid; }
    return r2(hi);
  }

  // ---- Build the panel -------------------------------------------------------
  const section = document.createElement("section");
  section.className = "card";
  section.id = "step-pricing";

  const groups = [...new Set(FIELDS.map((f) => f.group))];
  const inputsHtml = groups.map((g) => `
      <div class="price-group">
        <h4>${g}</h4>
        ${FIELDS.filter((f) => f.group === g).map((f) => `
          <label class="price-row">
            <span>${f.label}</span>
            <span class="price-input"><i>${f.unit}</i>
              <input type="number" step="0.01" min="0" data-price="${f.key}" value="${DEFAULTS[f.key] ?? 0}" />
            </span>
          </label>`).join("")}
      </div>`).join("");

  section.innerHTML = `
    <h2><span class="step-num">₹</span> Price &amp; profit calculator</h2>
    <p class="price-warn">
      ⚠ All fee rates below are <strong>placeholders</strong>. Meesho's commission, shipping and
      return charges vary by category, weight and zone. Fill these from your
      <strong>Supplier Panel → Payments → Rate Card</strong> before trusting the result.
    </p>

    <div class="price-mode">
      <label><input type="radio" name="priceMode" value="settlement" checked /> I know my price → show profit</label>
      <label><input type="radio" name="priceMode" value="target-margin" /> I want a margin → show price</label>
    </div>

    <div class="row price-primary">
      <label class="field" id="priceInputWrap">
        <span>Meesho Price (incl. GST)</span>
        <input type="number" step="0.01" min="0" id="meeshoPrice" value="499" />
      </label>
      <label class="field hidden" id="marginInputWrap">
        <span>Target margin %</span>
        <input type="number" step="0.1" id="targetMargin" value="20" />
      </label>
      <label class="field">
        <span>MRP (must be ≥ price)</span>
        <input type="number" step="0.01" min="0" id="mrpField" value="999" />
      </label>
    </div>

    <div class="price-grid">${inputsHtml}</div>

    <div id="priceResult" class="price-result"></div>
    <ul class="issues" id="priceIssues"></ul>
    <button class="copy" id="copyPricing">Copy breakdown</button>
  `;

  // Insert after the upload card so it reads as its own tool, not a pipeline step.
  const main = document.querySelector("main");
  if (main) main.appendChild(section);

  // ---- Wire up ---------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const readInputs = () => {
    const o = {};
    section.querySelectorAll("input[data-price]").forEach((i) => (o[i.dataset.price] = num(i.value)));
    return o;
  };
  const mode = () => section.querySelector('input[name="priceMode"]:checked').value;

  function render() {
    const input = readInputs();
    const isTarget = mode() === "target-margin";
    $("priceInputWrap").classList.toggle("hidden", isTarget);
    $("marginInputWrap").classList.toggle("hidden", !isTarget);

    let price, unreachable = false;
    if (isTarget) {
      const solved = requiredPriceForMargin(num($("targetMargin").value), input);
      if (solved === null) unreachable = true; else price = solved;
    } else {
      price = num($("meeshoPrice").value);
    }

    const box = $("priceResult");
    if (unreachable) {
      box.innerHTML = `<div class="price-bad">That margin is unreachable with these costs and fees. Lower the target, or cut COGS/returns.</div>`;
      $("priceIssues").innerHTML = "";
      return;
    }

    const c = computeSettlement({ ...input, meesho_price: price });
    const line = (k, v, cls = "") => `<div class="pl ${cls}"><span>${k}</span><b>${v}</b></div>`;

    box.innerHTML = `
      ${isTarget ? `<div class="price-headline">Required Meesho Price: <b>${INR(price)}</b></div>` : ""}
      <div class="price-cols">
        <div>
          ${line("Selling price", INR(price))}
          ${line("Taxable value", INR(c.taxable_value))}
          ${line("Output GST (remitted)", "-" + INR(c.output_gst), "neg")}
          ${line("Commission", "-" + INR(c.commission), "neg")}
          ${line("Shipping", "-" + INR(c.shipping), "neg")}
          ${line("GST on fees", "-" + INR(c.gst_on_fees), "neg")}
          ${line("TCS", "-" + INR(c.tcs), "neg")}
          ${line("TDS", "-" + INR(c.tds), "neg")}
        </div>
        <div>
          ${line("Meesho deductions", "-" + INR(c.total_deductions), "neg")}
          ${line("Net payout to you", INR(c.net_payout), "strong")}
          ${line("Product cost", "-" + INR(num(input.cogs)), "neg")}
          ${line("Packaging", "-" + INR(num(input.packaging_cost)), "neg")}
          ${line("Profit / delivered order", INR(c.profit_per_delivered))}
          ${line("Expected profit (after returns)", INR(c.expected_profit), c.profitable ? "good strong" : "bad strong")}
          ${line("Margin", c.margin_percent.toFixed(2) + "%", c.profitable ? "good" : "bad")}
        </div>
      </div>`;

    // MRP >= price rule (mirrors validatePricing in src/pricing.js)
    const mrp = num($("mrpField").value);
    const issues = [];
    if (mrp > 0 && price > 0 && mrp < price) issues.push(`MRP (${INR(mrp)}) must be ≥ Meesho Price (${INR(price)}).`);
    if (!c.profitable) issues.push("This order loses money at the current price and return rate.");
    if (num(input.return_rate_percent) === 0) issues.push("Return rate is 0% — that is optimistic. Set a realistic rate; returns are the biggest margin killer on Meesho.");
    $("priceIssues").innerHTML = issues.map((m, i) => `<li class="${i === 0 && mrp > 0 && mrp < price ? "error" : "warn"}">${m}</li>`).join("");

    section._last = { price, mrp, ...c, inputs: input };
  }

  section.addEventListener("input", render);
  section.addEventListener("change", render);

  $("copyPricing").addEventListener("click", async (e) => {
    e.preventDefault();
    const d = section._last || {};
    const txt = [
      `Meesho Price: ${INR(d.price || 0)}`,
      `MRP: ${INR(d.mrp || 0)}`,
      `Net payout: ${INR(d.net_payout || 0)}`,
      `Expected profit: ${INR(d.expected_profit || 0)}`,
      `Margin: ${(d.margin_percent || 0).toFixed(2)}%`,
      ``,
      `NOTE: fee rates are user-entered estimates — reconcile with your Meesho settlement report.`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(txt);
      const b = $("copyPricing"); const o = b.textContent;
      b.textContent = "Copied ✓"; setTimeout(() => (b.textContent = o), 1200);
    } catch { /* clipboard blocked */ }
  });

  render();
})();
