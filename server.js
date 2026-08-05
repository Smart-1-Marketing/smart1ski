"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

const geo = require("./lib/geo");
const weather = require("./lib/weather");
const audienceModel = require("./lib/audience");
const reportModel = require("./lib/report");

const app = express();
const PORT = process.env.PORT || 10000;
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";

if (ORIGIN === "*") {
  console.warn(
    "[smart1ski] ALLOWED_ORIGIN is '*'. Any site can post to this API. " +
    "Set it to the exact origin that embeds the form before you launch."
  );
}
if (!process.env.SMART1_WEBHOOK_URL) {
  console.warn("[smart1ski] SMART1_WEBHOOK_URL is not set. Reports will build, but no leads will be created.");
}

app.set("trust proxy", 1); // Render sits behind a proxy; needed for a real req.ip
app.use(cors({ origin: ORIGIN }));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

const num = (v, f = 0) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : f);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------ abuse guards */
/* This form is an unauthenticated public door into the CRM. Without these,
   one person with a script fills the pipeline with four hundred fake
   opportunities and the sales team stops trusting the tool. */

const LIMITS = {
  PER_WINDOW: 5,
  WINDOW_MS: 15 * 60 * 1000,
  PER_DAY: 20,
  DAY_MS: 24 * 60 * 60 * 1000,
  MIN_FORM_SECONDS: 5,
  DEDUPE_MS: 10 * 60 * 1000
};

const hits = new Map();     // ip -> timestamps
const recent = new Map();   // fingerprint -> { at, response }

setInterval(() => {
  const now = Date.now();
  for (const [ip, stamps] of hits) {
    const kept = stamps.filter((t) => now - t < LIMITS.DAY_MS);
    if (kept.length) hits.set(ip, kept); else hits.delete(ip);
  }
  for (const [key, entry] of recent) {
    if (now - entry.at > LIMITS.DEDUPE_MS) recent.delete(key);
  }
}, 5 * 60 * 1000).unref();

function rateLimited(ip) {
  const now = Date.now();
  const stamps = (hits.get(ip) || []).filter((t) => now - t < LIMITS.DAY_MS);
  const inWindow = stamps.filter((t) => now - t < LIMITS.WINDOW_MS).length;

  if (inWindow >= LIMITS.PER_WINDOW) return "Too many submissions from this address. Wait a few minutes and try again.";
  if (stamps.length >= LIMITS.PER_DAY) return "Daily submission limit reached for this address.";

  stamps.push(now);
  hits.set(ip, stamps);
  return null;
}

function looksAutomated(body) {
  // An off-screen field with a meaningless name. Real people never see it; the
  // name gives browser autofill nothing to match on. If it comes back filled,
  // something scripted the form.
  if (String(body.s1_qx7 || "").trim()) {
    console.warn("[smart1ski] honeypot tripped");
    return "This submission could not be accepted. If you are a person, reload the page and try again.";
  }

  // Elapsed milliseconds measured inside the browser, NOT a wall-clock stamp
  // compared against the server's clock. Any skew between the two — and a few
  // minutes of skew is ordinary — would otherwise reject every real prospect.
  const elapsed = num(body.form_elapsed_ms, -1);
  if (elapsed >= 0) {
    const seconds = elapsed / 1000;
    if (seconds < LIMITS.MIN_FORM_SECONDS) {
      console.warn(`[smart1ski] submitted in ${seconds.toFixed(1)}s`);
      return "That was submitted faster than the form can be filled in. Reload the page and try again.";
    }
    if (seconds > 12 * 60 * 60) return "This form has been open too long. Reload the page and try again.";
  }
  return null;
}

function fingerprint(body) {
  return crypto
    .createHash("sha256")
    .update(`${String(body.contact_email || "").toLowerCase()}|${body.zip_code}|${body.monthly_budget}`)
    .digest("hex");
}

/* ------------------------------------------------------------- validation */

function validate(body) {
  const required = ["resort_name", "zip_code", "contact_name", "contact_email"];
  const missing = required.filter((k) => !String(body[k] || "").trim());
  if (missing.length) return `Missing required fields: ${missing.join(", ")}`;

  if (!/^\d{5}(-\d{4})?$/.test(String(body.zip_code).trim())) return "Enter a valid U.S. ZIP code.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.contact_email).trim())) return "Enter a valid email address.";

  const start = num(body.season_start_month, 11);
  const end = num(body.season_end_month, 3);
  if (start < 1 || start > 12 || end < 1 || end > 12) return "Select a valid season start and end month.";

  const budget = num(body.monthly_budget, 6000);
  if (budget < 2500 || budget > 100000) return "Enter a monthly budget between $2,500 and $100,000.";

  const base = num(body.base_elevation_ft, 0);
  const summit = num(body.summit_elevation_ft, 0);
  if (base && (base < 0 || base > 15000)) return "Enter a base elevation between 0 and 15,000 feet.";
  if (summit && base && summit < base) return "The summit elevation cannot be below the base elevation.";

  return null;
}

