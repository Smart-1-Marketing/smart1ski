"use strict";

const geo = require("./geo");
const { bookingProfile } = require("./weather");

const CONSULT_URL = "https://smart1marketing.com/skimarketingconsult";

const num = (v, f = 0) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : f);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v) => Math.round(v);

const listify = (v) => String(v || "").split(/\n|,|;/).map((s) => s.trim()).filter(Boolean);

/* ------------------------------------------------- readiness score rubric */
/* The old score was five hand-tuned clamps producing a number between 25 and
   95 that nobody could explain. A client asks what 83 means and there has to
   be an answer. Four published components, 100 points, named bands. */

const BANDS = [
  { min: 75, label: "Strong weather-trigger market", meaning: "Conditions vary enough to time media against, and there are enough good days to spend into." },
  { min: 55, label: "Workable weather-trigger market", meaning: "The trigger model earns its keep, but a baseline always-on layer is still needed." },
  { min: 35, label: "Marginal weather-trigger market", meaning: "Weather timing helps at the margins. Lean on passes, lodging, and future-date offers." },
  { min: 0,  label: "Weak weather-trigger market", meaning: "Too few qualified days to build a campaign around weather. Sell the destination, not the snow report." }
];

function readiness(climate) {
  const makesSnow = climate.resort_makes_snow;
  const seasonDays = climate.avg_season_days || 1;

  const supply =
    clamp(num(climate.avg_natural_snowfall_inches) / 60, 0, 1) * 18 +
    clamp(num(climate.avg_powder_days) / 10, 0, 1) * 12;

  const production = makesSnow
    ? clamp(num(climate.avg_snowmaking_days) / 60, 0, 1) * 25
    : clamp(num(climate.avg_natural_snowfall_inches) / 80, 0, 1) * 25;

  const quality = clamp(num(climate.avg_bluebird_days) / 12, 0, 1) * 20;

  const suppressedShare = clamp(num(climate.avg_suppressed_days) / seasonDays, 0, 1);
  const reliability = (1 - clamp(suppressedShare * 3, 0, 1)) * 25;

  const score = round(clamp(supply + production + quality + reliability, 0, 100));
  const band = BANDS.find((b) => score >= b.min);

  return {
    score,
    band: band.label,
    band_meaning: band.meaning,
    components: [
      { name: "Snow supply", earned: round(supply), out_of: 30, detail: `${climate.avg_natural_snowfall_inches}" average season snowfall, ${climate.avg_powder_days} powder days` },
      { name: makesSnow ? "Snow production" : "Natural reliance", earned: round(production), out_of: 25, detail: makesSnow ? `${climate.avg_snowmaking_days} snowmaking days per season` : "No snowmaking — scored on natural snowfall alone" },
      { name: "Condition quality", earned: round(quality), out_of: 20, detail: `${climate.avg_bluebird_days} bluebird days per season` },
      { name: "Weather reliability", earned: round(reliability), out_of: 25, detail: `${climate.avg_suppressed_days} suppressed days per season out of ${seasonDays}` }
    ],
    scale: BANDS.map((b) => ({ from: b.min, label: b.label }))
  };
}

/* ------------------------------------------------------------ media plan */

const CPMS = { ctv: 35, display: 12, audio: 20, dooh: 22 };

const OBJECTIVE_SHARES = {
  lift_tickets:  { ctv: 0.36, display: 0.30, audio: 0.22, dooh: 0.12 },
  season_passes: { ctv: 0.40, display: 0.30, audio: 0.22, dooh: 0.08 },
  lodging:       { ctv: 0.42, display: 0.30, audio: 0.18, dooh: 0.10 },
  local_visits:  { ctv: 0.28, display: 0.32, audio: 0.24, dooh: 0.16 }
};

const OBJECTIVE_WHY = {
  lift_tickets: "Lift tickets are urgent and weather-sensitive. CTV builds awareness, data-driven display carries frequency and response, streaming audio delivers urgency in the car, and DOOH catches the weekend decision as it is being made.",
  season_passes: "Season passes need broad awareness, advance consideration, and repeated visual storytelling, so CTV carries more weight and DOOH carries less.",
  lodging: "Lodging is a longer consideration purchase with strong visual destination appeal, so CTV and display carry the plan.",
  local_visits: "Local visits and tubing are a weekend decision made close to home, so display, streaming audio, and DOOH at the bars, restaurants, and shopping areas people are already standing in carry more of the weight."
};

