"use strict";

const cache = require("./cache");
const { M_TO_FT } = require("./geo");

const num = (v, f = 0) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : f);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const one = (v) => Math.round(v * 10) / 10;

const SEASONS_TO_ANALYZE = 6;

/* ---------------------------------------------------------------- tuning */
/* Every threshold the model uses lives here. Recalibrating the product means
   editing this block and nothing else. */

const RULES = {
  POWDER_IN: 4,             // a powder day
  FRESH_SNOW_IN: 1,         // meaningful natural snowfall
  SNOWMAKING_MIN_F: 28,     // overnight low at or below this
  SNOWMAKING_MAX_F: 38,     // daytime high at or below this
  BLUEBIRD_PRIOR_SNOW_IN: 3,
  BLUEBIRD_SUN_HOURS: 5,
  BLUEBIRD_MAX_F: 40,
  RAIN_IN: 0.25,            // meaningful rain...
  RAIN_ABOVE_F: 34,         // ...when it is warm enough to be rain
  WIND_MPH: 30,
  DAMAGING_WARMTH_F: 45,
  SNOW_LINE_F: 34,          // above this, precipitation falls as rain
  SNOW_RATIO: 7,            // Open-Meteo derives snow depth at 7:1
  LAPSE_F_PER_1000FT: 3.5,  // environmental lapse rate
  WEEKEND_WEIGHT: 2,        // a qualified Saturday is worth two qualified Tuesdays
  WEEKDAY_WEIGHT: 1,
  MAX_LOOKAHEAD_DAYS: 5     // ceiling on the media lead window
};

/* Media has to be in market before the guest decides. The booking window tells
   us how far before. A season-pass buyer is not booking off a Thursday storm,
   so long windows get a shorter trigger overlay and a higher always-on floor. */

const BOOKING = {
  same_day:  { lead: 1,  floor: 25, label: "same day or next day" },
  week:      { lead: 3,  floor: 35, label: "within a week" },
  month:     { lead: 5,  floor: 50, label: "two to four weeks out" },
  season:    { lead: 5,  floor: 60, label: "season-long, booked in advance" }
};

const bookingProfile = (key) => BOOKING[String(key)] || BOOKING.week;

/* --------------------------------------------------------- unit handling */
/* Do not assume. Open-Meteo reports snowfall in centimetres by default, and a
   silent cm-for-inches swap would inflate every snowfall figure by 2.54 and
   fire the powder trigger on an inch and a half. Read the units the API says
   it sent and convert from those. */

function converters(units = {}) {
  const u = (k) => String(units[k] || "").toLowerCase();

  const temp = u("temperature_2m_max").includes("c") && !u("temperature_2m_max").includes("f")
    ? (v) => v * 9 / 5 + 32
    : (v) => v;

  const snowUnit = u("snowfall_sum");
  const snow = snowUnit.includes("cm") ? (v) => v * 0.393701
    : snowUnit.includes("mm") ? (v) => v * 0.0393701
    : (v) => v;

  const precipUnit = u("rain_sum") || u("precipitation_sum");
  const precip = precipUnit.includes("mm") ? (v) => v * 0.0393701 : (v) => v;

  const windUnit = u("wind_speed_10m_max");
  const wind = windUnit.includes("km") ? (v) => v * 0.621371
    : windUnit.includes("m/s") ? (v) => v * 2.23694
    : windUnit.includes("kn") ? (v) => v * 1.15078
    : (v) => v;

  return {
    temp, snow, precip, wind,
    reported: {
      temperature: units.temperature_2m_max || "unknown",
      snowfall: units.snowfall_sum || "unknown",
      rain: units.rain_sum || "unknown",
      wind: units.wind_speed_10m_max || "unknown"
    }
  };
}

/* --------------------------------------------------- elevation correction */
/* The archive is a coarse grid. Its cell elevation is usually the valley, not
   the mountain, and a thousand feet is three to five degrees — precisely the
   margin between a snowmaking window and a rain event. Correct the
   temperatures, then re-partition precipitation, because valley rain is
   mountain snow. */

