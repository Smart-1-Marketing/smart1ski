"use strict";

/* A tiny in-process TTL cache. Render's free tier runs one instance, so a Map
   is enough. If you ever scale to multiple instances, swap this for Redis —
   nothing else in the codebase needs to change. */

const store = new Map();

function get(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

function set(key, value, ttlMs) {
  store.set(key, { value, expires: Date.now() + ttlMs });
  // Keep the map from growing without bound on a long-lived process.
  if (store.size > 500) {
    const now = Date.now();
    for (const [k, v] of store) if (now > v.expires) store.delete(k);
    while (store.size > 400) store.delete(store.keys().next().value);
  }
  return value;
}

async function remember(key, ttlMs, produce) {
  const cached = get(key);
  if (cached !== null) return cached;
  const value = await produce();
  return set(key, value, ttlMs);
}

const TTL = {
  GEOCODE: 30 * 24 * 60 * 60 * 1000, // ZIPs and city centroids do not move
  ARCHIVE: 12 * 60 * 60 * 1000,      // completed seasons change once a year
  FORECAST: 60 * 60 * 1000           // refreshed hourly
};

module.exports = { get, set, remember, TTL, store };