/* Resort type was collected and never used. A destination resort selling to
   people four hours away is not running the same mix as a tubing hill. */

const TYPE_TILT = {
  destination:        { ctv:  0.06, display: -0.02, audio: -0.02, dooh: -0.02, why: "A destination resort is selling a trip, not an afternoon, so more weight goes to the big screen and less to out-of-home near the mountain." },
  regional_overnight: { ctv:  0.00, display:  0.00, audio:  0.00, dooh:  0.00, why: "A regional resort with lodging sits in the middle of the mix." },
  day_drive:          { ctv: -0.06, display:  0.02, audio:  0.02, dooh:  0.02, why: "A day-drive resort competes on immediacy, so frequency, in-car audio, and out-of-home pull ahead of the big screen." },
  tubing_focus:       { ctv: -0.08, display:  0.02, audio:  0.03, dooh:  0.03, why: "A tubing and beginner hill sells a weekend decision to a local family, so response and out-of-home channels lead." }
};

// A resort can sell lift tickets AND season passes AND lodging, and can be a
// day-drive hill that also takes overnight guests. Blend the picks rather than
// forcing one.
function picks(value, table, fallback) {
  const chosen = String(value || "")
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter((s) => table[s]);
  return chosen.length ? chosen : [fallback];
}

const CHANNEL_KEYS = ["ctv", "display", "audio", "dooh"];

function blend(keys, table) {
  const sum = { ctv: 0, display: 0, audio: 0, dooh: 0 };
  keys.forEach((k) => CHANNEL_KEYS.forEach((c) => { sum[c] += table[k][c]; }));
  const out = {};
  CHANNEL_KEYS.forEach((c) => { out[c] = sum[c] / keys.length; });
  return out;
}

