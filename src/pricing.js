/**
 * Meesho price & profit calculator — pure arithmetic, no API keys involved.
 *
 * ⚠ EVERY RATE BELOW IS A PLACEHOLDER. Meesho's commission, shipping slabs and
 * return charges are category-, weight- and zone-dependent and change over time.
 * Meesho does NOT publish a single authoritative rate card, so nothing here is
 * "verified" the way a documented limit would be. Pull your real numbers from:
 *   Meesho Supplier Panel → Payments → Rate Card / Settlement report
 * and overwrite these defaults (they are all editable in the UI too).
 *
 * Treat the output as a MODEL, not a guarantee. Always reconcile against an
 * actual settlement report before pricing a whole catalog off it.
 *
 * Same pattern as meesho.js: pure + dependency-free so app.js can mirror the
 * exact formula client-side for live recalculation as the user types.
 */

// ---- Rate defaults (ALL must be verified against your own rate card) ---------
export const PRICING_DEFAULTS = {
  // Meesho markets "0% commission" for many categories, but it is not universal
  // and does not cover shipping. VERIFY for your category.
  commission_percent: 0,

  // Flat per-order shipping deducted by Meesho. Weight/zone dependent. VERIFY.
  shipping_charge: 0,

  // GST charged by Meesho ON ITS OWN FEES (commission + shipping). Standard
  // service GST rate in India is 18%.
  gst_on_fees_percent: 18,

  // Output GST on the product itself. Apparel is commonly 5% below a price
  // threshold and 12% above it — category dependent. VERIFY (matches the
  // gst_percent catalog attribute).
  product_gst_percent: 5,

  // TCS collected by the marketplace under GST law.
  tcs_percent: 1,

  // TDS under section 194-O.
  tds_percent: 1,

  // Share of orders that come back (RTO / customer return). This is usually the
  // single biggest margin killer on Meesho — do not leave it at 0.
  return_rate_percent: 0,

  // Cost you eat per returned order (forward + reverse logistics, damage).
  rto_cost: 0,

  // Your own per-order costs.
  packaging_cost: 0,
};

/** Field metadata so the UI can render inputs without duplicating labels. */
export const PRICING_FIELDS = [
  { key: "cogs", label: "Product cost (COGS)", unit: "₹", cost: true },
  { key: "packaging_cost", label: "Packaging cost", unit: "₹", cost: true },
  { key: "commission_percent", label: "Meesho commission", unit: "%" },
  { key: "shipping_charge", label: "Shipping charge", unit: "₹" },
  { key: "product_gst_percent", label: "Product GST", unit: "%" },
  { key: "gst_on_fees_percent", label: "GST on Meesho fees", unit: "%" },
  { key: "tcs_percent", label: "TCS", unit: "%" },
  { key: "tds_percent", label: "TDS (194-O)", unit: "%" },
  { key: "return_rate_percent", label: "Expected return/RTO rate", unit: "%" },
  { key: "rto_cost", label: "Cost per returned order", unit: "₹" },
];

const num = (v, dflt = 0) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
};
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Forward calculation: selling price -> settlement -> profit.
 *
 * GST treatment: `meesho_price` is taken as the customer-facing, GST-INCLUSIVE
 * price (that is what you enter in the Meesho panel). Output GST is a
 * pass-through — you collect it and remit it — so it is excluded from profit
 * rather than counted as revenue.
 *
 * @param {object} input
 * @param {number} input.meesho_price  Customer-facing price (GST inclusive).
 * @param {number} input.cogs          Your product cost.
 * @returns {object} Full breakdown.
 */
