require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const PDFDocument = require("pdfkit");
const cloudinary = require("cloudinary").v2; // auto-configures from CLOUDINARY_URL

const app = express();
const PORT = process.env.PORT || 10000;

// Standardized webhook variable (falls back to the old name for safety).
const WEBHOOK = (process.env.GHL_WEBHOOK_URL || process.env.SMART1_WEBHOOK_URL || "").trim();
// Base name / Cloudinary folder for generated report PDFs.
const REPORT_NAME = (process.env.REPORT_NAME || "dealership-rv-report").trim();

cloudinary.config({ secure: true }); // credentials come from CLOUDINARY_URL

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value) => Math.round(value);

function validate(body) {
  const required = ["resort_name", "zip_code", "contact_name", "contact_email"];
  const missing = required.filter((key) => !String(body[key] || "").trim());
  if (missing.length) return `Missing required fields: ${missing.join(", ")}`;
  if (!/^\d{5}(-\d{4})?$/.test(String(body.zip_code).trim())) return "Enter a valid U.S. ZIP code.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.contact_email).trim())) return "Enter a valid email address.";
  return null;
}

async function geocode(zip) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", zip);
  url.searchParams.set("count", "10");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const response = await fetch(url);
  if (!response.ok) throw new Error("Location lookup failed.");
  const data = await response.json();
  const match = (data.results || []).find((r) => r.country_code === "US") || (data.results || [])[0];
  if (!match) throw new Error("ZIP code could not be located.");
  return {
    latitude: match.latitude,
    longitude: match.longitude,
    city: match.name || "",
    state: match.admin1 || "",
    elevation_m: num(match.elevation)
  };
}

