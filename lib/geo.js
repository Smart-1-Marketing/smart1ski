"use strict";

const cache = require("./cache");

const num = (v, f = 0) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : f);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const M_TO_FT = 3.28084;

/* ------------------------------------------------------------------ fetch */

async function getJson(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`${label} failed (${response.status}).`);
  return response.json();
}

/* ------------------------------------------------------------ resort ZIP */

async function zipViaZippopotam(zip) {
  const data = await getJson(`https://api.zippopotam.us/us/${zip}`, "ZIP lookup");
  const place = (data.places || [])[0];
  if (!place) throw new Error("ZIP not found.");
  return {
    latitude: Number(place.latitude),
    longitude: Number(place.longitude),
    city: place["place name"] || "",
    state: place["state abbreviation"] || place.state || "",
    source: "zippopotam"
  };
}

async function zipViaOpenMeteo(zip) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", zip);
  url.searchParams.set("count", "10");
  url.searchParams.set("countryCode", "US");
  url.searchParams.set("format", "json");

  const data = await getJson(url, "Location lookup");
  const match = (data.results || []).find((r) => r.country_code === "US") || (data.results || [])[0];
  if (!match) throw new Error("ZIP code could not be located.");
  return {
    latitude: match.latitude,
    longitude: match.longitude,
    city: match.name || "",
    state: match.admin1 || "",
    elevation_m: num(match.elevation, NaN),
    source: "open-meteo"
  };
}

async function elevationAt(latitude, longitude) {
  try {
    const url = new URL("https://api.open-meteo.com/v1/elevation");
    url.searchParams.set("latitude", latitude);
    url.searchParams.set("longitude", longitude);
    const data = await getJson(url, "Elevation lookup");
    const value = (data.elevation || [])[0];
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/* Resolve where the weather should actually be read.

   A ZIP centroid is the town, not the mountain. If the resort gives us the
   coordinates of its base area we use those instead, and we say which we used
   in the report so nobody has to guess. */

async function resolveResort(body) {
  const zip = String(body.zip_code || "").trim().slice(0, 5);
  const lat = num(body.resort_latitude, NaN);
  const lon = num(body.resort_longitude, NaN);
  const coordsGiven = Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

  const place = await cache.remember(`zip:${zip}`, cache.TTL.GEOCODE, async () => {
    try {
      return await zipViaZippopotam(zip);
    } catch {
      return await zipViaOpenMeteo(zip);
    }
  });

  const latitude = coordsGiven ? lat : place.latitude;
  const longitude = coordsGiven ? lon : place.longitude;

  // Elevation the resort tells us, in preference to a DEM sample.
  const baseFt = num(body.base_elevation_ft, NaN);
  const summitFt = num(body.summit_elevation_ft, NaN);

  let siteElevationFt = null;
  let elevationSource = "";

  if (Number.isFinite(baseFt) && baseFt > 0) {
    // The audience is standing at the base looking up. Weight the base
    // heavily but let the summit pull it up a little, because conditions on
    // the hill are what get reported and what sell tickets.
    siteElevationFt = Number.isFinite(summitFt) && summitFt > baseFt
      ? Math.round(baseFt + (summitFt - baseFt) * 0.4)
      : Math.round(baseFt);
    elevationSource = Number.isFinite(summitFt) && summitFt > baseFt
      ? "Base and summit elevation supplied by the resort"
      : "Base elevation supplied by the resort";
  } else {
    const demM = await cache.remember(
      `elev:${latitude.toFixed(3)},${longitude.toFixed(3)}`,
      cache.TTL.GEOCODE,
      () => elevationAt(latitude, longitude)
    );
    if (Number.isFinite(demM)) {
      siteElevationFt = Math.round(demM * M_TO_FT);
      elevationSource = coordsGiven
        ? "Terrain elevation at the coordinates supplied"
        : "Terrain elevation at the ZIP code centroid";
    }
  }

  return {
    latitude,
    longitude,
    city: place.city,
    state: place.state,
    zip_code: zip,
    coordinates_source: coordsGiven ? "Resort coordinates" : "ZIP code centroid",
    coordinates_supplied: coordsGiven,
    site_elevation_ft: siteElevationFt,
    base_elevation_ft: Number.isFinite(baseFt) ? Math.round(baseFt) : null,
    summit_elevation_ft: Number.isFinite(summitFt) ? Math.round(summitFt) : null,
    elevation_source: elevationSource
  };
}

/* ------------------------------------------------------------ feeder markets */

/* Markets may be entered plainly ("Columbus") or with a household override
   ("Columbus: 640000"). The geocoder gives us a population for the city, so
   in the common case the resort does not have to look anything up. */

function parseMarkets(raw) {
  return String(raw || "")
    .split(/\n|,|;/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)\s*[:\-–]\s*([\d,\.]+)\s*$/);
      if (m && Number(m[2].replace(/,/g, "")) > 0) {
        return { name: m[1].trim(), households_entered: Math.round(Number(m[2].replace(/,/g, ""))) };
      }
      return { name: line, households_entered: null };
    })
    .filter((m) => m.name.length > 1)
    .slice(0, 12);
}

async function geocodeMarket(name) {
  return cache.remember(`market:${name.toLowerCase()}`, cache.TTL.GEOCODE, async () => {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", name);
    url.searchParams.set("count", "5");
    url.searchParams.set("countryCode", "US");
    url.searchParams.set("format", "json");
    try {
      const data = await getJson(url, "Market lookup");
      const results = (data.results || []).filter((r) => r.country_code === "US");
      // Prefer the biggest match — "Columbus" should be Ohio, not Indiana.
      results.sort((a, b) => num(b.population) - num(a.population));
      const hit = results[0];
      if (!hit) return null;
      return {
        latitude: hit.latitude,
        longitude: hit.longitude,
        state: hit.admin1 || "",
        population: num(hit.population, 0)
      };
    } catch {
      return null;
    }
  });
}

/* -------------------------------------------------------------- distance */

const R_MILES = 3958.8;
const rad = (d) => (d * Math.PI) / 180;

function haversineMiles(aLat, aLon, bLat, bLon) {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.sqrt(h));
}

// Roads are not straight lines. 1.2 is the usual planning multiplier.
const ROAD_FACTOR = 1.2;

/* The radius the resort's own guests actually come from, from the drive-time
   answer on the form. This is what makes the decay curve resort-specific
   rather than a single guessed percentage applied to every market. */

const CORE_RADIUS_MILES = {
  under_1: 35,
  "1_2": 80,
  "2_4": 170,
  "4_plus": 300
};

function coreRadius(driveTime) {
  return CORE_RADIUS_MILES[String(driveTime)] || CORE_RADIUS_MILES["2_4"];
}

/* Relevance decay: full weight inside half the core radius, then an
   exponential falloff. At the core radius a market is worth about 61% of a
   local one; at twice the core, about 22%; it never falls below 5%. */

function driveRelevance(driveMiles, core) {
  const inner = core * 0.5;
  if (driveMiles <= inner) return 1;
  return clamp(Math.exp(-(driveMiles - inner) / core), 0.05, 1);
}

module.exports = {
  resolveResort,
  parseMarkets,
  geocodeMarket,
  haversineMiles,
  driveRelevance,
  coreRadius,
  ROAD_FACTOR,
  M_TO_FT
};
