# Smart 1 Ski Resort Package

A lead funnel and planning tool for ski resorts. A resort completes a
seven-section intake and receives a client-ready plan covering:

- Which weeks of its season historically deserve aggressive, selective, or held
  spending — corrected to the resort's own elevation, weighted toward weekends,
  and shifted forward by its booking window.
- **What the next sixteen days would trigger**, run live against the same rules.
- How many skiing households each named feeder market actually puts within
  reach, with relevance derived from real driving distance.
- How much budget weather triggers could protect, and an honest verdict on
  whether that number is worth selling.
- Geofence and visitation targeting, a weather-trigger playbook, and a monthly
  Connected TV / programmatic display / digital audio allocation.

The submission and report are relayed server-side to a Smart 1 Suite webhook.

Paid search, paid social, and print are intentionally excluded from this package.

## Files

```
server.js                 API, abuse guards, webhook relay
lib/geo.js                ZIP + market geocoding, distance, relevance decay
lib/weather.js            unit normalization, elevation correction, triggers, forecast
lib/audience.js           per-market household model
lib/plan.js               readiness rubric, media mix, savings model, playbook
lib/report.js             report assembly
lib/cache.js              TTL cache
public/index.html         intake form
public/report.js          report renderer (shared with the standalone view)
public/styles.css         stylesheet (shared with the standalone view)
test/pipeline.test.js     end-to-end model tests, APIs stubbed
test/ui.test.js           DOM tests of the form and report
```

Run `npm test` before deploying. It stubs the weather APIs, so it needs no
network.

## Render setup

1. Create a GitHub repo named `smart1ski` and upload this package, preserving
   the `lib`, `public`, and `test` folders.
2. In Render, choose **New > Blueprint** and select the repo.
3. Set both environment variables:
   - `SMART1_WEBHOOK_URL` — the inbound webhook URL from Smart 1 Suite.
   - `ALLOWED_ORIGIN` — the exact origin that embeds the form, e.g.
     `https://suite.smart1marketing.com`. **Do not ship a wildcard.** The API
     writes to your CRM; a wildcard lets any site on the internet post to it.
4. Deploy, then check `/health`. It reports whether the webhook is configured
   and whether the origin is locked.

**Move off the free tier before a prospect sees this.** Free instances spin
down after inactivity and the first request can take fifty seconds — with a
client watching the screen.

## Embed in Smart 1 Suite

```html
<iframe
  src="https://YOUR-RENDER-URL.onrender.com/"
  title="Ski Resort Growth and Weather Trigger Plan"
  style="width:100%;min-height:1450px;border:0;border-radius:12px"
  loading="lazy">
</iframe>
```

The backend holds the webhook URL. Never put it in the public HTML.

Inside the iframe, "Open full report" launches the report in its own tab, which
is where it should be printed — `window.print()` from inside an iframe is
unreliable across browsers.

## How the model works

### Where the weather is read

The ZIP resolves through Zippopotam, falling back to Open-Meteo geocoding. If
the resort supplies base-area coordinates, those are used instead of the ZIP
centroid.

**Elevation is the single biggest accuracy lever in the product.** The weather
archive is a coarse grid whose cell elevation is usually the valley floor, and
a thousand feet is three to five degrees — exactly the margin between a
snowmaking window and a rain event. When the resort supplies its base (and
ideally summit) elevation, temperatures are corrected with a 3.5°F per 1,000 ft
lapse rate and precipitation is re-partitioned, because valley rain is mountain
snow. The report states the correction it applied.

Units are read from the metadata the API returns, never assumed. Open-Meteo
reports snowfall in centimetres by default; a silent cm-for-inches swap would
inflate every snowfall figure by 2.54 and fire the powder trigger on an inch
and a half of snow.

### A qualified day

At least one **trigger**:

- Natural snowfall of 1 inch or more (4 inches or more is a powder day).
- A snowmaking window — low ≤ 28°F and high ≤ 38°F. **Only counted if the
  resort actually makes snow.**
- A post-storm bluebird day — recent snow, 5+ hours of sun, high ≤ 40°F.

...and nothing spoiling it. These are **guards**, not triggers:

- No meaningful rain (≥ 0.25 in above 34°F), no high wind (≥ 30 mph), no
  damaging warmth (high ≥ 45°F).

Cold, calm weather on its own is not a qualified day. It is a condition that
has to hold, not a reason to advertise.