async function climateSummary(latitude, longitude, seasonStartMonth = 11, seasonEndMonth = 3) {
  const currentYear = new Date().getUTCFullYear();
  const endYear = currentYear - 1;
  const startYear = endYear - 5;
  const start = `${startYear}-${String(seasonStartMonth).padStart(2, "0")}-01`;
  const endDateYear = seasonEndMonth < seasonStartMonth ? endYear : startYear + 5;
  const finalDay = new Date(Date.UTC(endDateYear, seasonEndMonth, 0)).getUTCDate();
  const end = `${endDateYear}-${String(seasonEndMonth).padStart(2, "0")}-${finalDay}`;

  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.searchParams.set("latitude", latitude);
  url.searchParams.set("longitude", longitude);
  url.searchParams.set("start_date", start);
  url.searchParams.set("end_date", end);
  url.searchParams.set("daily", [
    "temperature_2m_max",
    "temperature_2m_min",
    "snowfall_sum",
    "rain_sum",
    "precipitation_sum",
    "wind_speed_10m_max",
    "sunshine_duration"
  ].join(","));
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("timezone", "auto");

  const response = await fetch(url);
  if (!response.ok) throw new Error("Historical climate lookup failed.");
  const data = await response.json();
  const d = data.daily || {};
  const dates = d.time || [];

  const inSeason = (month) => seasonStartMonth <= seasonEndMonth
    ? month >= seasonStartMonth && month <= seasonEndMonth
    : month >= seasonStartMonth || month <= seasonEndMonth;

  const seasons = {};
  dates.forEach((date, i) => {
    const dt = new Date(`${date}T12:00:00Z`);
    const month = dt.getUTCMonth() + 1;
    if (!inSeason(month)) return;
    const season = month >= seasonStartMonth ? dt.getUTCFullYear() : dt.getUTCFullYear() - 1;
    seasons[season] ||= { days: [] };

    const maxT = num(d.temperature_2m_max?.[i], 99);
    const minT = num(d.temperature_2m_min?.[i], 99);
    const snowfall = num(d.snowfall_sum?.[i]);
    const rain = num(d.rain_sum?.[i]);
    const wind = num(d.wind_speed_10m_max?.[i]);
    const sunshineHours = num(d.sunshine_duration?.[i]) / 3600;
    const priorSnow = i > 0 ? num(d.snowfall_sum?.[i - 1]) : 0;
    const prior2Snow = i > 1 ? num(d.snowfall_sum?.[i - 2]) : 0;

    seasons[season].days.push({
      date,
      maxT,
      minT,
      snowfall,
      rain,
      wind,
      sunshineHours,
      cold: maxT <= 32 || minT <= 20,
      snowmaking: minT <= 28 && maxT <= 38,
      powder: snowfall >= 4,
      rainRisk: rain >= 0.25 && maxT > 34,
      windRisk: wind >= 30,
      bluebird: (priorSnow >= 3 || prior2Snow >= 4) && sunshineHours >= 5 && maxT <= 40
    });
  });

  const seasonRows = Object.values(seasons).filter(s => s.days.length >= 21);
  const weeklyBuckets = {};

  seasonRows.forEach(season => {
    season.days.sort((a,b) => a.date.localeCompare(b.date));
    season.days.forEach((day, index) => {
      const week = Math.floor(index / 7) + 1;
      weeklyBuckets[week] ||= [];
      weeklyBuckets[week].push(day);
    });
  });

  const weekly = Object.entries(weeklyBuckets).map(([week, days]) => {
    const total = days.length || 1;
    const seasonCount = seasonRows.length || 1;
    const sum = key => days.reduce((a, b) => a + (typeof b[key] === "boolean" ? (b[key] ? 1 : 0) : num(b[key])), 0);
    const qualifiedDays = days.filter(x =>
      x.powder || x.bluebird || x.snowmaking ||
      (x.maxT <= 35 && !x.rainRisk && !x.windRisk)
    ).length;
    const suppressedDays = days.filter(x => x.rainRisk || x.windRisk || x.maxT >= 45).length;
    const avgQualified = qualifiedDays / seasonCount;
    const avgSuppressed = suppressedDays / seasonCount;
    const confidence = clamp(Math.round((avgQualified / 7) * 100), 0, 100);
    return {
      week_number: Number(week),
      avg_qualified_ad_days: Math.round(avgQualified * 10) / 10,
      avg_suppressed_days: Math.round(avgSuppressed * 10) / 10,
      avg_snowfall_inches: Math.round((sum("snowfall") / seasonCount) * 10) / 10,
      avg_snowmaking_days: Math.round((sum("snowmaking") / seasonCount) * 10) / 10,
      avg_powder_days: Math.round((sum("powder") / seasonCount) * 10) / 10,
      avg_bluebird_days: Math.round((sum("bluebird") / seasonCount) * 10) / 10,
      avg_rain_risk_days: Math.round((sum("rainRisk") / seasonCount) * 10) / 10,
      avg_wind_risk_days: Math.round((sum("windRisk") / seasonCount) * 10) / 10,
      activation_confidence: confidence,
      recommendation: confidence >= 60 ? "Aggressive activation"
        : confidence >= 35 ? "Selective activation"
        : "Hold or use future-date offers"
    };
  });

  const allDays = seasonRows.flatMap(s => s.days);
  const avgPerSeason = key => seasonRows.length
    ? seasonRows.reduce((total, season) => total + season.days.reduce((a,b) => a + (typeof b[key] === "boolean" ? (b[key] ? 1 : 0) : num(b[key])), 0), 0) / seasonRows.length
    : 0;

  return {
    seasons_analyzed: seasonRows.length,
    avg_cold_days: round(avgPerSeason("cold")),
    avg_snowmaking_days: round(avgPerSeason("snowmaking")),
    avg_powder_days: Math.round(avgPerSeason("powder") * 10) / 10,
    avg_bluebird_days: Math.round(avgPerSeason("bluebird") * 10) / 10,
    avg_rain_risk_days: round(avgPerSeason("rainRisk")),
    avg_high_wind_days: round(avgPerSeason("windRisk")),
    avg_natural_snowfall_inches: round(avgPerSeason("snowfall")),
    total_season_weeks: weekly.length,
    weekly
  };
}