function budgetPlan(body) {
  const budget = clamp(num(body.monthly_budget, 6000), 2500, 100000);
  const objectives = picks(body.campaign_objective, OBJECTIVE_SHARES, "lift_tickets");
  const types = picks(body.resort_type, TYPE_TILT, "regional_overnight");

  const base = blend(objectives, OBJECTIVE_SHARES);
  const tilt = blend(types, TYPE_TILT);

  // DOOH floors lower than the others: it is a supporting line, not a lead line.
  const FLOOR = { ctv: 0.15, display: 0.15, audio: 0.12, dooh: 0.05 };
  const raw = {};
  CHANNEL_KEYS.forEach((c) => { raw[c] = clamp(base[c] + tilt[c], FLOOR[c], 0.60); });

  const total = CHANNEL_KEYS.reduce((a, c) => a + raw[c], 0);
  const shares = {};
  CHANNEL_KEYS.forEach((c) => { shares[c] = raw[c] / total; });

  const allocation = {};
  const impressions = {};
  CHANNEL_KEYS.forEach((c) => {
    allocation[c] = round(budget * shares[c]);
    impressions[c] = round((allocation[c] / CPMS[c]) * 1000);
  });

  // Rounding each channel independently can drift a few dollars off the budget.
  // Put the difference back into the largest line so the plan always sums.
  const drift = budget - CHANNEL_KEYS.reduce((a, c) => a + allocation[c], 0);
  if (drift !== 0) {
    const biggest = CHANNEL_KEYS.reduce((a, c) => (allocation[c] > allocation[a] ? c : a), "ctv");
    allocation[biggest] += drift;
    impressions[biggest] = round((allocation[biggest] / CPMS[biggest]) * 1000);
  }

  /* Current paid media was collected and never used. Say something about it. */
  const current = String(body.current_media || "").trim();
  const mentions = (re) => re.test(current.toLowerCase());
  const gaps = [];
  if (current) {
    if (mentions(/social|facebook|meta|instagram|tiktok/)) {
      gaps.push("Paid social is running today and is not part of this plan. It is excluded from this package by design, so treat this budget as additive rather than a replacement.");
    }
    if (mentions(/search|sem|google ads|adwords|ppc/)) {
      gaps.push("Paid search is running today and is not part of this plan. Search captures demand that already exists; the channels here create it.");
    }
    if (!mentions(/ctv|connected|streaming|ott|roku|hulu/)) {
      gaps.push("No Connected TV appears in the current media. That is the largest single line in this plan and the biggest change from what is running today.");
    }
    if (!mentions(/audio|spotify|podcast|pandora|streaming radio/)) {
      gaps.push("No streaming audio or podcast buy appears in the current media. It is the channel that reaches drive-market guests while they are actually in the car.");
    }
    if (!mentions(/dooh|out-of-home|out of home|ooh|billboard|digital board/)) {
      gaps.push("No digital out-of-home appears in the current media. DOOH at bars, restaurants, gas stations, and shopping areas reaches the weekend decision where it is made.");
    }
    if (mentions(/newspaper|print|circular|insert/)) {
      gaps.push("Print is running today and is not part of this plan. It cannot be triggered by weather, cannot be targeted to a skiing-household audience, and cannot be measured against visitation. This plan replaces that spend rather than adding to it.");
    }
  }

  return {
    budget,
    objective: objectives.join(","),
    objectives,
    resort_type: types.join(","),
    resort_types: types,
    objective_rationale: objectives.length === 1
      ? OBJECTIVE_WHY[objectives[0]]
      : "The mix is blended across every objective selected. " +
        objectives.map((o) => OBJECTIVE_WHY[o]).join(" "),
    resort_type_rationale: types.length === 1
      ? TYPE_TILT[types[0]].why
      : "The mix is blended across every resort type selected. " +
        types.map((t) => TYPE_TILT[t].why).join(" "),
    allocation,
    impressions,
    channels: [
      {
        key: "ctv", channel: "Connected TV", budget: allocation.ctv,
        cpm_assumption: CPMS.ctv, impressions: impressions.ctv,
        share_percent: round(shares.ctv * 100),
        role: "Builds awareness and emotional demand on the largest screen in the home — fresh snow, mountain scenery, family skiing, lodging, terrain openings — aimed at skiing households in the feeder markets during qualified weather windows."
      },
      {
        key: "display", channel: "Data-Driven Targeted Display", budget: allocation.display,
        cpm_assumption: CPMS.display, impressions: impressions.display,
        share_percent: round(shares.display * 100),
        role: "Delivered against the built audience — visitation segments, skiing households, and site retargeting — not against a publisher list. Carries snow-condition messages, lift-ticket and lodging offers, and date-sensitive promotions. Lowest planning CPM, so it delivers the most impressions."
      },
      {
        key: "audio", channel: "Streaming Radio and Podcasts", budget: allocation.audio,
        cpm_assumption: CPMS.audio, impressions: impressions.audio,
        share_percent: round(shares.audio * 100),
        role: "Streaming music and podcast inventory, reaching drive-market guests while they are in the car and outdoor and travel podcast audiences at home. Companion banners add a clickable response path."
      },
      {
        key: "dooh", channel: "Digital Out-of-Home", budget: allocation.dooh,
        cpm_assumption: CPMS.dooh, impressions: impressions.dooh,
        share_percent: round(shares.dooh * 100),
        role: "Screens at bars, restaurants, gas stations, and shopping areas in the feeder markets — where the weekend plan actually gets made. Runs on the same weather triggers as everything else, so a powder alert reaches people who are already out."
      }
    ],
    current_media: current,
    current_media_gaps: gaps,
    delivery_variance_factors: ["Market", "Audience size", "Inventory", "Frequency limits", "Campaign timing", "Data costs", "Geography", "Seasonal demand"],
    excluded_channels: ["Paid search", "Paid social"],
    note: "Paid search and paid social are intentionally excluded from this package. Delivery estimates use planning CPM assumptions and will vary by market, inventory, targeting, and campaign dates."
  };
}

/* ------------------------------------------------------ budget protection */