### From qualified days to activation

Media has to be live before the guest decides, so the qualified signal is
shifted forward by the booking window as a **moving average** — each day scores
how much of the following lead window qualifies.

This is deliberately not "advertise if any of the next three days qualifies."
That version inflates: if 60% of days qualify, then at least one of any four
consecutive days qualifies about 97% of the time, activation creeps to 100%,
and the savings model collapses for arithmetic reasons rather than weather
reasons. A moving average has the same mean as the series underneath it. It
moves *when* you should be in market without inventing days that were not there.

Weekend days (Friday–Sunday) carry 2× the weight, because that is when the
mountain sells.

### The savings model

Always-on spend is the monthly budget spread evenly. Trigger-controlled spend
applies the weekend-weighted, lead-shifted activation share, floored by a
**minimum activation share derived from the booking window** — a resort whose
guests book a month ahead cannot run a pure trigger campaign, so its floor is
higher (50–60%) and its protected budget smaller.

The report includes a **verdict**. On a cold, reliable mountain the protected
figure will be small and the report says so plainly, so nobody walks into a
meeting selling this as a cost-cutting exercise when the real value is timing.

### Feeder markets

Name them. Each is geocoded, its distance to the mountain is measured, and its
relevance is derived from that distance against the resort's own drive radius
(from the typical guest drive time). Households come from market population.
To override a household count, write the market as `Columbus: 640000`.

### The readiness score

100 points across four published components — snow supply (30), snow production
(25), condition quality (20), weather reliability (25) — with named bands:
75+ strong, 55+ workable, 35+ marginal, below that weak. The report shows the
breakdown, so "83" has an answer when a client asks what it means.

### Recalibrating

Every threshold lives in the `RULES` block at the top of `lib/weather.js`.
Change them there and nowhere else, then run `npm test`.

## Abuse protection

The form is an unauthenticated public door into the CRM. It is protected by a
honeypot field, a minimum time-on-form, a per-IP rate limit (5 per 15 minutes,
20 per day), and a 10-minute dedupe window so one person double-clicking does
not create two opportunities. All of it is in-memory: if you ever scale past a
single Render instance, move it to Redis.

## Honest-reporting rules this package follows

- The webhook is server-side, never exposed in browser code.
- A failed webhook does not show a fake success. The plan still renders and the
  form says plainly that the lead was not recorded.
- Audience figures are labeled directional estimates, not purchased data counts.
- No ROI or lift claims appear anywhere.
- Budget protection is framed as budget that may be held, moved, or redirected —
  never as guaranteed savings — and the report says so when the number is small.
- Every report closes with what it does not promise.

## Weather trigger notes

The historical analysis is directional and the 16-day outlook is a forecast,
not a plan. Live activation must use the client-approved weather source and
operational data. Weather must never override lift status, road access, ticket
inventory, staffing, avalanche control, or resort management decisions.

## Channel scope

The plan is limited to four channels, all of which can be targeted against a
built audience and switched by a weather trigger:

| Channel | Planning CPM | Role |
|---|---|---|
| Connected TV | $35 | Awareness and emotional demand on the big screen |
| Data-Driven Targeted Display | $12 | Frequency and response against the built audience, not a publisher list |
| Streaming Radio and Podcasts | $20 | Drive-market guests in the car, outdoor and travel podcast audiences at home |
| Digital Out-of-Home | $22 | Bars, restaurants, gas stations, and shopping areas, where the weekend plan gets made |

Paid search, paid social, and print are excluded. Print in particular cannot be
weather-triggered, cannot be targeted to a skiing-household audience, and cannot
be measured against visitation — if a resort is running it, the report says so
and frames this plan as a replacement rather than an addition.

CPMs are planning assumptions and live in one object (`CPMS`) at the top of
`lib/plan.js`. Confirm them against real avails before quoting.

## Location lookback

The strongest audience in the plan is not people who have already been to a ski
resort — your competitors are all buying that one. It is households that camp.

Capture devices seen at campgrounds, RV parks, state parks, and trailhead lots
across the feeder markets from June through October, resolve them to their home
neighborhoods, and activate against those households from opening day. A
household that camps already spends its weekends outdoors and already owns the
gear habit. The signal is seasonal, so the lookback window must be long enough
to reach back into a summer that has already happened.

Match rates, lookback windows, home-resolution, and venue-category availability
all vary by data partner. Confirm counts before any of this is committed to a
client.