/* ---------------------------------------------------------------- webhook */

async function relayWebhook(payload) {
  const webhook = process.env.SMART1_WEBHOOK_URL;
  if (!webhook) return { configured: false, delivered: false };

  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Smart 1 Suite webhook returned ${response.status}: ${text.slice(0, 180)}`);
  }
  return { configured: true, delivered: true, status: response.status };
}

function suitePayload(body, report) {
  const { s1_qx7, form_elapsed_ms, ...clean } = body;
  return {
    ...clean,
    source: "Smart 1 Ski Resort Package",
    report_json: JSON.stringify(report),
    weather_marketing_readiness_score: report.weather_marketing_readiness_score,
    weather_marketing_readiness_band: report.weather_marketing_readiness.band,
    estimated_targeted_skiing_households: report.audience.estimated_targeted_skiing_households,
    estimated_targetable_pool: report.audience.broad_skiing_households,
    estimated_budget_protected: report.savings_model.estimated_budget_protected,
    estimated_budget_protected_percent: report.savings_model.estimated_budget_protected_percent,
    recommended_monthly_budget: report.budget_plan.budget,
    resort_location_resolved: report.resort.location,
    media_lead_days: report.climate.media_lead_days,
    forecast_activation_days: report.outlook ? report.outlook.activation_days : null,
    generated_at: report.generated_at
  };
}

/* ------------------------------------------------------------------ routes */

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "smart1ski",
    webhook_configured: Boolean(process.env.SMART1_WEBHOOK_URL),
    origin_locked: ORIGIN !== "*"
  })
);

app.post("/api/analyze", async (req, res) => {
  try {
    const body = req.body || {};

    const bot = looksAutomated(body);
    if (bot) return res.status(400).json({ ok: false, error: bot });

    const limited = rateLimited(req.ip || "unknown");
    if (limited) return res.status(429).json({ ok: false, error: limited });

    const invalid = validate(body);
    if (invalid) return res.status(400).json({ ok: false, error: invalid });

    // The same person clicking twice should not create two opportunities.
    const key = fingerprint(body);
    const seen = recent.get(key);
    if (seen && Date.now() - seen.at < LIMITS.DEDUPE_MS) {
      return res.json({ ...seen.response, deduplicated: true });
    }

    const site = await geo.resolveResort(body);
    const makesSnow = String(body.snowmaking || "yes") !== "no";
    const opts = {
      startMonth: clamp(num(body.season_start_month, 11), 1, 12),
      endMonth: clamp(num(body.season_end_month, 3), 1, 12),
      makesSnow,
      bookingWindow: body.booking_window
    };

    let climate;
    try {
      climate = await weather.history(site, opts);
    } catch (err) {
      return res.status(502).json({
        ok: false,
        error: "Historical weather could not be retrieved for this location, so no plan was built. Try again in a moment.",
        details: err.message
      });
    }

    // The forecast is a bonus, not a dependency. Never fail the report over it.
    let outlook = null;
    try {
      outlook = await weather.forecast(site, opts);
    } catch (err) {
      outlook = { unavailable: true, note: "The 16-day outlook could not be retrieved. The historical plan is unaffected." };
    }

    const audience = await audienceModel.estimate(body, site);
    const report = reportModel.build({ body, site, climate, audience, outlook });

    let webhook = { configured: false, delivered: false };
    try {
      webhook = await relayWebhook(suitePayload(body, report));
    } catch (err) {
      // The plan still goes to the customer. Nobody is told a lead landed when it did not.
      return res.status(502).json({
        ok: false,
        error: "The plan was built, but it could not be recorded in Smart 1 Suite. The lead was not created.",
        details: err.message,
        report
      });
    }

    const response = { ok: true, webhook, report };
    recent.set(key, { at: Date.now(), response });
    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || "Unable to build the plan." });
  }
});

app.listen(PORT, () => console.log(`Smart1Ski listening on port ${PORT} (origin: ${ORIGIN})`));