function savingsModel(body, climate, plan) {
  const seasonWeeks = climate.total_season_weeks || clamp(num(body.season_weeks, 20), 8, 30);
  const weeklyBudget = plan.budget / 4.345;
  const alwaysOn = round(weeklyBudget * seasonWeeks);
  const weekly = climate.weekly || [];

  // Weekend-weighted and lead-shifted. This is the share of the season during
  // which media should actually have been in market.
  const activationShareRaw = num(climate.weighted_activation_share, 0.62);

  // The floor is not arbitrary: a resort whose guests book a month ahead
  // cannot run a pure trigger campaign, so its floor is higher.
  const profile = bookingProfile(body.booking_window);
  const enteredFloor = num(body.minimum_activation_share, NaN);
  const floor = clamp(Number.isFinite(enteredFloor) ? enteredFloor : profile.floor, 15, 80) / 100;

  const activationShare = clamp(Math.max(activationShareRaw, floor), floor, 0.92);
  const triggerSpend = round(alwaysOn * activationShare);
  const protectedBudget = Math.max(0, alwaysOn - triggerSpend);
  const protectedPercent = alwaysOn ? round((protectedBudget / alwaysOn) * 100) : 0;

  /* Say the honest thing. Some mountains are cold and reliable and simply do
     not waste much media. On those, the trigger model is worth buying for the
     timing, not the savings, and a salesperson should not be handed a number
     that invites them to promise otherwise. */

  const capBinding = activationShareRaw > 0.92;
  const floorBinding = activationShareRaw < floor;

  let verdict;
  if (protectedPercent >= 25) {
    verdict = `This season wastes a lot of media. Roughly ${protectedPercent}% of an always-on budget lands in weeks that historically could not support a visit-now message. Budget protection is the strongest part of this plan.`;
  } else if (protectedPercent >= 12) {
    verdict = `There is real but moderate waste here. Around ${protectedPercent}% of an always-on budget could be held or moved. Timing matters more than the savings figure.`;
  } else {
    verdict = `This mountain has few wasted weeks — historically ${round(activationShareRaw * 100)}% of the season carries a reason to advertise. The trigger model is worth running for the timing and the message discipline, not for the savings. Do not sell this as a cost-cutting exercise; the number is small and it should be.`;
  }
  if (floorBinding) {
    verdict += ` The floor is doing the work here: historical activation would be ${round(activationShareRaw * 100)}%, but a ${round(floor * 100)}% minimum keeps a baseline running.`;
  }

  return {
    season_weeks: seasonWeeks,
    modeled_weekly_budget: round(weeklyBudget),
    always_on_season_spend: alwaysOn,
    modeled_trigger_controlled_spend: triggerSpend,
    estimated_budget_protected: protectedBudget,
    estimated_budget_protected_percent: protectedPercent,
    verdict,
    cap_binding: capBinding,
    floor_binding: floorBinding,
    historical_activation_share_percent: round(activationShareRaw * 100),
    minimum_activation_share_percent: round(floor * 100),
    minimum_activation_share_source: Number.isFinite(enteredFloor)
      ? "Set on the form"
      : `Recommended for a booking window of "${profile.label}"`,
    activation_share_used: round(activationShare * 100),
    media_lead_days: climate.media_lead_days,
    historically_weak_or_suppressed_weeks: weekly.filter((w) => w.avg_suppressed_days >= 2.5 || w.activation_score < 30).length,
    historically_strong_activation_weeks: weekly.filter((w) => w.activation_score >= 60).length,
    protected_budget_uses: [
      "Held during weak conditions",
      "Shifted into stronger weather windows",
      "Used to increase frequency during powder events",
      "Reallocated to high-demand weekends",
      "Moved to future-date lodging offers",
      "Applied to season-pass marketing",
      "Carried into spring or offseason promotions"
    ],
    methodology_note:
      "This is estimated budget protected, not guaranteed savings. It is media budget that could be held, moved, or redirected during historically weak windows. The money may still be spent later; the value is in avoiding poorly timed delivery. The activation share is weekend-weighted and shifted forward by the booking window, and the minimum activation share keeps the model from assuming advertising nearly stops."
  };
}

/* ------------------------------------------------------ trigger playbook */

