/* Local harness. Stubs the outbound APIs so the whole pipeline runs without
   egress. The archive stub deliberately reports snowfall in CENTIMETRES —
   Open-Meteo's default — to prove the unit normalization actually fires. */

process.env.PORT = "10999";
delete process.env.SMART1_WEBHOOK_URL;

const realFetch = globalThis.fetch;
const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const r1 = (n) => Math.round(n * 10) / 10;

const MARKETS = {
  columbus:    { latitude: 39.96, longitude: -83.00, admin1: "Ohio",         population: 905748,  country_code: "US" },
  cleveland:   { latitude: 41.50, longitude: -81.69, admin1: "Ohio",         population: 372624,  country_code: "US" },
  cincinnati:  { latitude: 39.10, longitude: -84.51, admin1: "Ohio",         population: 309317,  country_code: "US" },
  pittsburgh:  { latitude: 40.44, longitude: -79.99, admin1: "Pennsylvania", population: 302971,  country_code: "US" },
  chicago:     { latitude: 41.85, longitude: -87.65, admin1: "Illinois",     population: 2746388, country_code: "US" }
};

// Grid cell sits in the valley at 240 m (~787 ft). The resort base is 1,150 ft.
const GRID_ELEVATION_M = 240;

function makeDaily(start, end) {
  const time = [], tmax = [], tmin = [], snow = [], rain = [], precip = [], wind = [], sun = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const doy = Math.floor((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 86400000);
    const seasonal = Math.cos(((doy - 15) / 365) * 2 * Math.PI);
    const wob = Math.sin(doy * 2.7 + d.getUTCFullYear() * 1.7) * 11;
    const hi = 44 - seasonal * 12 + wob;   // valley: Jan mean high ~32°F, shoulders ~44°F
    const lo = hi - 12;
    const snowyC = hi < 34 && Math.sin(doy * 1.3 + d.getUTCFullYear()) > 0.45;
    const rainy = hi > 36 && Math.cos(doy * 1.7 + d.getUTCFullYear()) > 0.30;
    const rainIn = rainy ? 0.4 : 0;
    const snowCm = snowyC ? r1((2 + Math.abs(wob) / 2) * 2.54) : 0;   // cm, not inches

    time.push(iso);
    tmax.push(r1(hi)); tmin.push(r1(lo));
    snow.push(snowCm);
    rain.push(rainIn);
    precip.push(r1(rainIn + snowCm / 2.54 / 7));
    wind.push(r1(9 + Math.abs(wob) * 1.8));
    sun.push(Math.round((snowyC ? 2 : 6) * 3600));
  }
  return { time, temperature_2m_max: tmax, temperature_2m_min: tmin, snowfall_sum: snow,
           rain_sum: rain, precipitation_sum: precip, wind_speed_10m_max: wind, sunshine_duration: sun };
}

const UNITS = {
  time: "iso8601",
  temperature_2m_max: "°F",
  temperature_2m_min: "°F",
  snowfall_sum: "cm",          // <-- the trap
  rain_sum: "inch",
  precipitation_sum: "inch",
  wind_speed_10m_max: "mp/h",
  sunshine_duration: "s"
};

globalThis.fetch = async function (input, init) {
  const url = String(input && input.href ? input.href : input);

  if (url.includes("zippopotam.us")) {
    return json({ places: [{ "place name": "Champion", latitude: "41.4600", longitude: "-79.1600", "state abbreviation": "PA" }] });
  }

  if (url.includes("geocoding-api")) {
    const name = new URL(url).searchParams.get("name").toLowerCase();
    const hit = MARKETS[name];
    return json({ results: hit ? [{ name, ...hit }] : [] });
  }

  if (url.includes("/v1/elevation")) return json({ elevation: [GRID_ELEVATION_M] });

  if (url.includes("archive-api")) {
    const u = new URL(url);
    const start = new Date(u.searchParams.get("start_date") + "T00:00:00Z");
    const end = new Date(u.searchParams.get("end_date") + "T00:00:00Z");
    global.__window = `${u.searchParams.get("start_date")} → ${u.searchParams.get("end_date")}`;
    return json({ elevation: GRID_ELEVATION_M, daily_units: UNITS, daily: makeDaily(start, end) });
  }

  if (url.includes("/v1/forecast")) {
    const start = new Date();
    const end = new Date(Date.now() + 15 * 86400000);
    return json({ elevation: GRID_ELEVATION_M, daily_units: UNITS, daily: makeDaily(start, end) });
  }

  return realFetch(input, init);
};