function estimateAudience(body) {
  const population = num(body.feeder_population);
  const householdsEntered = num(body.feeder_households);
  const personsPerHousehold = clamp(num(body.persons_per_household, 2.45), 1.5, 4.5);
  const affluentShare = clamp(num(body.affluent_share, 35), 5, 90) / 100;
  const skiHouseholdRate = clamp(num(body.ski_household_rate, body.ski_participation_rate || 9), 2, 30) / 100;
  const driveShare = clamp(num(body.drive_market_share, 75), 20, 100) / 100;

  let households = householdsEntered || (population ? population / personsPerHousehold : 0);
  if (!households) {
    const markets = String(body.target_markets || "").split(",").filter(Boolean).length || 1;
    households = markets * 210000;
  }

  const populationUsed = population || households * personsPerHousehold;
  const broadSkiHouseholds = round(households * skiHouseholdRate);
  const qualifiedHouseholds = round(households * affluentShare * skiHouseholdRate * driveShare);
  const pastVisitorHouseholds = round(qualifiedHouseholds * 0.35);
  const familyHouseholds = round(qualifiedHouseholds * 0.42);
  const estimatedIndividuals = round(qualifiedHouseholds * 2.1);

  return {
    feeder_population_used: round(populationUsed),
    feeder_households_used: round(households),
    broad_skiing_households: broadSkiHouseholds,
    estimated_targeted_skiing_households: qualifiedHouseholds,
    estimated_targeted_skiers_and_riders: estimatedIndividuals,
    estimated_past_resort_visitor_households: pastVisitorHouseholds,
    estimated_family_ski_households: familyHouseholds,
    methodology_note: "Directional household estimate based on feeder-market households, affluence, skiing-household participation, and drive-market relevance. It is not a purchased audience count."
  };
}

function budgetPlan(body) {
  const selected = String(body.monthly_budget || "6000");
  const budget = clamp(num(selected, 6000), 2500, 100000);
  const objective = body.campaign_objective || "lift_tickets";

  let shares = { ctv: .40, display: .35, audio: .25 };
  if (objective === "season_passes") shares = { ctv: .42, display: .33, audio: .25 };
  if (objective === "lodging") shares = { ctv: .45, display: .35, audio: .20 };
  if (objective === "local_visits") shares = { ctv: .32, display: .40, audio: .28 };

  const cpms = { ctv: 35, display: 8, audio: 20 };
  const allocation = Object.fromEntries(Object.entries(shares).map(([key, share]) => [key, round(budget * share)]));
  const impressions = {
    ctv: round(allocation.ctv / cpms.ctv * 1000),
    display: round(allocation.display / cpms.display * 1000),
    audio: round(allocation.audio / cpms.audio * 1000)
  };

  return {
    budget,
    allocation,
    impressions,
    channel_strategy: [
      { channel: "Connected TV", role: "Build awareness and urgency in skiing households during qualified weather windows.", cpm_assumption: cpms.ctv },
      { channel: "Programmatic Display", role: "Deliver high-frequency weather, snowfall, lodging, ticket, and event messaging across premium websites and apps.", cpm_assumption: cpms.display },
      { channel: "Digital Audio", role: "Reach commuters, travelers, and outdoor audiences with localized weather-triggered audio and companion banners.", cpm_assumption: cpms.audio }
    ],
    note: "The recommendation intentionally excludes paid social and paid search. Delivery estimates use planning CPM assumptions and will vary by market, inventory, targeting, and campaign dates."
  };
}

function savingsModel(body, climate, budgetPlan) {
  const seasonWeeks = climate.total_season_weeks || clamp(num(body.season_weeks, 20), 8, 30);
  const weeklyBudget = budgetPlan.budget / 4.345;
  const alwaysOnSeasonSpend = round(weeklyBudget * seasonWeeks);
  const weekly = climate.weekly || [];

  const qualifiedRatio = weekly.length
    ? weekly.reduce((sum, w) => sum + clamp(w.avg_qualified_ad_days / 7, 0, 1), 0) / weekly.length
    : 0.62;

  const minimumActivation = clamp(num(body.minimum_activation_share, 35), 15, 80) / 100;
  const activationShare = clamp(Math.max(qualifiedRatio, minimumActivation), minimumActivation, .92);
  const triggerControlledSpend = round(alwaysOnSeasonSpend * activationShare);
  const protectedBudget = Math.max(0, alwaysOnSeasonSpend - triggerControlledSpend);
  const protectedPercent = alwaysOnSeasonSpend ? Math.round(protectedBudget / alwaysOnSeasonSpend * 100) : 0;

  const poorConditionWeeks = weekly.filter(w => w.avg_suppressed_days >= 2.5 || w.activation_confidence < 30).length;
  const strongConditionWeeks = weekly.filter(w => w.activation_confidence >= 60).length;

  return {
    season_weeks: seasonWeeks,
    modeled_weekly_budget: round(weeklyBudget),
    always_on_season_spend: alwaysOnSeasonSpend,
    modeled_trigger_controlled_spend: triggerControlledSpend,
    estimated_budget_protected: protectedBudget,
    estimated_budget_protected_percent: protectedPercent,
    historically_weak_or_suppressed_weeks: poorConditionWeeks,
    historically_strong_activation_weeks: strongConditionWeeks,
    activation_share_used: Math.round(activationShare * 100),
    methodology_note: "Savings represent media budget that could be held, moved, or redirected during historically weak weather windows. This is not a guaranteed cash refund or guaranteed performance improvement."
  };
}