function triggers(body, climate) {
  const makesSnow = climate.resort_makes_snow;
  const lead = climate.media_lead_days;
  const leadNote = `Media should already be live ${lead} day${lead === 1 ? "" : "s"} ahead, because that is this resort's booking window.`;

  return [
    {
      name: "Powder Alert", priority: "High",
      condition: `Forecast of ${climate.rules.POWDER_IN}+ inches, verified fresh snowfall, or a storm expected within roughly 72 hours.`,
      lead: leadNote,
      action: "Increase advertising in the feeder markets. Raise CTV exposure, lift display frequency, run urgent audio.",
      products: ["Lift tickets", "Lodging", "Weekend packages", "Rentals", "Lessons", "Premium experiences"],
      message: "Fresh snow is arriving. Reserve your weekend lift tickets now."
    },
    {
      name: "Bluebird Window", priority: "High",
      condition: `Clear or mostly sunny weather within about 48 hours of meaningful snowfall, high at or below ${climate.rules.BLUEBIRD_MAX_F}°F.`,
      lead: leadNote,
      action: "Promote the quality of the mountain experience, not only the snowfall total.",
      products: ["Weekend trips", "Lodging", "Dining", "Scenic experiences", "Family visits", "Lessons"],
      message: "Blue skies, fresh corduroy. Plan your weekend on the mountain."
    },
    {
      name: makesSnow ? "Snowmaking Window" : "Cold Preservation Window", priority: makesSnow ? "High" : "Medium",
      condition: makesSnow
        ? `Overnight low at or below ${climate.rules.SNOWMAKING_MIN_F}°F with a high at or below ${climate.rules.SNOWMAKING_MAX_F}°F, sustained enough to expand terrain.`
        : "Sustained freezing temperatures that preserve existing natural snow and open terrain.",
      lead: leadNote,
      action: makesSnow
        ? "Promote improvements in terrain and surface conditions."
        : "Promote preserved snow quality and the terrain currently open.",
      products: makesSnow
        ? ["Terrain updates", "Opening announcements", "Lift tickets", "Beginner terrain", "Tubing"]
        : ["Lift tickets", "Lessons", "Rentals", "Weekend packages"],
      message: makesSnow
        ? "Snowmaking is underway. More terrain opens this weekend."
        : "Cold and holding. Conditions are staying strong through the weekend."
    },
    {
      name: "Freeze Warning", priority: "High",
      condition: "A National Weather Service freeze warning for the resort area — the first sustained sub-freezing arrival of the season, or a hard return to cold after a thaw.",
      lead: leadNote,
      action: makesSnow
        ? "Treat it as the season's starting gun. Announce snowmaking startup and the countdown to opening, and open pass and advance-ticket sales pushes."
        : "Announce that winter has arrived and conditions are setting up. Push season passes and advance tickets.",
      products: ["Season passes", "Advance tickets", "Opening-day announcements", "Gift cards", "Lessons"],
      message: "The freeze is here. Winter is officially on the way — lock in your season pass now."
    },
    {
      name: "Frost Advisory", priority: "Medium",
      condition: "Frost advisories in the feeder markets during the shoulder season — the first mornings people scrape their windshields.",
      lead: leadNote,
      action: "A frost advisory in Columbus sells skiing better than any calendar date. Run early-season awareness while winter is on people's minds for the first time.",
      products: ["Season passes", "Early-bird pricing", "Gift cards", "Group trips", "Advance lodging"],
      message: "First frost this morning. Ski season is closer than you think.",
      note: "This trigger fires on feeder-market weather, not mountain weather. The moment the customer feels winter is the moment to be in front of them."
    },
    {
      name: "Ice Storm", priority: "Protective",
      condition: "Freezing rain or an ice storm warning affecting the resort or the drive routes to it.",
      lead: "Suppress immediately. Ice has no upside: it closes roads, coats lifts, and keeps guests home.",
      action: "Pull all same-day and next-day visit acquisition until roads and lifts are confirmed clear. Ice is not a snow event and must never be marketed as one. Shift to future-date messaging only.",
      products: ["Future-date tickets", "Season passes", "Lodging for later dates", "Gift cards"],
      message: "Stay safe out there. Your mountain weekend will be waiting — book it for later.",
      note: "The suppression matters as much as the activations. A resort advertising 'come ski today' during an ice storm damages its credibility with every impression."
    },
    {
      name: "Warm-Weather or Rain Suppression", priority: "Protective",
      condition: `Rain of ${climate.rules.RAIN_IN} in or more above ${climate.rules.RAIN_ABOVE_F}°F, or a high at or above ${climate.rules.DAMAGING_WARMTH_F}°F.`,
      lead: "Suppress immediately. Unlike activation, suppression has no lead time — pull back as soon as the forecast turns.",
      action: "Reduce urgent visit-now advertising. This does not mean all advertising stops. It means immediate ski-visit acquisition should not be the primary message.",
      products: ["Future-date tickets", "Season passes", "Lodging for later dates", "Gift cards", "Group trips", "Events", "Dining", "Weddings", "Summer activities"],
      message: "Lock in your next trip. Future-date tickets and season passes available now."
    },
    {
      name: "High-Wind Adjustment", priority: "Protective",
      condition: `Forecast wind of ${climate.rules.WIND_MPH} mph or more, likely to affect lift operations or guest comfort.`,
      lead: "Suppress immediately, and only on operations' word.",
      action: "Suppress same-day visit acquisition unless resort operations confirm lift access will remain normal.",
      products: ["Future-date offers", "Season passes", "Lodging", "Dining"],
      message: "Plan ahead — book your mountain weekend."
    }
  ];
}