require("../server.js");

const BODY = {
  resort_name: "Hollow Ridge Mountain",
  zip_code: "16341",
  base_elevation_ft: 1150,
  summit_elevation_ft: 2400,
  resort_type: "day_drive,regional_overnight",
  snowmaking: "yes",
  season_start_month: 11,
  season_end_month: 3,
  drive_time: "2_4",
  booking_window: "week",
  target_markets: "Columbus\nCleveland\nCincinnati\nPittsburgh\nChicago\nAtlantis",
  affluent_share: 35,
  ski_household_rate: 9,
  persons_per_household: 2.45,
  competitors: "Mad River Mountain",
  campaign_objective: "lift_tickets,season_passes",
  current_media: "Paid social and some Google Ads",
  monthly_budget: 6000,
  contact_name: "Dana Reyes",
  contact_email: "dana@hollowridge.com",
  minimum_activation_share: 35,
  form_elapsed_ms: 60000
};

async function post(overrides, email) {
  const body = { ...BODY, ...overrides, form_elapsed_ms: 60000 };
  if (email) body.contact_email = email;
  const res = await realFetch("http://127.0.0.1:10999/api/analyze", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

const fails = [];
const ok = (label, cond, extra) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + label + (extra ? "  " + extra : ""));
  if (!cond) fails.push(label);
};

