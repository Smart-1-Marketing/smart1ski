# Smart 1 Ski Resort Package

A multi-step lead funnel and planning tool for ski resorts. It:

- Resolves the resort ZIP code without a paid API key.
- Uses Open-Meteo historical weather data when available.
- Estimates snowmaking, powder, bluebird, rain-risk and wind-risk days.
- Creates feeder-market and targetable winter-sports audience estimates.
- Recommends geofence categories, seasonal phases and weather triggers.
- Builds a monthly Connected TV, programmatic display, and digital audio allocation.
- Relays the complete submission and report to a Smart 1 Suite webhook.
- Produces a client-facing report that can be printed or saved as a PDF.

## GitHub Upload

Upload all files and folders in this package:

- `server.js`
- `package.json`
- `render.yaml`
- `.env.example`
- `README.md`
- `SMART1_SUITE_FIELDS.csv`
- `public/index.html`

Do not upload a real `.env` file.

## Render Setup

1. Create a new GitHub repository named `smart1ski`.
2. Upload this package, preserving the `public` folder.
3. In Render, choose **New > Blueprint** and select the repository.
4. Render will read `render.yaml`.
5. Add the environment variable:
   - `GHL_WEBHOOK_URL` = the inbound webhook URL from Smart 1 Suite.
6. Optional:
   - Set `ALLOWED_ORIGIN` to the exact website origin that embeds the app.
7. Deploy and test:
   - `https://YOUR-RENDER-URL.onrender.com/health`
   - `https://YOUR-RENDER-URL.onrender.com/`

## Embed in Smart 1 Suite

Use an iframe in a Custom HTML/Code block:

```html
<iframe
  src="https://YOUR-RENDER-URL.onrender.com/"
  title="Ski Resort Growth and Weather Trigger Plan"
  style="width:100%;min-height:1450px;border:0;border-radius:12px"
  loading="lazy">
</iframe>
```

The backend protects the webhook URL. Do not put the Smart 1 Suite webhook directly into the public HTML.

## Smart 1 Suite Workflow

Recommended workflow:

1. Inbound Webhook trigger.
2. Create/update contact by `contact_email`.
3. Create opportunity in pipeline: `Ski Resort Leads`.
4. Assign owner.
5. Store report fields.
6. Send internal notification with report score, pool and budget.
7. Send the prospect a confirmation email.
8. Create follow-up task for the salesperson.

## Weather Trigger Notes

The historical analysis is directional. Live campaign activation should use the client-approved weather source and operational data. Weather alone should never override lift status, road access, ticket inventory, staffing, avalanche controls or resort management decisions.

## Important Corrections from the Sample Concept

- The webhook is server-side, not exposed in browser code.
- A failed webhook does not silently show a fake success.
- ZIP validation uses a valid regular expression.
- Audience estimates are labeled estimates rather than presented as purchased data counts.
- ROI lift claims are not included unless Smart 1 has a source it is prepared to cite.
- “Rollover” language is framed as an agreement-dependent budget safeguard rather than an automatic promise.


## Added Historical Weekly and Savings Outputs

The report now returns:

- A week-by-week historical view across the resort's selected ski season.
- Average qualified advertising days by season week.
- Snowfall, snowmaking, powder, bluebird and suppression indicators by week.
- An AI recommendation for each week: aggressive activation, selective activation, or hold/future-date offers.
- Modeled always-on seasonal spend.
- Modeled trigger-controlled seasonal spend.
- Estimated budget protected by avoiding historically weak periods.
- Estimated targeted skiing households in the feeder markets.

The savings calculation is directional. It estimates budget that may be held, moved, or redirected rather than guaranteeing refunds or campaign results.


## Channel Scope

Paid social and paid search are intentionally excluded from this package.

The recommended media plan is limited to:

- Connected TV
- Programmatic Display
- Digital Audio

All budget allocations, delivery estimates, savings calculations, and client-facing recommendations are based only on these three channels.
