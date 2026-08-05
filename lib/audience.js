"use strict";

const geo = require("./geo");

const num = (v, f = 0) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : f);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v) => Math.round(v);

/* Feeder markets used to be one blended blob: combined households times a
   single drive-market relevance percentage the resort had to guess. Now each
   named market is geocoded, its distance from the mountain is measured, and
   its relevance is *derived* from that distance against the resort's own
   drive-time answer. Columbus and Pittsburgh stop being the same number. */

async function estimate(body, site) {
  const personsPerHousehold = clamp(num(body.persons_per_household, 2.45), 1.5, 4.5);
  const affluentShare = clamp(num(body.affluent_share, 35), 5, 90) / 100;
  const skiRate = clamp(num(body.ski_household_rate, num(body.ski_participation_rate, 9)), 2, 30) / 100;
  const core = geo.coreRadius(body.drive_time);

  const parsed = geo.parseMarkets(body.target_markets);

  const located = await Promise.all(
    parsed.map(async (m) => {
      const hit = await geo.geocodeMarket(m.name);
      if (!hit || (!hit.population && !m.households_entered)) return { ...m, located: false };

      const straight = geo.haversineMiles(site.latitude, site.longitude, hit.latitude, hit.longitude);
      const driveMiles = Math.round(straight * geo.ROAD_FACTOR);
      const relevance = geo.driveRelevance(driveMiles, core);

      const households = m.households_entered || (hit.population ? hit.population / personsPerHousehold : 0);
      if (!households) return { ...m, located: false };

      return {
        name: m.name,
        state: hit.state,
        located: true,
        population: round(hit.population || households * personsPerHousehold),
        households: round(households),
        households_source: m.households_entered ? "Entered by the resort" : "Derived from market population",
        straight_line_miles: round(straight),
        drive_miles: driveMiles,
        drive_hours: Math.round((driveMiles / 55) * 10) / 10,
        drive_relevance_percent: round(relevance * 100),
        targeted_skiing_households: round(households * affluentShare * skiRate * relevance)
      };
    })
  );

  const markets = located.filter((m) => m.located);
  const unlocated = located.filter((m) => !m.located).map((m) => m.name);

  /* ---- basis selection ------------------------------------------------ */

  const enteredHouseholds = num(body.feeder_households);
  const enteredPopulation = num(body.feeder_population);
  const manualRelevance = clamp(num(body.drive_market_share, 75), 20, 100) / 100;

  let households;
  let targeted;
  let basis;
  let derived = false;

  if (markets.length) {
    households = markets.reduce((t, m) => t + m.households, 0);
    targeted = markets.reduce((t, m) => t + m.targeted_skiing_households, 0);
    derived = true;
    basis =
      `Built from ${markets.length} named feeder market${markets.length === 1 ? "" : "s"}. ` +
      `Each market's drive-market relevance is derived from its distance to the resort, not from a single percentage applied to everything.`;
  } else {
    households = enteredHouseholds || (enteredPopulation ? enteredPopulation / personsPerHousehold : 0);
    if (!households) {
      households = Math.max(1, parsed.length) * 210000;
      basis = "No market size was entered and no market could be located, so this is a directional placeholder. Replace it before quoting.";
    } else {
      basis = enteredHouseholds
        ? "Households entered by the resort, with one drive-market relevance figure applied across all markets."
        : "Converted from the population entered by the resort, with one drive-market relevance figure applied across all markets.";
    }
    targeted = round(households * affluentShare * skiRate * manualRelevance);
  }

  const populationUsed = derived
    ? markets.reduce((t, m) => t + m.population, 0)
    : enteredPopulation || households * personsPerHousehold;

  const effectiveRelevance = households ? targeted / (households * affluentShare * skiRate) : 0;

  return {
    basis,
    derived_from_distance: derived,
    markets,
    markets_not_located: unlocated,
    core_radius_miles: core,
    feeder_population_used: round(populationUsed),
    feeder_households_used: round(households),
    assumptions: {
      persons_per_household: personsPerHousehold,
      affluent_share_percent: round(affluentShare * 100),
      skiing_household_rate_percent: round(skiRate * 100),
      drive_market_relevance_percent: round(effectiveRelevance * 100),
      drive_market_relevance_source: derived
        ? "Derived per market from distance to the resort"
        : "Single figure entered on the form"
    },
    funnel: [
      { step: "Feeder-market households", value: round(households) },
      { step: `Affluent share (${round(affluentShare * 100)}%)`, value: round(households * affluentShare) },
      { step: `Skiing-household rate (${round(skiRate * 100)}%)`, value: round(households * affluentShare * skiRate) },
      { step: derived
          ? `Drive-market relevance (${round(effectiveRelevance * 100)}% blended)`
          : `Drive-market relevance (${round(manualRelevance * 100)}%)`,
        value: round(targeted) }
    ],
    broad_skiing_households: round(households * skiRate),
    estimated_targeted_skiing_households: round(targeted),
    estimated_targeted_skiers_and_riders: round(targeted * 2.1),
    estimated_past_resort_visitor_households: round(targeted * 0.35),
    estimated_family_ski_households: round(targeted * 0.42),
    methodology_note:
      "Directional planning estimate, not a purchased audience count. Market populations come from a public gazetteer; household counts are derived from them. Compare against available counts from Smart 1's programmatic data partners before deployment."
  };
}

module.exports = { estimate };