function elevationAdjuster(gridElevationM, siteElevationFt) {
  const gridFt = Number.isFinite(gridElevationM) ? gridElevationM * M_TO_FT : null;
  const applies = Number.isFinite(gridFt) && Number.isFinite(siteElevationFt) &&
    Math.abs(siteElevationFt - gridFt) >= 150;

  const deltaFt = applies ? siteElevationFt - gridFt : 0;
  const shiftF = applies ? -RULES.LAPSE_F_PER_1000FT * (deltaFt / 1000) : 0;

  return {
    applies,
    grid_elevation_ft: Number.isFinite(gridFt) ? Math.round(gridFt) : null,
    site_elevation_ft: Number.isFinite(siteElevationFt) ? Math.round(siteElevationFt) : null,
    delta_ft: Math.round(deltaFt),
    temperature_shift_f: one(shiftF),
    lapse_rate_f_per_1000ft: RULES.LAPSE_F_PER_1000FT,
    shiftF
  };
}

function adjustDay(raw, adj) {
  const maxT = raw.maxT + adj.shiftF;
  const minT = raw.minT + adj.shiftF;

  let snowfall = raw.snowfall;
  let rain = raw.rain;
  let repartitioned = false;

  if (adj.applies && adj.shiftF < 0 && rain > 0 && maxT <= RULES.SNOW_LINE_F) {
    // It rained in the valley and snowed on the hill.
    snowfall += rain * RULES.SNOW_RATIO;
    rain = 0;
    repartitioned = true;
  } else if (adj.applies && adj.shiftF > 0 && snowfall > 0 && maxT > RULES.SNOW_LINE_F + 4) {
    // The site is warmer than the grid cell. Rare, but handle it honestly.
    rain += snowfall / RULES.SNOW_RATIO;
    snowfall = 0;
    repartitioned = true;
  }

  return { ...raw, maxT, minT, snowfall, rain, repartitioned };
}

/* ------------------------------------------------------------- day flags */

