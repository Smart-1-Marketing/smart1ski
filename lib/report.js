"use strict";

const plan = require("./plan");

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, f = 0) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : f);
const listify = (v) => String(v || "").split(/\n|,|;/).map((s) => s.trim()).filter(Boolean);

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function build({ body, site, climate, audience, outlook }) {
  const budget = plan.budgetPlan(body);
  const savings = plan.savingsModel(body, climate, budget);
  const score = plan.readiness(climate);

  const startMonth = clamp(num(body.season_start_month, 11), 1, 12);
  const endMonth = clamp(num(body.season_end_month, 3), 1, 12);

  const weekly = (climate.weekly || []).map((week) => ({
    ...week,
    plays: plan.WEEK_PLAYS[week.recommendation] || []
  }));

  return {
    generated_at: new Date().toISOString(),

    resort: {
      name: String(body.resort_name || "").trim(),
      website: String(body.website || "").trim(),
      zip_code: site.zip_code,
      location: `${site.city}${site.state ? ", " + site.state : ""}`,
      latitude: site.latitude,
      longitude: site.longitude,
      coordinates_source: site.coordinates_source,
      site_elevation_ft: site.site_elevation_ft,
      base_elevation_ft: site.base_elevation_ft,
      summit_elevation_ft: site.summit_elevation_ft,
      elevation_source: site.elevation_source,
      resort_type: body.resort_type || "regional_overnight",
      snowmaking: String(body.snowmaking || "yes"),
      operating_months: `${MONTHS[startMonth]}–${MONTHS[endMonth]}`,
      season_start_month: startMonth,
      season_end_month: endMonth,
      objective: budget.objective,
      drive_time: body.drive_time || "",
      booking_window: body.booking_window || "",
      booking_window_label: climate.booking_window_label,
      revenue_products: listify(body.revenue_products),
      offers_constraints: String(body.offers_constraints || ""),
      exclusions: String(body.exclusions || "")
    },

    contact: {
      name: String(body.contact_name || "").trim(),
      email: String(body.contact_email || "").trim(),
      phone: String(body.contact_phone || "").trim(),
      role: String(body.contact_role || "").trim()
    },

    weather_marketing_readiness: score,
    weather_marketing_readiness_score: score.score,

    climate,
    historical_weekly_plan: weekly,
    outlook,
    audience,
    savings_model: savings,
    budget_plan: budget,
    pricing_tiers: plan.pricingTiers(body, audience, climate),
    vs_traditional: plan.traditionalComparison(savings, budget),
    consult_url: plan.CONSULT_URL,
    recommended_targets: plan.targetLocations(body, audience),
    trigger_plan: plan.triggers(body, climate),
    campaign_phases: plan.PHASES,
    disclosures: plan.DISCLOSURES,

    summary:
      "This plan estimates the resort's addressable skiing households market by market, studies how weather quality changes across the historical ski season, shifts activation forward by the resort's booking window, and recommends concentrating Connected TV, programmatic display, and digital audio spending during the periods when customers are most likely to respond."
  };
}

module.exports = { build, MONTHS };
