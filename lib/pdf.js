"use strict";

/* PDF rendering needs a real browser to lay out the report exactly as the
 * person saw it — CSS grid, the season-board SVG, print page-break rules,
 * all of it. This uses puppeteer-core (no bundled Chromium: Render's free
 * tier has ~512MB RAM, and Chromium alone needs more than that at idle) and
 * connects to a remote browser over WebSocket. Any Chrome-DevTools-Protocol
 * endpoint works — Browserless, Render's own browser add-on, a self-hosted
 * headless Chrome, etc. Point PDF_BROWSER_WS_ENDPOINT at it.
 *
 * If that variable is unset, PDF generation is simply skipped — the report
 * still renders and the webhook still fires. This mirrors how a missing
 * SMART1_WEBHOOK_URL is handled: absence is a normal, expected state.
 */

const { markup } = require("../public/report.js");

function isConfigured() {
  return !!process.env.PDF_BROWSER_WS_ENDPOINT;
}

function wrapStandalone(report, css) {
  // Reuses the exact same markup() the browser renders — same section
  // order, same numbers, same wording. There is one report, not two.
  const body = markup(report, { standalone: true });
  const title = `${(report.resort && report.resort.name) || "Ski Resort"} — Weather Trigger Plan`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Public+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<style>${css}
/* Printed as a document, not a browser tab: the report card has no
   surrounding shell to strip, because there is no shell here at all. */
body{background:#fff}
.report-standalone{max-width:900px;margin:0 auto}
</style></head>
<body><div class="card report report-standalone" id="report">${body}</div></body></html>`;
}

/**
 * Render the report to a PDF buffer. Returns { configured:false } if no
 * browser endpoint is set. Throws on a real rendering failure — the caller
 * decides whether that should block the response (it should not).
 */
async function renderPdf(report, css, deps) {
  if (!isConfigured()) return { configured: false, rendered: false };

  // `deps.connect` is injectable so this can be exercised in tests without a
  // real browser. In production it is puppeteer-core's connect().
  const connect = (deps && deps.connect) || defaultConnect;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  let browser;

  try {
    browser = await connect({ browserWSEndpoint: process.env.PDF_BROWSER_WS_ENDPOINT });
    const page = await browser.newPage();
    await page.setContent(wrapStandalone(report, css), { waitUntil: "networkidle0", timeout: 20000 });
    const buffer = await page.pdf({
      format: "Letter",
      printBackground: true,
      margin: { top: "0.4in", bottom: "0.5in", left: "0.4in", right: "0.4in" }
    });
    return { configured: true, rendered: true, buffer };
  } finally {
    clearTimeout(timeout);
    if (browser) {
      try { await browser.close(); } catch { /* already gone */ }
    }
  }
}

async function defaultConnect(opts) {
  // Loaded lazily: puppeteer-core is only required when a browser endpoint
  // is actually configured, so its absence never breaks a deployment that
  // isn't using PDF generation.
  const puppeteer = require("puppeteer-core");
  return puppeteer.connect(opts);
}

module.exports = { renderPdf, isConfigured, wrapStandalone };
