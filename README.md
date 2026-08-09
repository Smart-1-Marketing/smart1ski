# Smart 1 Ski Resort Growth & Weather-Trigger Plan (Python / Flask)

A Smart 1 Marketing lead tool for **ski resorts**. Collects resort + feeder-market
inputs, pulls 5-year historical winter conditions (open-meteo), and returns a
weather-triggered market plan: a Weather-Marketing Readiness Score, targeted
skiing-household estimates, a historical savings model, a week-by-week season
plan, geofencing targets, a weather-trigger playbook, and a CTV/Display/Audio
media plan. It also generates a branded **PDF**, stores it in **Cloudinary**, and
posts the lead + report (including the PDF URL) to **Smart1Suite (GoHighLevel)**.

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
- `GHL_WEBHOOK_URL` — Smart1Suite (GoHighLevel) inbound webhook (secret)
- `CLOUDINARY_URL` — `cloudinary://<api_key>:<api_secret>@<cloud_name>` (secret)
- `REPORT_NAME` — Cloudinary folder / base name for report PDFs (default `dealership-rv-report`)
- `PYTHON_VERSION` — `3.12.4`

## Deploy to Render
1. New + → Blueprint → connect this repo (Render reads `render.yaml`, runtime **python**).
2. Add `GHL_WEBHOOK_URL` and `CLOUDINARY_URL` as secret env vars.
3. Deploy, test `/health`, then submit the form. The service must serve the
   **form** at `/` — not any landing page.

> The marketing landing page ("gameplan") lives separately on Simvoly and embeds
> this tool in an iframe. Do NOT deploy the landing page to this service.

## Notes
- PDFs are uploaded to Cloudinary as **raw** files (delivered without needing the
  "Allow delivery of PDF/ZIP" security toggle). The URL is sent as `report_pdf_url`.
- Media recommendations intentionally exclude paid social and paid search.
- All figures are directional AI/statistical planning estimates.
