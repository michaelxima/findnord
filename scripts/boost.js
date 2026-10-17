// NM-A18: Monetization Foundation -- Boost / Premium (free-first, Stripe-ready).
//
// Per the PRD's launch policy, boosting stays free for the first 6 months
// after public launch (or until a deployer explicitly flips the feature
// flag). BOOST_PAYMENTS_ENABLED defaults OFF -- no env var, no code change,
// means "still free," which is the safe default for a fresh deployment.
//
// No `stripe` npm dependency: the same "avoid an unnecessary dependency"
// instinct that shaped NM-A14's scrypt-over-bcrypt and NM-A15's hand-rolled
// JWT verification. Stripe's Checkout Sessions and webhook signatures are
// both plain, well-documented HTTP/HMAC contracts -- calling them with the
// built-in `fetch` and `crypto` needs no SDK. This module is real,
// correctly-shaped integration code; it has never been exercised against a
// real Stripe account because this project has no Stripe test keys (see
// EVIDENCE.md) -- exactly what "prepare the integration points... do not
// require live keys yet" asks for.

const crypto = require("node:crypto");

// Duration in days is the unit the PRD itself specifies (24 hours, 7/30
// days, 6/12 months) -- months are approximated as 30-day blocks, an
// intentional, documented simplification (a "6 month" boost is exactly 182
// days here, not calendar-aware), consistent with this project's other
// "close enough for a prototype, documented" choices (e.g. approximate
// region centroids in the geolocation slice).
const BOOST_PACKAGES = [
  { id: "24h", label: "24 hours", days: 1, priceSek: 19 },
  { id: "7d", label: "7 days", days: 7, priceSek: 49 },
  { id: "30d", label: "30 days", days: 30, priceSek: 99 },
  { id: "6m", label: "6 months", days: 182, priceSek: 399 },
  { id: "12m", label: "12 months", days: 365, priceSek: 699 }
];

function findBoostPackage(packageId) {
  return BOOST_PACKAGES.find((pkg) => pkg.id === packageId) || null;
}

function boostDurationMs(pkg) {
  return pkg.days * 24 * 60 * 60 * 1000;
}

// --- The free launch window ---
//
// Boosting is free for the first BOOST_FREE_MONTHS after launch, then the
// paid packages become available on their own. That end point is a REAL,
// persisted date rather than "six months from whenever this process started":
// recomputing it per boot would quietly re-extend the promotion on every
// deploy, so the deadline would move and never arrive. It is therefore stored
// in app_settings the first time it is ever needed (db/schema.sql) and read
// back on every later boot -- a restart, a redeploy, a scaling-up all keep
// the identical deadline.
//
// A deployer can always override it with an explicit BOOST_FREE_UNTIL ISO
// date (e.g. to shorten the promotion, or to set it in the past to open paid
// boosts immediately). An unparseable value is ignored rather than trusted,
// so a typo degrades to the stored default instead of accidentally enabling
// payments on day one.
const BOOST_FREE_MONTHS = 6;
const BOOST_FREE_UNTIL_KEY = "boost_free_until";

function parseIsoDateToMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// Calendar-aware "+6 months" (2026-10-17 -> 2027-04-17), not a flat 180
// days, because this is a promotion boundary a human will read and compare
// against a stated date -- unlike boost package durations, where the module
// already documents an intentional 30-day-per-month simplification.
function addMonths(ms, months) {
  const date = new Date(ms);
  date.setMonth(date.getMonth() + months);
  return date.getTime();
}

// The moment the free window closes. Priority: explicit env override, then
// the persisted anchor, then -- only ever on the very first call -- "now plus
// six months", which is persisted immediately so it never drifts.
function boostFreeUntil(db, now = Date.now()) {
  const fromEnv = parseIsoDateToMs(process.env.BOOST_FREE_UNTIL);
  if (fromEnv) return fromEnv;

  if (db) {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(BOOST_FREE_UNTIL_KEY);
    if (row) {
      const stored = Number(row.value);
      if (Number.isFinite(stored) && stored > 0) return stored;
    }
    const anchored = addMonths(now, BOOST_FREE_MONTHS);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(BOOST_FREE_UNTIL_KEY, String(anchored));
    return anchored;
  }

  // No database available (a caller that only wants the shape of the window):
  // compute it without persisting, so a read-only query can't create state.
  return addMonths(now, BOOST_FREE_MONTHS);
}

function isBoostFreeWindowActive(db, now = Date.now()) {
  return now < boostFreeUntil(db, now);
}

// A real env-var feature flag, not a hardcoded constant -- flippable per
// deployment with zero code changes, exactly like OPENAI_API_KEY/
// GOOGLE_CLIENT_ID already are in this project.
//
// An EXPLICIT value always wins, in both directions: a deployer who sets
// "true" or "false" gets exactly that, immediately. Only when it is left
// entirely unset does the launch window decide -- payments stay frozen and
// boosting stays free until the window closes, then become available with no
// code change and no manual flag-flip required.
function isBoostPaymentsEnabled(db) {
  const explicit = process.env.BOOST_PAYMENTS_ENABLED;
  if (explicit !== undefined) return explicit === "true";
  if (!db) return false; // matches the pre-window default exactly
  return !isBoostFreeWindowActive(db);
}

function stripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY || null;
}

function stripeWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET || null;
}

// Real Stripe REST call (Checkout Sessions), via plain fetch -- no SDK. Only
// ever invoked when isBoostPaymentsEnabled() AND a real secret key are both
// present, neither of which is true anywhere this project runs today.
// `successUrl`/`cancelUrl` both carry the listing id so the frontend can
// reopen the right listing either way; `metadata` is what the webhook
// handler below reads to know which listing/package to actually apply.
async function createBoostCheckoutSession({ listingId, packageId, successUrl, cancelUrl }) {
  const pkg = findBoostPackage(packageId);
  const secretKey = stripeSecretKey();
  if (!secretKey) {
    throw Object.assign(new Error("Stripe is not configured on this server."), { code: "STRIPE_NOT_CONFIGURED" });
  }
  if (!pkg) {
    throw Object.assign(new Error("Unknown boost package."), { code: "INVALID_BOOST_PACKAGE" });
  }

  const body = new URLSearchParams({
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "sek",
    "line_items[0][price_data][unit_amount]": String(pkg.priceSek * 100),
    "line_items[0][price_data][product_data][name]": `FindNord Boost — ${pkg.label}`,
    "metadata[listingId]": listingId,
    "metadata[packageId]": packageId
  });

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (data && data.error && data.error.message) || `Stripe request failed (${response.status}).`;
    throw Object.assign(new Error(message), { code: "STRIPE_REQUEST_FAILED" });
  }
  return { id: data.id, url: data.url };
}

// Stripe signs webhooks as `t=<timestamp>,v1=<hex hmac>` in the
// Stripe-Signature header, over the string `${timestamp}.${rawBody}`, using
// HMAC-SHA256 with the webhook signing secret -- documented, not
// SDK-specific, so Node's own crypto.timingSafeEqual verifies it exactly as
// correctly as the official SDK would.
function verifyStripeWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    })
  );
  if (!parts.t || !parts.v1) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(parts.v1, "hex");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

module.exports = {
  BOOST_PACKAGES,
  BOOST_FREE_MONTHS,
  findBoostPackage,
  boostDurationMs,
  boostFreeUntil,
  isBoostFreeWindowActive,
  isBoostPaymentsEnabled,
  stripeSecretKey,
  stripeWebhookSecret,
  createBoostCheckoutSession,
  verifyStripeWebhookSignature
};