setTimeout(async () => {
  const { data } = await post({});
  if (!data.ok) { console.error("FAILED:", data.error, data.details || ""); process.exit(1); }

  const r = data.report;
  const c = r.climate, a = r.audience, s = r.savings_model, b = r.budget_plan, o = r.outlook;
  const ea = c.elevation_adjustment;

  console.log("\n1 · units");
  console.log("   archive window:", global.__window);
  ok("source unit recorded as cm", c.units_reported_by_source.snowfall === "cm");
  ok("snowfall converted to inches, not left as cm",
    c.avg_natural_snowfall_inches > 5 && c.avg_natural_snowfall_inches < 200,
    `(${c.avg_natural_snowfall_inches}" per season)`);

  console.log("\n2 · elevation");
  ok("correction applied", ea.applied === true);
  ok("grid elevation read from archive (~787 ft)", Math.abs(ea.grid_elevation_ft - 787) < 3, `(${ea.grid_elevation_ft} ft)`);
  ok("site = base + 40% of vertical (1650 ft)", ea.site_elevation_ft === 1650, `(${ea.site_elevation_ft} ft)`);
  ok("temperatures shifted down", ea.temperature_shift_f < -2, `(${ea.temperature_shift_f}°F)`);
  ok("valley rain reclassified as mountain snow", ea.days_reclassified_to_snow > 0, `(${ea.days_reclassified_to_snow} days)`);

  console.log("\n3 · booking lead + weekend weighting");
  ok("lead derived from booking window (week → 3 days)", c.media_lead_days === 3);
  ok("weekly rows carry activation days", c.weekly.every((w) => "avg_activation_days" in w));
  // The whole point of the moving average: activation REDISTRIBUTES qualified
  // days forward, it does not manufacture them. Season totals must match.
  const totQual = c.weekly.reduce((t, w) => t + w.avg_qualified_ad_days, 0);
  const totAct = c.weekly.reduce((t, w) => t + w.avg_activation_days, 0);
  const drift = Math.abs(totAct - totQual) / totQual;
  ok("activation redistributes qualified days rather than inflating them", drift < 0.06,
    `(${totQual.toFixed(1)} qualified vs ${totAct.toFixed(1)} activation days, ${(drift * 100).toFixed(1)}% drift)`);
  ok("activation is shifted, not identical", c.weekly.some((w) => Math.abs(w.avg_activation_days - w.avg_qualified_ad_days) > 0.2));
  ok("weekly rows carry weekend qualified days", c.weekly.every((w) => "avg_qualified_weekend_days" in w));

  console.log("\n4 · per-market audience");
  ok("5 markets located", a.markets.length === 5, "(" + a.markets.map((m) => m.name).join(", ") + ")");
  ok("Atlantis flagged as not located", a.markets_not_located.includes("Atlantis"));
  ok("derived from distance", a.derived_from_distance === true);
  a.markets.forEach((m) =>
    console.log(`     ${m.name.padEnd(12)} ${String(m.drive_miles).padStart(4)} mi  ${String(m.drive_relevance_percent).padStart(3)}%  ` +
                `${m.households.toLocaleString().padStart(9)} HH  →  ${m.targeted_skiing_households.toLocaleString().padStart(7)} targeted`));
  const byName = (n) => a.markets.find((m) => m.name.toLowerCase() === n);
  const near = byName("pittsburgh");
  const far = byName("chicago");
  ok("closer market outranks distant one on relevance", near.drive_relevance_percent > far.drive_relevance_percent,
    `(${near.name} ${near.drive_relevance_percent}% vs ${far.name} ${far.drive_relevance_percent}%)`);
  ok("targeted households sum to the funnel",
    a.estimated_targeted_skiing_households === a.markets.reduce((t, m) => t + m.targeted_skiing_households, 0));

  console.log("\n5 · score rubric");
  const sc = r.weather_marketing_readiness;
  ok("score is 0–100", sc.score >= 0 && sc.score <= 100, `(${sc.score})`);
  ok("band named", !!sc.band, `(${sc.band})`);
  ok("4 published components", sc.components.length === 4);
  ok("components sum to the score", Math.abs(sc.components.reduce((t, x) => t + x.earned, 0) - sc.score) <= 2);

  console.log("\n6 · budget protection");
  console.log(`     always-on ${s.always_on_season_spend.toLocaleString()} → trigger ${s.modeled_trigger_controlled_spend.toLocaleString()} ` +
              `= protected $${s.estimated_budget_protected.toLocaleString()} (${s.estimated_budget_protected_percent}%)`);
  ok("activation floor held at the 35% default", s.minimum_activation_share_percent === 35);
  ok("activation share is weekend-weighted and lead-shifted", s.historical_activation_share_percent > 0);

  console.log("\n7 · media plan");
  b.channels.forEach((ch) => console.log(`     ${ch.channel.padEnd(22)} ${String(ch.share_percent).padStart(2)}%  $${String(ch.budget).padStart(5)}  → ${ch.impressions.toLocaleString()} imps`));
  ok("shares sum to 100%", Math.abs(b.channels.reduce((t, ch) => t + ch.share_percent, 0) - 100) <= 1);
  ok("four channels", b.channels.length === 4);
  ok("allocation sums exactly to the budget",
     b.channels.reduce((t, ch) => t + ch.budget, 0) === b.budget);
  ok("DOOH is a real line with a CPM",
     !!b.channels.find((ch) => ch.key === "dooh" && ch.budget > 0 && ch.cpm_assumption > 0));
  ok("no newspaper or news-site language anywhere in the report",
     !/newspaper|news site/i.test(JSON.stringify(r)));
  ok("campgrounds and state parks are geofence targets",
     r.recommended_targets.geofence_categories.some((g) => /campground/i.test(g)) &&
     r.recommended_targets.geofence_categories.some((g) => /state park/i.test(g)));
  ok("DOOH venues include bars, restaurants, gas stations, shopping",
     ["bar", "restaurant", "gas station", "shopping"].every((v) =>
       r.recommended_targets.dooh_venue_categories.some((d) => d.toLowerCase().includes(v))));
  ok("outdoor-recreation lookback is spelled out",
     r.recommended_targets.lookback_strategy.some((l) => /outdoor-recreation/i.test(l.name)));
  ok("8 triggers including freeze, frost, ice storm",
     r.trigger_plan.length === 8 &&
     ["Freeze Warning", "Frost Advisory", "Ice Storm"].every((n) => r.trigger_plan.some((t) => t.name === n)));
  ok("ice storm is protective, never an activation",
     r.trigger_plan.find((t) => t.name === "Ice Storm").priority === "Protective");
  const tiers = r.pricing_tiers.tiers;
  ok("three tiers, ascending", tiers.length === 3 && tiers[0].monthly < tiers[1].monthly && tiers[1].monthly < tiers[2].monthly);
  ok("better tier is the recommended one", tiers[1].recommended === true);
  ok("tier channel budgets sum to the tier price",
     tiers.every((t) => t.channels.reduce((a, c) => a + c.budget, 0) === t.monthly));
  ok("tier disclaimer says suggested + consult", /suggested budgets/i.test(r.pricing_tiers.disclaimer) && /consultation/i.test(r.pricing_tiers.disclaimer));
  ok("consult url set", r.consult_url === "https://smart1marketing.com/skimarketingconsult");
  ok("traditional comparison protects $0 vs plan",
     r.vs_traditional.rows.some((row) => row.traditional.indexOf("$0") === 0));
  ok("current media gaps surfaced", b.current_media_gaps.length >= 2);
  ok("paid social gap called out", b.current_media_gaps.some((g) => /social/i.test(g)));

  console.log("\n8 · forecast");
  ok("16 days returned", o.days.length === 16);
  ok("every day has a call", o.days.every((d) => d.call && d.call.length));
  ok("forecast is elevation-adjusted too", o.elevation_adjusted === true);
  console.log(`     ${o.qualified_days} qualified · ${o.activation_days} in market · ${o.suppressed_days} suppressed`);

  console.log("\n10 · no-snowmaking resort");
  const noSnow = await post({ snowmaking: "no", booking_window: "season" }, "b@x.com");
  const n = noSnow.data.report;
  ok("snowmaking window not counted as a trigger", /do(es)? not make snow/.test(n.climate.qualified_day_definition));
  ok("form-sent floor of 35% wins over the booking default", n.savings_model.minimum_activation_share_percent === 35);
  ok("trigger renamed to Cold Preservation", n.trigger_plan.some((t) => t.name === "Cold Preservation Window"));

  console.log("\n9 · abuse guards");
  const bot = await post({ s1_qx7: "http://spam.example" }, "bot@x.com");
  ok("honeypot rejected", bot.status === 400);

  const fast = await realFetch("http://127.0.0.1:10999/api/analyze", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...BODY, form_elapsed_ms: 500, contact_email: "fast@x.com" })
  });
  ok("sub-5-second submission rejected", fast.status === 400);

  const dupe = await post({});
  ok("duplicate submission deduplicated", dupe.data.deduplicated === true);

  let limited = false;
  for (let i = 0; i < 8; i++) {
    const res = await post({}, `burst${i}@x.com`);
    if (res.status === 429) { limited = true; break; }
  }
  ok("rate limit trips on a burst", limited);


  console.log(fails.length ? `\n✗ ${fails.length} failing\n` : "\n✓ all checks passed\n");
  require("fs").writeFileSync("test/.report.json", JSON.stringify(r, null, 2));
  process.exit(fails.length ? 1 : 0);
}, 400);