function triggers(climate, body) {
  const hasSnowmaking = String(body.snowmaking || "yes") !== "no";
  const result = [
    {
      name: "Powder Alert",
      condition: "Forecast of 4+ inches within 72 hours or verified fresh snowfall",
      action: "Activate urgent lift-ticket, lodging, and weekend-trip creative in feeder markets",
      priority: "High"
    },
    {
      name: "Bluebird Window",
      condition: "Clear or mostly sunny weather within 48 hours after meaningful snowfall",
      action: "Promote premium experience, scenery, lessons, dining, and overnight packages",
      priority: "High"
    },
    {
      name: "Cold/Snowmaking Window",
      condition: hasSnowmaking ? "Sustained temperatures favorable for snowmaking" : "Sustained freezing temperatures supporting snow retention",
      action: hasSnowmaking ? "Promote terrain expansion and improved surface conditions" : "Promote preserved snow quality and open terrain",
      priority: hasSnowmaking ? "High" : "Medium"
    },
    {
      name: "Rain/Warmth Suppression",
      condition: "Meaningful rain or temperatures likely to reduce conversion",
      action: "Pause urgency campaigns; shift to passes, future-date lodging, dining, events, or summer products",
      priority: "Protective"
    },
    {
      name: "High-Wind Adjustment",
      condition: "Forecast wind likely to affect lifts or guest comfort",
      action: "Suppress same-day acquisition unless operations confirm normal lift access",
      priority: "Protective"
    }
  ];
  return result;
}

function targetLocations(body) {
  const competitorNames = String(body.competitors || "").split(/\n|,/).map(s => s.trim()).filter(Boolean);
  const feederMarkets = String(body.target_markets || "").split(/\n|,/).map(s => s.trim()).filter(Boolean);
  const categories = [
    "Competing ski resorts and tubing parks",
    "Ski, snowboard, and outdoor equipment retailers",
    "Winter sports clubs and race programs",
    "High-income ZIP codes in primary feeder markets",
    "Hotels near competitor resorts and mountain gateways",
    "Airports, park-and-ride lots, and travel corridors used by destination guests",
    "College campuses with ski clubs",
    "Family entertainment venues for beginner and tubing audiences"
  ];
  return {
    feeder_markets: feederMarkets,
    named_competitors: competitorNames,
    geofence_categories: categories,
    lookback_recommendation: "Build seasonal visitor audiences from prior resort visitors where platform and privacy rules permit, then suppress current passholders when acquisition is the objective."
  };
}