function flagDay(day, makesSnow) {
  // Triggers — a reason for the resort to have something to say.
  const powder = day.snowfall >= RULES.POWDER_IN;
  const freshSnow = day.snowfall >= RULES.FRESH_SNOW_IN;
  const snowmakingWindow = day.minT <= RULES.SNOWMAKING_MIN_F && day.maxT <= RULES.SNOWMAKING_MAX_F;
  const bluebird =
    (day.priorSnow >= RULES.BLUEBIRD_PRIOR_SNOW_IN || day.prior2Snow >= RULES.POWDER_IN) &&
    day.sunshineHours >= RULES.BLUEBIRD_SUN_HOURS &&
    day.maxT <= RULES.BLUEBIRD_MAX_F;

  // Guards — conditions that must hold for any trigger to count.
  const rainRisk = day.rain >= RULES.RAIN_IN && day.maxT > RULES.RAIN_ABOVE_F;
  const windRisk = day.wind >= RULES.WIND_MPH;
  const damagingWarmth = day.maxT >= RULES.DAMAGING_WARMTH_F;

  // A resort with no snowmaking earns nothing from a cold night. It needs
  // natural snow, so a snowmaking window is not a reason to advertise.
  const snowmakingCounts = makesSnow && snowmakingWindow;
  const hasTrigger = powder || freshSnow || bluebird || snowmakingCounts;

  const triggers = [];
  if (powder) triggers.push("Powder Alert");
  else if (freshSnow) triggers.push("Fresh snow");
  if (bluebird) triggers.push("Bluebird Window");
  if (snowmakingCounts) triggers.push(makesSnow ? "Snowmaking Window" : "Cold Preservation Window");
  if (rainRisk) triggers.push("Rain suppression");
  if (windRisk) triggers.push("High-wind suppression");
  if (damagingWarmth) triggers.push("Warmth suppression");

  const dow = new Date(`${day.date}T12:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
  const isWeekend = dow === 5 || dow === 6 || dow === 0;     // ski weekend is Fri–Sun

  return {
    ...day,
    cold: day.maxT <= 32 || day.minT <= 20,
    powder,
    freshSnow,
    snowmaking: snowmakingWindow,
    bluebird,
    rainRisk,
    windRisk,
    damagingWarmth,
    isWeekend,
    demandWeight: isWeekend ? RULES.WEEKEND_WEIGHT : RULES.WEEKDAY_WEIGHT,
    qualified: hasTrigger && !rainRisk && !windRisk && !damagingWarmth,
    suppressed: rainRisk || windRisk || damagingWarmth,
    trigger_names: triggers
  };
}

/* --------------------------------------------------- the media lead shift */
/* A qualified day is when conditions are good. The advertising has to already
   be running by then, so the signal is shifted forward by the booking window.

   This is a forward-looking *moving average*, not "any qualified day in the
   window". The boolean version inflates: if 60% of days qualify, then at least
   one of any four consecutive days qualifies about 97% of the time, activation
   creeps to 100%, and the savings model collapses for arithmetic reasons
   rather than weather reasons. A moving average has the same mean as the
   series underneath it — it moves when you should be in market without
   inventing days that were not there. */

function markActivation(days, leadDays) {
  const lead = clamp(leadDays, 1, RULES.MAX_LOOKAHEAD_DAYS);
  return days.map((day, i) => {
    let hits = 0, seen = 0;
    for (let k = 0; k <= lead && i + k < days.length; k++) {
      seen++;
      if (days[i + k].qualified) hits++;
    }
    const strength = seen ? hits / seen : 0;
    return {
      ...day,
      activation_strength: strength,   // 0–1: how much of the booking window qualifies
      activation: strength >= 0.5      // enough of it to run acquisition
    };
  });
}

/* ------------------------------------------------------------- the window */

function seasonWindow(startMonth, endMonth) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  // The most recently *completed* season. In July, a November–March season
  // finished in March of this year, so that season must be included.
  const lastEndYear = month > endMonth ? year : year - 1;
  const startYear = lastEndYear - SEASONS_TO_ANALYZE;
  const finalDay = new Date(Date.UTC(lastEndYear, endMonth, 0)).getUTCDate();

  return {
    start: `${startYear}-${String(startMonth).padStart(2, "0")}-01`,
    end: `${lastEndYear}-${String(endMonth).padStart(2, "0")}-${String(finalDay).padStart(2, "0")}`
  };
}

const DAILY_VARS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "snowfall_sum",
  "rain_sum",
  "precipitation_sum",
  "wind_speed_10m_max",
  "sunshine_duration"
].join(",");

function rawDays(daily, conv) {
  const dates = daily.time || [];
  return dates.map((date, i) => {
    const snow = conv.snow(num(daily.snowfall_sum?.[i]));
    return {
      date,
      maxT: conv.temp(num(daily.temperature_2m_max?.[i], 99)),
      minT: conv.temp(num(daily.temperature_2m_min?.[i], 99)),
      snowfall: snow,
      rain: conv.precip(num(daily.rain_sum?.[i])),
      wind: conv.wind(num(daily.wind_speed_10m_max?.[i])),
      sunshineHours: num(daily.sunshine_duration?.[i]) / 3600,
      priorSnow: i > 0 ? conv.snow(num(daily.snowfall_sum?.[i - 1])) : 0,
      prior2Snow: i > 1 ? conv.snow(num(daily.snowfall_sum?.[i - 2])) : 0
    };
  });
}

/* ------------------------------------------------------- historical model */

async function history(site, opts) {
  const { startMonth, endMonth, makesSnow, bookingWindow } = opts;
  const { start, end } = seasonWindow(startMonth, endMonth);
  const lead = bookingProfile(bookingWindow).lead;

  const key = `arch:${site.latitude.toFixed(3)},${site.longitude.toFixed(3)}:${start}:${end}`;
  const payload = await cache.remember(key, cache.TTL.ARCHIVE, async () => {
    const url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.searchParams.set("latitude", site.latitude);
    url.searchParams.set("longitude", site.longitude);
    url.searchParams.set("start_date", start);
    url.searchParams.set("end_date", end);
    url.searchParams.set("daily", DAILY_VARS);
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("wind_speed_unit", "mph");
    url.searchParams.set("precipitation_unit", "inch");
    url.searchParams.set("timezone", "auto");

    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Historical climate lookup failed (${response.status}).`);
    return response.json();
  });

  const conv = converters(payload.daily_units);
  const adj = elevationAdjuster(payload.elevation, site.site_elevation_ft);
  const crossesYear = endMonth < startMonth;
  const inSeason = (m) => (crossesYear ? m >= startMonth || m <= endMonth : m >= startMonth && m <= endMonth);

  const all = rawDays(payload.daily || {}, conv)
    .map((d) => adjustDay(d, adj))
    .map((d) => flagDay(d, makesSnow));

  let repartitionedDays = 0;
  const seasons = {};
  all.forEach((day) => {
    const dt = new Date(`${day.date}T12:00:00Z`);
    const month = dt.getUTCMonth() + 1;
    if (!inSeason(month)) return;
    if (day.repartitioned) repartitionedDays++;

    const seasonYear = crossesYear && month <= endMonth ? dt.getUTCFullYear() - 1 : dt.getUTCFullYear();
    seasons[seasonYear] ||= { season: seasonYear, days: [] };
    seasons[seasonYear].days.push(day);
  });

  const seasonRows = Object.values(seasons).filter((s) => s.days.length >= 21);
  if (!seasonRows.length) throw new Error("Not enough historical season data was returned for this location.");

  seasonRows.forEach((s) => {
    s.days.sort((a, b) => a.date.localeCompare(b.date));
    s.days = markActivation(s.days, lead);
  });

  /* --- weekly rollup, averaging the same week across seasons ------------ */

  const buckets = {};
  seasonRows.forEach((s) =>
    s.days.forEach((day, i) => {
      const week = Math.floor(i / 7) + 1;
      (buckets[week] ||= []).push({ ...day, season: s.season });
    })
  );

  const minSeasons = Math.max(2, Math.ceil(seasonRows.length / 2));

  const weekly = Object.entries(buckets)
    .map(([week, days]) => ({ week: Number(week), days, seasons: new Set(days.map((d) => d.season)).size }))
    .filter((r) => r.seasons >= minSeasons)
    .sort((a, b) => a.week - b.week)
    .map(({ week, days, seasons: n }) => {
      const per = (key) =>
        days.reduce((t, d) => t + (typeof d[key] === "boolean" ? (d[key] ? 1 : 0) : num(d[key])), 0) / n;

      // Weekend-weighted activation. A qualified Saturday is worth two
      // qualified Tuesdays, because that is how the mountain actually sells.
      const weightTotal = days.reduce((t, d) => t + d.demandWeight, 0);
      const weightActive = days.reduce((t, d) => t + d.activation_strength * d.demandWeight, 0);
      const score = weightTotal ? clamp(Math.round((weightActive / weightTotal) * 100), 0, 100) : 0;

      const weekendDays = days.filter((d) => d.isWeekend);
      const weekendQualified = weekendDays.length
        ? (weekendDays.filter((d) => d.qualified).length / n)
        : 0;

      return {
        week_number: week,
        seasons_with_data: n,
        avg_qualified_ad_days: one(per("qualified")),
        avg_qualified_weekend_days: one(weekendQualified),
        avg_activation_days: one(per("activation_strength")),
        avg_suppressed_days: one(per("suppressed")),
        avg_snowfall_inches: one(per("snowfall")),
        avg_snowmaking_days: one(per("snowmaking")),
        avg_powder_days: one(per("powder")),
        avg_bluebird_days: one(per("bluebird")),
        avg_rain_risk_days: one(per("rainRisk")),
        avg_wind_risk_days: one(per("windRisk")),
        activation_score: score,
        recommendation:
          score >= 60 ? "Aggressive activation" :
          score >= 35 ? "Selective activation" :
                        "Hold or use future-date offers"
      };
    });

  const avgSeason = (key) =>
    seasonRows.reduce(
      (t, s) => t + s.days.reduce((a, d) => a + (typeof d[key] === "boolean" ? (d[key] ? 1 : 0) : num(d[key])), 0),
      0
    ) / seasonRows.length;

  // Season-wide weighted activation share — this is what the savings model uses.
  const everyDay = seasonRows.flatMap((s) => s.days);
  const wTotal = everyDay.reduce((t, d) => t + d.demandWeight, 0);
  const wActive = everyDay.reduce((t, d) => t + d.activation_strength * d.demandWeight, 0);

  return {
    seasons_analyzed: seasonRows.length,
    season_years: seasonRows.map((s) => `${s.season}–${String(s.season + (crossesYear ? 1 : 0)).slice(2)}`),
    history_window: { start, end },
    avg_season_days: Math.round(seasonRows.reduce((a, s) => a + s.days.length, 0) / seasonRows.length),
    avg_cold_days: Math.round(avgSeason("cold")),
    avg_snowmaking_days: Math.round(avgSeason("snowmaking")),
    avg_powder_days: one(avgSeason("powder")),
    avg_bluebird_days: one(avgSeason("bluebird")),
    avg_rain_risk_days: Math.round(avgSeason("rainRisk")),
    avg_high_wind_days: Math.round(avgSeason("windRisk")),
    avg_natural_snowfall_inches: Math.round(avgSeason("snowfall")),
    avg_qualified_ad_days: Math.round(avgSeason("qualified")),
    avg_suppressed_days: Math.round(avgSeason("suppressed")),
    weighted_activation_share: wTotal ? clamp(wActive / wTotal, 0, 1) : 0,
    total_season_weeks: weekly.length,
    weekly,
    resort_makes_snow: makesSnow,
    media_lead_days: lead,
    booking_window_label: bookingProfile(bookingWindow).label,
    units_reported_by_source: conv.reported,
    elevation_adjustment: {
      applied: adj.applies,
      grid_elevation_ft: adj.grid_elevation_ft,
      site_elevation_ft: adj.site_elevation_ft,
      delta_ft: adj.delta_ft,
      temperature_shift_f: adj.temperature_shift_f,
      lapse_rate_f_per_1000ft: adj.lapse_rate_f_per_1000ft,
      days_reclassified_to_snow: repartitionedDays,
      note: adj.applies
        ? `The weather grid cell sits at ${adj.grid_elevation_ft} ft and the resort at ${adj.site_elevation_ft} ft. Temperatures were shifted ${adj.temperature_shift_f}°F using a ${RULES.LAPSE_F_PER_1000FT}°F per 1,000 ft lapse rate, and ${repartitionedDays} days of valley rain were reclassified as snow on the hill.`
        : "No elevation correction was applied. Supply the resort's base elevation to correct for the difference between the weather grid cell and the mountain."
    },
    qualified_day_definition: [
      "The day carried at least one trigger:",
      `natural snowfall of ${RULES.FRESH_SNOW_IN} inch or more (${RULES.POWDER_IN} inches or more counts as a powder day)`,
      makesSnow
        ? `, a snowmaking window (low at or below ${RULES.SNOWMAKING_MIN_F}°F and high at or below ${RULES.SNOWMAKING_MAX_F}°F)`
        : " (snowmaking windows are not counted, because this resort does not make snow)",
      `, or a post-storm bluebird day (recent snow, ${RULES.BLUEBIRD_SUN_HOURS}+ hours of sun, high at or below ${RULES.BLUEBIRD_MAX_F}°F).`,
      `And nothing spoiled it: no meaningful rain (${RULES.RAIN_IN} in or more above ${RULES.RAIN_ABOVE_F}°F), no high wind (${RULES.WIND_MPH} mph or more), and no damaging warmth (high at or above ${RULES.DAMAGING_WARMTH_F}°F).`,
      "Cold, calm weather on its own is not a qualified day. It is a condition that has to hold, not a reason to advertise."
    ].join(" "),
    activation_definition:
      `Media has to be running before the guest decides. With a booking window of "${bookingProfile(bookingWindow).label}", each day is scored on how much of the following ${lead}-day window qualifies, which shifts spending forward without inventing extra days. Weekend days carry ${RULES.WEEKEND_WEIGHT}× the weight of weekdays, because that is when the mountain sells.`,
    rules: RULES
  };
}