export function computeSettlement(input = {}) {
  const r = { ...PRICING_DEFAULTS, ...input };

  const price = num(r.meesho_price);
  const cogs = num(r.cogs);
  const packaging = num(r.packaging_cost);

  // --- Split the GST-inclusive price into taxable value + output GST ---------
  const gstRate = num(r.product_gst_percent) / 100;
  const taxableValue = gstRate > -1 ? price / (1 + gstRate) : price;
  const outputGst = price - taxableValue;

  // --- Meesho's fees --------------------------------------------------------
  const commission = price * (num(r.commission_percent) / 100);
  const shipping = num(r.shipping_charge);
  const feesSubtotal = commission + shipping;
  const gstOnFees = feesSubtotal * (num(r.gst_on_fees_percent) / 100);

  // --- Statutory deductions (levied on taxable value) -----------------------
  const tcs = taxableValue * (num(r.tcs_percent) / 100);
  const tds = taxableValue * (num(r.tds_percent) / 100);

  const totalDeductions = feesSubtotal + gstOnFees + tcs + tds;

  // Cash Meesho actually settles to your bank.
  const netPayout = price - totalDeductions;

  // --- Profit on a DELIVERED order ------------------------------------------
  // Subtract the output GST because it is remitted to the government, not kept.
  const profitPerDelivered = netPayout - outputGst - cogs - packaging;

  // --- Profit adjusted for returns ------------------------------------------
  // A returned order earns nothing and additionally costs you rto_cost.
  const returnRate = Math.min(Math.max(num(r.return_rate_percent) / 100, 0), 1);
  const expectedProfit =
    profitPerDelivered * (1 - returnRate) - num(r.rto_cost) * returnRate;

  const margin = price > 0 ? (expectedProfit / price) * 100 : 0;
  const marginDelivered = price > 0 ? (profitPerDelivered / price) * 100 : 0;

  return {
    meesho_price: round2(price),
    taxable_value: round2(taxableValue),
    output_gst: round2(outputGst),
    commission: round2(commission),
    shipping: round2(shipping),
    gst_on_fees: round2(gstOnFees),
    tcs: round2(tcs),
    tds: round2(tds),
    total_deductions: round2(totalDeductions),
    net_payout: round2(netPayout),
    cogs: round2(cogs),
    packaging_cost: round2(packaging),
    profit_per_delivered: round2(profitPerDelivered),
    margin_delivered_percent: round2(marginDelivered),
    expected_profit: round2(expectedProfit),
    margin_percent: round2(margin),
    profitable: expectedProfit > 0,
  };
}

/**
 * Reverse calculation: what price do I need for a target margin?
 *
 * Solved numerically (bisection) rather than algebraically — the return-rate
 * term makes the closed form easy to get subtly wrong, and 60 iterations of
 * bisection is exact to the paisa and obviously correct.
 *
 * @param {number} targetMarginPercent  Desired margin on selling price.
 * @param {object} input                Same rate/cost fields as computeSettlement.
 * @returns {object|null} { required_price, ...breakdown } or null if unreachable.
 */
export function requiredPriceForMargin(targetMarginPercent, input = {}) {
  const target = num(targetMarginPercent);

  const marginAt = (p) => computeSettlement({ ...input, meesho_price: p }).margin_percent;

  let lo = 0.01;
  let hi = 100000; // ₹1 lakh ceiling — far above any Meesho listing

  // Margin rises monotonically with price here; if even the ceiling misses the
  // target the inputs make it unreachable (e.g. fees exceed 100%).
  if (marginAt(hi) < target) return null;

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (marginAt(mid) < target) lo = mid;
    else hi = mid;
  }

  const required = round2(hi);
  return { required_price: required, ...computeSettlement({ ...input, meesho_price: required }) };
}

/**
 * MRP must be >= Meesho Price (already a mandatory catalog rule in meesho.js).
 * Returned as the same {level, message} shape validateListing uses.
 */
export function validatePricing({ mrp, meesho_price } = {}) {
  const issues = [];
  const m = num(mrp);
  const p = num(meesho_price);
  if (m > 0 && p > 0 && m < p) {
    issues.push({ level: "error", message: `MRP (₹${m}) must be ≥ Meesho Price (₹${p}).` });
  }
  return issues;
}