function buildReport(body, location, climate) {
  const audience = estimateAudience(body);
  const budget = budgetPlan(body);
  const savings = savingsModel(body, climate, budget);
  const triggerPlan = triggers(climate, body);
  const targets = targetLocations(body);

  let score = 50;
  score += clamp(climate.avg_snowmaking_days / 3, 0, 20);
  score += clamp(climate.avg_powder_days * 2, 0, 15);
  score += clamp(climate.avg_bluebird_days, 0, 10);
  score -= clamp(climate.avg_rain_risk_days / 2, 0, 12);
  score -= clamp(climate.avg_high_wind_days / 3, 0, 8);
  score = round(clamp(score, 25, 95));

  return {
    generated_at: new Date().toISOString(),
    resort: {
      name: body.resort_name,
      website: body.website || "",
      zip_code: body.zip_code,
      location: `${location.city}${location.state ? ", " + location.state : ""}`,
      elevation_feet_estimate: round(location.elevation_m * 3.28084),
      operating_months: body.operating_months || "November–March",
      objective: body.campaign_objective || "lift_tickets"
    },
    climate,
    weather_marketing_readiness_score: score,
    audience,
    historical_weekly_plan: climate.weekly || [],
    savings_model: savings,
    recommended_targets: targets,
    trigger_plan: triggerPlan,
    budget_plan: budget,
    campaign_phases: [
      { phase: "Preseason", focus: "Season passes, groups, lessons, early lodging, gift cards", timing: "August–opening day" },
      { phase: "Opening/Build", focus: "Snowmaking progress, terrain expansion, opening dates", timing: "First sustained cold windows" },
      { phase: "Peak Winter", focus: "Powder alerts, bluebird weekends, lodging and lift tickets", timing: "December–February" },
      { phase: "Spring", focus: "Value tickets, events, patios, festivals and pass renewal", timing: "March–closing" },
      { phase: "Offseason", focus: "Weddings, lodging, golf, biking, festivals or next-year passes", timing: "After closing" }
    ],
    disclaimer: "Weather history and audience counts are directional planning estimates. Operational decisions should use the resort’s forecast provider, snow report, lift status, inventory, and approved media-platform data."
  };
}

function slug(text) {
  return String(text || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "report";
}

// Render the report JSON into a branded PDF and return a Buffer (pure JS, no system libs).
function buildReportPdf(report) {
  return new Promise((resolve, reject) => {
    try {
      const NAVY = "#1A2E58", BLUE = "#1677c8", MUTED = "#5f6f83", GREEN = "#26a269";
      const doc = new PDFDocument({ size: "LETTER", margin: 54 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
      const money = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString("en-US"));
      const a = report.audience || {}, s = report.savings_model || {}, b = report.budget_plan || {}, c = report.climate || {};

      const h2 = (t) => { doc.moveDown(0.8).fillColor(NAVY).font("Helvetica-Bold").fontSize(13).text(t); doc.moveTo(doc.x, doc.y + 2).lineTo(558, doc.y + 2).strokeColor("#dbe3ec").stroke(); doc.moveDown(0.4); };
      const body = (t) => doc.fillColor("#25364b").font("Helvetica").fontSize(10).text(t, { lineGap: 2 });
      const kv = (k, v) => { doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(k + "  ", { continued: true }).fillColor(NAVY).font("Helvetica-Bold").text(v); };

      doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(8).text("SMART 1 MARKETING · SKI RESORT MARKETING PLAN", { characterSpacing: 1 });
      doc.moveDown(0.2).fillColor(NAVY).font("Helvetica-Bold").fontSize(22).text(report.resort.name || "Ski Resort");
      doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(
        `${report.resort.location || ""}  ·  ZIP ${report.resort.zip_code || ""}  ·  Approx. elevation ${fmt(report.resort.elevation_feet_estimate)} ft`
      );

      // Readiness score
      doc.moveDown(0.8);
      const yBox = doc.y;
      doc.roundedRect(54, yBox, 504, 46, 8).fill("#eaf6ff");
      doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(24).text(String(report.weather_marketing_readiness_score ?? "—"), 66, yBox + 10, { width: 60 });
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Weather-Marketing Readiness Score", 130, yBox + 9);
      doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text("Directional planning score from historical cold, snow, bluebird, rain & wind patterns.", 130, yBox + 24, { width: 410 });
      doc.y = yBox + 58; doc.x = 54;

      h2("Estimated Targeted Skiing Households");
      kv("Feeder households used:", fmt(a.feeder_households_used));
      kv("Broad skiing households:", fmt(a.broad_skiing_households));
      kv("Estimated targeted skiing households:", fmt(a.estimated_targeted_skiing_households));
      kv("Estimated skiers & riders:", fmt(a.estimated_targeted_skiers_and_riders));

      h2("Historical Weather-Based Savings Model");
      kv("Modeled always-on season spend:", money(s.always_on_season_spend));
      kv("Modeled trigger-controlled spend:", money(s.modeled_trigger_controlled_spend));
      kv("Estimated budget protected:", money(s.estimated_budget_protected) + (s.estimated_budget_protected_percent != null ? ` (${s.estimated_budget_protected_percent}%)` : ""));
      kv("Historically strong activation weeks:", fmt(s.historically_strong_activation_weeks));

      h2("Recommended Monthly Media Plan: " + money(b.budget));
      if (b.allocation) {
        kv("Connected TV:", money(b.allocation.ctv));
        kv("Programmatic Display:", money(b.allocation.display));
        kv("Digital Audio:", money(b.allocation.audio));
      }
      body(b.note || "");

      h2("Weather Trigger Playbook");
      (report.trigger_plan || []).forEach((t) => {
        doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY).text(t.name + " — ", { continued: true }).font("Helvetica").fillColor("#25364b").text(t.condition);
        doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(t.action, { lineGap: 2 });
        doc.moveDown(0.2);
      });

      h2("Seasonal Campaign Structure");
      (report.campaign_phases || []).forEach((p) => {
        doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY).text(`${p.phase} (${p.timing})`);
        doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(p.focus, { lineGap: 2 });
        doc.moveDown(0.2);
      });

      doc.moveDown(0.6).font("Helvetica").fontSize(7.5).fillColor(MUTED).text(report.disclaimer || "", { lineGap: 1 });
      doc.end();
    } catch (e) { reject(e); }
  });
}

