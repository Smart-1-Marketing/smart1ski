# Smart 1 Ski Resort Growth & Weather-Trigger Plan (Python / Flask)

A Smart 1 Marketing lead tool for **ski resorts**. Collects resort + feeder-market
inputs, pulls 5-year historical winter conditions (open-meteo), and returns a
weather-triggered market plan: a Weather-Marketing Readiness Score, an **AI
market assessment** (OpenAI, with a deterministic fallback when no API key is
configured), targeted skiing-household estimates, a historical savings model, a
week-by-week season plan, geofencing targets, a weather-trigger playbook, and a
CTV/Display/Audio media plan. It also generates a branded **PDF**, stores it in
**Cloudinary**, and posts the lead + report (including the PDF URL) to
**Smart1Suite (GoHighLevel)**.

## Endpoints
- `GET /` — the multi-step form
- `GET /health` — health check
- `POST /api/analyze` — full analysis + AI summary + PDF + webhook
  (honeypot check + 6/hour per-IP rate limit)
- `POST /api/partial-lead` — partial lead salvage (no email required; fired when a
  visitor advances past step 1 or leaves the page; separate light rate limit;
  forwards `report_status: "partial"` + `lead_id` + attribution to the webhook)

## Project structure
```
smart1ski/
├── app.py                 # Flask backend (logic + PDF + Cloudinary + webhook)
├── templates/
│   └── index.html         # Multi-step ski form (CSS + JS inlined)
├── requirements.txt
├── Procfile
├── render.yaml
├── .env.example
├── .gitignore
└── SMART1_SUITE_FIELDS.csv
```

## Environment variables (Render)
See `.env.example` for the full local template.
- `GHL_WEBHOOK_URL` — Smart1Suite (GoHighLevel) inbound webhook (secret).
  `SMART1_WEBHOOK_URL` is honored as a legacy fallback name.
- `CLOUDINARY_URL` — `cloudinary://<api_key>:<api_secret>@<cloud_name>` (secret)
- `OPENAI_API_KEY` — enables the AI "Market assessment" narrative (secret; optional —
  a deterministic template is used when unset or when the API call fails)
- `OPENAI_MODEL` — OpenAI model id (default `gpt-4.1-mini`)
- `REPORT_NAME` — Cloudinary folder / base name for report PDFs (default `smart1-ski-report`)
- `PORT` — local port for `python app.py` (Render supplies its own)
- `PYTHON_VERSION` — `3.12.4`

## Deploy to Render
1. New + → Blueprint → connect this repo (Render reads `render.yaml`, runtime **python**).
2. Add `GHL_WEBHOOK_URL`, `CLOUDINARY_URL`, and `OPENAI_API_KEY` as secret env vars.
3. Deploy, test `/health`, then submit the form. The service must serve the
   **form** at `/` — not any landing page.

> The marketing landing page ("gameplan") lives separately on Simvoly and embeds
> this tool in an iframe. Do NOT deploy the landing page to this service.

## Notes
- PDFs are uploaded to Cloudinary as **raw** files (delivered without needing the
  "Allow delivery of PDF/ZIP" security toggle). The URL is sent as `report_pdf_url`
  and rendered as a "Download PDF" button on the results screen.
- The webhook payload additionally carries `market_summary` (AI narrative) and
  `lead_id` (client-generated id that lets GHL merge partial + final leads).
- Media recommendations intentionally exclude paid social and paid search.
- All figures are directional AI/statistical planning estimates.