/* --------------------------------------------------- geographic targeting */

function targetLocations(body, audience) {
  const core = geo.coreRadius(body.drive_time);
  const types = String(body.resort_type || "regional_overnight")
    .split(/[,\n;]/).map((t) => t.trim()).filter(Boolean);
  const has = (...names) => names.some((n) => types.includes(n));

  const categories = [
    "Competing ski resorts and tubing facilities",
    "Ski and snowboard shops",
    "Outdoor equipment retailers",
    "Winter sports clubs and ski racing programs",
    "Campgrounds and RV parks in the feeder markets",
    "State parks, national forests, and trailhead lots",
    "High-income neighborhoods in the feeder markets"
  ];
  // A resort can be both. Union the categories rather than picking one branch.
  if (has("destination", "regional_overnight")) {
    categories.push("Hotels near competing resorts and mountain gateways", "Airports and long-haul travel corridors");
  }
  if (has("day_drive", "tubing_focus")) {
    categories.push("Family entertainment venues", "Park-and-ride lots and commuter corridors", "Youth sports complexes");
  }
  categories.push("College campuses with ski clubs", "Travel corridors toward the mountain");

  // DOOH runs against places, not audiences. Kept separate so the plan does not
  // confuse a screen location with a device-visitation segment.
  const doohVenues = [
    "Bars and taprooms",
    "Restaurants and quick-service dining",
    "Gas stations and convenience stores",
    "Shopping centers and retail corridors",
    "Grocery and big-box entrances",
    "Gyms and fitness clubs"
  ];

  return {
    feeder_markets: audience.markets.map((m) => `${m.name}${m.state ? ", " + m.state : ""} — ${m.drive_miles} mi, ${m.drive_relevance_percent}% relevance`),
    named_competitors: listify(body.competitors),
    core_radius_miles: core,
    radius_recommendation: `Guests typically drive ${core} miles or less to reach this resort. Build the primary geofence perimeter around that radius and let the per-market relevance figures set the bid weighting beyond it.`,
    geofence_categories: categories,
    dooh_venue_categories: doohVenues,
    dooh_recommendation:
      "DOOH is bought against screen locations in the feeder markets, not against a device audience. Run it on the same weather triggers as everything else: a powder alert should reach someone standing at a gas pump on a Thursday, because that is when the weekend gets decided.",
    why_it_matters:
      "A broad regional campaign reaches a large number of people with no interest in skiing. Visitation audiences focus media on people whose physical behavior suggests it — devices seen at a competing mountain, a ski retailer, a campground, a state park, or a club location.",
    lookback_strategy: [
      {
        name: "Outdoor-recreation lookback",
        how: "Capture devices seen at campgrounds, RV parks, state parks, and trailhead lots across the feeder markets through the summer and fall, resolve them to their home neighborhoods, then serve CTV, display, streaming audio, and podcasts to those households once the ski season opens.",
        why: "A household that camps is a household that already spends its weekends outdoors and already owns the gear habit. It is the closest available proxy for winter-sports intent that does not require the person to have already visited a ski resort — which means it reaches people your competitors' resort-geofence audiences do not.",
        window: "Capture June through October. Activate from opening day. The signal is seasonal, so the lookback window has to be long enough to catch a summer that already happened."
      },
      {
        name: "Competitor and retail visitation",
        how: "Capture devices seen at competing mountains, tubing parks, and ski and snowboard retailers, then target those households during qualified weather windows.",
        why: "These are proven winter-sports buyers. Smaller audience, higher intent, and the one segment where a powder alert converts fastest.",
        window: "Rolling, through the season."
      },
      {
        name: "Prior-visitor suppression",
        how: "Build an audience of the resort's own prior visitors and current passholders, and exclude it when the objective is acquisition.",
        why: "Otherwise the plan spends its acquisition budget re-reaching people who already bought.",
        window: "Rolling."
      }
    ],
    lookback_caveat:
      "Location-based audiences depend on what the data partner can legally and technically supply. Match rates, lookback windows, and home-resolution vary by platform, and some venue categories are restricted. Confirm availability and counts with the programmatic partner before any of this is committed to a client."
  };
}