// Upload a PDF buffer to Cloudinary as a raw file and return its secure URL.
function uploadReportPdf(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "raw", public_id: publicId, overwrite: true, unique_filename: false, use_filename: false },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

async function relayWebhook(payload) {
  if (!WEBHOOK) return { configured: false, delivered: false };
  const response = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GHL webhook returned ${response.status}: ${text.slice(0, 180)}`);
  return { configured: true, delivered: true, status: response.status };
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "smart1ski" }));

app.post("/api/analyze", async (req, res) => {
  try {
    const error = validate(req.body);
    if (error) return res.status(400).json({ ok: false, error });

    const location = await geocode(req.body.zip_code);
    let climate;
    try {
      climate = await climateSummary(
        location.latitude,
        location.longitude,
        num(req.body.season_start_month, 11),
        num(req.body.season_end_month, 3)
      );
    } catch (weatherError) {
      climate = {
        seasons_analyzed: 0,
        avg_cold_days: null,
        avg_snowmaking_days: null,
        avg_powder_days: null,
        avg_bluebird_days: null,
        avg_rain_risk_days: null,
        avg_high_wind_days: null,
        avg_natural_snowfall_inches: null,
        data_note: "Historical weather was temporarily unavailable; report generated without climate totals."
      };
    }

    const report = buildReport(req.body, location, climate);

    // Generate the branded PDF and store it in Cloudinary. Guarded so a
    // PDF/upload failure never blocks the lead from reaching GHL.
    let report_pdf_url = "";
    try {
      const pdf = await buildReportPdf(report);
      const publicId = `${REPORT_NAME}/${slug(report.resort.name)}-${Date.now()}.pdf`;
      const uploaded = await uploadReportPdf(pdf, publicId);
      report_pdf_url = uploaded.secure_url || "";
    } catch (pdfError) {
      console.error("PDF generation / Cloudinary upload failed:", pdfError.message);
    }

    const suitePayload = {
      ...req.body,
      source: "Smart 1 Ski Resort Package",
      report_json: JSON.stringify(report),
      report_pdf_url,
      weather_marketing_readiness_score: report.weather_marketing_readiness_score,
      estimated_targeted_skiing_households: report.audience.estimated_targeted_skiing_households,
      estimated_budget_protected: report.savings_model.estimated_budget_protected,
      estimated_budget_protected_percent: report.savings_model.estimated_budget_protected_percent,
      recommended_monthly_budget: report.budget_plan.budget,
      resort_location_resolved: report.resort.location,
      generated_at: report.generated_at
    };

    let webhook = { configured: false, delivered: false };
    try {
      webhook = await relayWebhook(suitePayload);
    } catch (webhookError) {
      return res.status(502).json({
        ok: false,
        error: "The analysis was created, but the GHL webhook failed.",
        details: webhookError.message,
        report,
        report_pdf_url
      });
    }

    res.json({ ok: true, webhook, report, report_pdf_url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message || "Unable to generate report." });
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Smart1Ski listening on port ${PORT}`));
}

module.exports = { app, buildReportPdf };
