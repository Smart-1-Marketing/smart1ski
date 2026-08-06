"use strict";

/* Every number in the report is computed by lib/plan.js and lib/weather.js —
 * deterministic, testable, defensible. This module adds exactly one thing on
 * top: two or three paragraphs of prose that read the computed numbers back
 * to the resort in plain language. It NEVER computes a number itself and the
 * prompt says so explicitly, because a hallucinated figure in a client-facing
 * sales document is the one failure mode this whole app is built to avoid.
 *
 * If OPENAI_API_KEY is unset, this is skipped entirely. The report already
 * has a one-line deterministic summary (report.summary); this is additive,
 * not load-bearing.
 */

function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

function factSheet(report) {
  // Only the numbers the model is allowed to talk about. Whitelisting the
  // exact figures — rather than handing over the whole report object — is
  // what keeps the model from padding the narrative with anything it wasn't
  // explicitly given.
  const r = report;
  const c = r.climate || {};
  const a = r.audience || {};
  const s = r.savings_model || {};
  const b = r.budget_plan || {};
  const sc = r.weather_marketing_readiness || {};

  return {
    resort_name: r.resort.name,
    location: r.resort.location,
    operating_months: r.resort.operating_months,
    objective: b.objective,
    readiness_score: sc.score,
    readiness_band: sc.band,
    seasons_of_history_analyzed: c.seasons_analyzed,
    total_season_weeks: c.total_season_weeks,
    avg_qualified_ad_days_per_season: c.avg_qualified_ad_days,
    avg_suppressed_days_per_season: c.avg_suppressed_days,
    strong_activation_weeks: (r.historical_weekly_plan || []).filter((w) => w.recommendation === "Aggressive activation").length,
    hold_weeks: (r.historical_weekly_plan || []).filter((w) => w.recommendation === "Hold or use future-date offers").length,
    estimated_targeted_skiing_households: a.estimated_targeted_skiing_households,
    feeder_markets: a.feeder_markets,
    always_on_season_spend: s.always_on_season_spend,
    trigger_controlled_spend: s.modeled_trigger_controlled_spend,
    estimated_budget_protected: s.estimated_budget_protected,
    estimated_budget_protected_percent: s.estimated_budget_protected_percent,
    monthly_budget: b.budget,
    channels: (b.channels || []).map((ch) => ({ channel: ch.channel, share_percent: ch.share_percent }))
  };
}

const SYSTEM_PROMPT = `You write a short executive summary for a ski resort's weather-triggered marketing plan.

Rules, none of which are optional:
- Use ONLY the numbers given to you in the JSON fact sheet. Never invent, estimate, round differently, or introduce any figure not present in the fact sheet.
- Do not perform new calculations. If you want to state a relationship between two given numbers (e.g. "X is about half of Y"), only do so if it is obviously and exactly true from the figures given — otherwise omit it.
- Do not claim or imply any performance outcome, ROI, or guarantee. This is a directional planning document, not a results promise.
- Write 2 to 3 short paragraphs, plain language, addressed to the resort's marketing director. No headers, no bullet points, no markdown.
- Do not mention Smart 1 Marketing by name or pitch any service — that happens elsewhere in the report. Just narrate what the data shows.
- If a figure is missing or null in the fact sheet, do not mention that metric at all rather than guessing at it.`;

/**
 * Returns { configured:false } if no API key is set. On a real API failure,
 * returns { configured:true, generated:false, error } rather than throwing —
 * the caller must never let this block report generation.
 */
async function generateSummary(report, deps) {
  if (!isConfigured()) return { configured: false, generated: false };

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const facts = factSheet(report);
  const doFetch = (deps && deps.fetch) || fetch;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await doFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 500,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Fact sheet:\n${JSON.stringify(facts, null, 2)}` }
        ]
      }),
      signal: controller.signal
    });

    const text = await res.text();
    if (!res.ok) return { configured: true, generated: false, error: `OpenAI returned ${res.status}: ${text.slice(0, 200)}` };

    const data = JSON.parse(text);
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content || !content.trim()) return { configured: true, generated: false, error: "Empty response" };

    return { configured: true, generated: true, text: content.trim(), model, facts_used: facts };
  } catch (err) {
    return { configured: true, generated: false, error: err.message || "Request failed" };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { generateSummary, isConfigured, factSheet, SYSTEM_PROMPT };