/* --------------------------------------------------------------- phases */

const PHASES = [
  { phase: "Preseason", timing: "August through opening day", focus: ["Season passes", "Early-bird pricing", "Group sales", "Lessons", "Rentals", "Gift cards", "Advance lodging"] },
  { phase: "Opening and terrain build", timing: "First sustained cold windows", focus: ["Opening dates", "Snowmaking progress", "Terrain expansion", "First weekend", "Beginner terrain", "Tubing openings"] },
  { phase: "Peak winter", timing: "December through February", focus: ["Powder alerts", "Bluebird weekends", "Lift tickets", "Lodging", "Lessons", "Rentals", "Food and beverage"] },
  { phase: "Spring skiing", timing: "March through closing", focus: ["Value pricing", "Events", "Patios", "Festivals", "Pass renewal", "Family weekends"] },
  { phase: "Offseason", timing: "After closing", focus: ["Weddings", "Golf", "Hiking", "Mountain biking", "Festivals", "Corporate retreats", "Lodging", "Dining", "Next-season pass sales"] }
];

const WEEK_PLAYS = {
  "Aggressive activation": [
    "Increase CTV exposure and display frequency",
    "Run urgent streaming audio and podcast messaging",
    "Push powder-alert creative to DOOH screens in the feeder markets",
    "Promote immediate lift-ticket purchases",
    "Promote lodging availability and weekend packages",
    "Use snowfall and condition-based creative"
  ],
  "Selective activation": [
    "Run only during specific forecast windows",
    "Focus on Friday through Sunday rather than the full week",
    "Increase media after verified snowfall",
    "Use future-date offers on weaker days",
    "Reduce same-day urgency messaging"
  ],
  "Hold or use future-date offers": [
    "Pull back immediate-visit acquisition",
    "Promote season passes and future-date tickets",
    "Promote lodging for later dates, gift cards, and group trips",
    "Promote events, dining, weddings, and summer activities",
    "Hold budget for stronger weather windows"
  ]
};

const DISCLOSURES = [
  "Historical patterns do not predict exact future weather.",
  "Snowfall does not guarantee ticket purchases.",
  "Estimated skiing-household counts are directional planning figures, not purchased data counts.",
  "Budget protection is not a guaranteed refund or a guaranteed performance improvement.",
  "Advertising should never override resort operating decisions.",
  "Current forecasts must be checked before any activation.",
  "Lift status, road access, staffing, ticket inventory, avalanche control, and terrain availability take precedence.",
  "Actual media delivery may vary from the planning estimates shown here.",
  "The 16-day outlook is a forecast, not a plan. It degrades badly past about a week."
];

/* -------------------------------------------------- good / better / best */
/* Tier sizing is driven by the market, not pulled from the air: the anchor is
   a spend rate per targeted skiing household, bounded so a tiny hill is never
   quoted an absurd number and a metro-fed resort is never quoted a trivial
   one. The resort's own entered budget is shown alongside for comparison. */