/* ------------------------------------------------------------- forecast */
/* The whole product is "we activate on weather." A model that only looks
   backward cannot prove that. This runs the same triggers over the next 16
   days so the report ends with something live. */

async function forecast(site, opts) {
  const { makesSnow, bookingWindow } = opts;
  const lead = bookingProfile(bookingWindow).lead;

  const key = `fc:${site.latitude.toFixed(3)},${site.longitude.toFixed(3)}`;
  const payload = await cache.remember(key, cache.TTL.FORECAST, async () => {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", site.latitude);
    url.searchParams.set("longitude", site.longitude);
    url.searchParams.set("daily", DAILY_VARS);
    url.searchParams.set("forecast_days", "16");
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("wind_speed_unit", "mph");
    url.searchParams.set("precipitation_unit", "inch");
    url.searchParams.set("timezone", "auto");

    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Forecast lookup failed (${response.status}).`);
    return response.json();
  });

  const conv = converters(payload.daily_units);
  const adj = elevationAdjuster(payload.elevation, site.site_elevation_ft);

  const days = markActivation(
    rawDays(payload.daily || {}, conv).map((d) => adjustDay(d, adj)).map((d) => flagDay(d, makesSnow)),
    lead
  );

  const qualified = days.filter((d) => d.qualified).length;
  const suppressed = days.filter((d) => d.suppressed).length;
  const activation = days.filter((d) => d.activation && !d.suppressed).length;

  return {
    generated_for: `${site.latitude.toFixed(3)}, ${site.longitude.toFixed(3)}`,
    days_ahead: days.length,
    qualified_days: qualified,
    suppressed_days: suppressed,
    activation_days: activation,
    elevation_adjusted: adj.applies,
    days: days.map((d) => ({
      date: d.date,
      weekday: new Date(`${d.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
      is_weekend: d.isWeekend,
      high_f: Math.round(d.maxT),
      low_f: Math.round(d.minT),
      snowfall_inches: one(d.snowfall),
      rain_inches: one(d.rain),
      wind_mph: Math.round(d.wind),
      qualified: d.qualified,
      suppressed: d.suppressed,
      activation: d.activation,
      triggers: d.trigger_names,
      activation_strength: Math.round(d.activation_strength * 100),
      call: d.suppressed
        ? "Suppress visit-now. Run future-date offers."
        : d.activation
          ? (d.qualified ? "Run acquisition. Conditions qualify today." : "Run acquisition. Most of the booking window qualifies.")
          : d.activation_strength > 0
            ? "Ramp up. Part of the booking window qualifies."
            : "Hold acquisition. Nothing to say yet."
    })),
    note:
      "A 16-day forecast is directional and degrades badly past about a week. This shows what the trigger rules would have done, not what the campaign will do. Verify against the resort's own forecast provider, snow report, and lift status before any activation."
  };
}

module.exports = { history, forecast, bookingProfile, RULES, BOOKING };