function pricingTiers(body, audience, climate) {
  const targeted = Math.max(1, num(audience.estimated_targeted_skiing_households, 12000));
  const feeder = Math.max(1, num(audience.feeder_households_used, 500000));

  // Anchor: $0.45 per targeted skiing household per month, nudged by total
  // feeder size (a bigger metro needs more weight to be heard at all).
  const metroNudge = clamp(Math.log10(feeder / 300000) * 0.12 + 1, 0.85, 1.35);
  const anchor = clamp(targeted * 0.45 * metroNudge, 3000, 30000);
  // budgetPlan enforces a $2,500 monthly minimum; no tier may quote less,
  // or its channel mix would silently sum to more than its own price.
  const to250 = (v) => Math.max(2500, Math.round(v / 250) * 250);

  const entered = clamp(num(body.monthly_budget, 0), 0, 100000);

  const tiers = [
    {
      key: "good", label: "Good", monthly: to250(anchor * 0.7),
      stance: "Presence",
      description: "Enough weight to own the strongest weather windows — powder alerts and holiday weekends — while staying dark the rest of the time. The floor below which weather-triggering stops being meaningful in this market."
    },
    {
      key: "better", label: "Better", monthly: to250(anchor), recommended: true,
      stance: "Competitive",
      description: "Sustained presence through every qualified window with enough frequency for the message to stick, plus DOOH coverage in the feeder markets. Sized to what this market's skiing-household count can absorb efficiently."
    },
    {
      key: "best", label: "Best", monthly: to250(anchor * 1.6),
      stance: "Market leadership",
      description: "Category ownership: first and loudest on every trigger, full lookback audiences running, competitor conquesting on, and enough weight to crowd out other resorts' messaging in shared feeder markets."
    }
  ].map((t) => {
    const plan = budgetPlan({ ...body, monthly_budget: t.monthly });
    return {
      ...t,
      season_estimate: t.monthly * Math.max(1, Math.round((climate.total_season_weeks || 20) / 4.345)),
      channels: plan.channels.map((c) => ({ channel: c.channel, budget: c.budget, impressions: c.impressions })),
      monthly_impressions: plan.channels.reduce((a, c) => a + c.impressions, 0)
    };
  });

  return {
    basis: `Sized from this market: ${targeted.toLocaleString("en-US")} targeted skiing households across ${feeder.toLocaleString("en-US")} feeder households.`,
    entered_monthly_budget: entered || null,
    entered_vs_tiers: entered
      ? (entered < tiers[0].monthly
          ? "The budget entered on the form sits below the Good tier for this market."
          : entered >= tiers[2].monthly
            ? "The budget entered on the form sits at or above the Best tier for this market."
            : "The budget entered on the form falls between the tiers shown here.")
      : null,
    tiers,
    disclaimer:
      "These are suggested budgets, modeled from this market's estimated size. They are a starting point, not a quote. In a consultation, Smart 1 can tailor a budget that works for your resort — around your season length, your revenue mix, and what you are spending today.",
    consult_url: CONSULT_URL
  };
}

/* ------------------------------------------- versus traditional advertising */
/* The honest comparison is about control, not a performance promise. A
   traditional buy is committed before the weather happens; this plan's entire
   protected-budget figure exists because digital can be switched. */

function traditionalComparison(savings, budget) {
  const seasonSpend = savings.always_on_season_spend;
  return {
    headline: "The same dollars in traditional media cannot be weather-controlled.",
    rows: [
      {
        dimension: "When it runs",
        traditional: "Booked weeks or months ahead. The radio spot airs and the print insert prints whether it is a powder day or a 45-degree washout.",
        this_plan: "Switches on qualified weather windows and off in suppression windows, day by day."
      },
      {
        dimension: "Budget protected in weak weeks",
        traditional: "$0 — the spend is committed before the weather happens.",
        this_plan: `${money(savings.estimated_budget_protected)} modeled (${savings.estimated_budget_protected_percent}% of the season), held or moved out of historically weak windows.`
      },
      {
        dimension: "Who it reaches",
        traditional: "Everyone in the signal or circulation area, most of whom do not ski.",
        this_plan: "Targeted skiing households, visitation audiences, and the venues where the weekend gets decided."
      },
      {
        dimension: "What can be measured",
        traditional: "Reach estimates from the seller.",
        this_plan: "Delivered impressions by channel, by audience, by trigger window — and visitation where the data partner supports it."
      }
    ],
    season_frame: `On this plan's modeled ${money(seasonSpend)} season, a locked traditional schedule protects nothing in weak-weather weeks. The trigger-controlled model protects ${money(savings.estimated_budget_protected)}.`,
    caveat: "This compares budget control and targeting, not results. No claim is made that any channel outperforms another for a given resort — that depends on creative, market, and execution."
  };
}

function money(n) { return "$" + Math.round(Number(n) || 0).toLocaleString("en-US"); }

module.exports = { readiness, budgetPlan, savingsModel, triggers, targetLocations, pricingTiers, traditionalComparison, PHASES, WEEK_PLAYS, DISCLOSURES, CPMS, CONSULT_URL };
