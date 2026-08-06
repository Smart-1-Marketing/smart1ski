"use strict";
/* These tests verify the orchestration logic Claude wrote — request shape,
   graceful degradation, error handling — against mocked fetch/browser calls.
   They CANNOT verify that Cloudinary, OpenAI, or a real headless browser
   actually accept these exact requests, because this environment has no
   network path to any of them. Run each integration once against real
   credentials before relying on it in production. */

const fail = [];
const ok = (label, cond) => { console.log((cond ? "  ✓ " : "  ✗ ") + label); if (!cond) fail.push(label); };

async function main() {
  console.log("cloudinary — signing");
  {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;
    const cloudinary = require("../lib/cloudinary");

    ok("reports unconfigured when no env vars are set", !cloudinary.isConfigured());
    const r1 = await cloudinary.uploadPdf(Buffer.from("x"), "test-id");
    ok("uploadPdf no-ops cleanly when unconfigured", r1.configured === false && r1.uploaded === false);

    // Signature construction: sorted keys, joined, secret appended, sha1'd.
    // This checks OUR algorithm is internally consistent and matches
    // Cloudinary's documented construction — it is not a live API call.
    const crypto = require("crypto");
    const params = { timestamp: 1700000000, public_id: "abc", folder: "x/y" };
    const secret = "shh";
    const expected = crypto.createHash("sha1")
      .update("folder=x/y&public_id=abc&timestamp=1700000000" + secret)
      .digest("hex");
    ok("signature matches the documented sort-join-append-sha1 construction",
       cloudinary.sign(params, secret) === expected);
    ok("signature changes if any parameter changes",
       cloudinary.sign({ ...params, public_id: "different" }, secret) !== expected);
    ok("signature changes if the secret changes",
       cloudinary.sign(params, "other-secret") !== expected);

    process.env.CLOUDINARY_CLOUD_NAME = "demo";
    process.env.CLOUDINARY_API_KEY = "123";
    process.env.CLOUDINARY_API_SECRET = "shh";
    ok("reports configured once all three env vars are set", cloudinary.isConfigured());

    // Mock the network call and confirm the upload path builds a real
    // multipart request against the expected Cloudinary endpoint shape.
    const realFetch = global.fetch;
    let captured = null;
    global.fetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        text: async () => JSON.stringify({ secure_url: "https://res.cloudinary.com/demo/raw/upload/v1/x.pdf", bytes: 42, public_id: "smart1ski/reports/test-id" })
      };
    };
    const r2 = await cloudinary.uploadPdf(Buffer.from("%PDF-1.4 fake"), "test-id");
    global.fetch = realFetch;

    ok("uploads to the resource-appropriate raw/upload endpoint", captured.url.includes("/raw/upload"));
    ok("cloud name from env is in the URL", captured.url.includes("/demo/"));
    ok("POST with multipart form body", captured.opts.method === "POST" && captured.opts.body instanceof FormData);
    ok("returns the secure_url from a successful upload", r2.uploaded === true && r2.url.startsWith("https://res.cloudinary.com"));

    // Failure path: caller must be able to tell upload failed without a throw.
    global.fetch = async () => ({ ok: false, text: async () => "quota exceeded" });
    try {
      await cloudinary.uploadPdf(Buffer.from("x"), "test-id-2");
      ok("upload failure throws (caller wraps in try/catch)", false);
    } catch (err) {
      ok("upload failure throws with a readable message", /quota exceeded/.test(err.message));
    }
    global.fetch = realFetch;
  }

  console.log("\npdf — orchestration");
  {
    delete process.env.PDF_BROWSER_WS_ENDPOINT;
    const pdfModel = require("../lib/pdf");

    ok("reports unconfigured with no browser endpoint set", !pdfModel.isConfigured());
    const r1 = await pdfModel.renderPdf({ resort: { name: "Test" } }, "body{color:red}");
    ok("renderPdf no-ops cleanly when unconfigured", r1.configured === false && r1.rendered === false);

    process.env.PDF_BROWSER_WS_ENDPOINT = "wss://example.invalid/fake";
    ok("reports configured once the endpoint is set", pdfModel.isConfigured());

    // Reuses the exact same markup() the browser renders — this is the whole
    // point: one report, not two documents that can drift apart.
    const sampleReport = {
      generated_at: new Date().toISOString(),
      resort: {
        name: "Mad Mountain", location: "Gahanna, OH", latitude: 40.02, longitude: -82.87,
        coordinates_source: "ZIP centroid", operating_months: "November–March"
      },
      contact: { name: "Todd" },
      climate: {
        seasons_analyzed: 6, season_years: [], total_season_weeks: 0,
        units_reported_by_source: { snowfall: "in", temperature: "F" },
        elevation_adjustment: { applied: false, note: "test" }
      },
      historical_weekly_plan: [], audience: { feeder_markets: [] }, savings_model: { protected_budget_uses: [] },
      budget_plan: { channels: [], delivery_variance_factors: [] },
      recommended_targets: { geofence_categories: [], dooh_venue_categories: [], lookback_strategy: [] },
      trigger_plan: [], campaign_phases: [], disclosures: [],
      weather_marketing_readiness: {}, pricing_tiers: { tiers: [] }, vs_traditional: { rows: [] }
    };
    const html = pdfModel.wrapStandalone(sampleReport, "body{color:blue}");
    ok("standalone HTML includes the resort name", html.includes("Mad Mountain"));
    ok("standalone HTML embeds the report stylesheet", html.includes("color:blue"));
    ok("standalone HTML has no leftover toolbar (standalone mode)", !html.includes('data-act="print"'));

    // Fake a browser: confirm the orchestration calls connect with the right
    // endpoint, sets content, requests a PDF, and always closes the browser
    // — including when page.pdf() throws, which is the case that leaks
    // browser instances if close() lives in the wrong place.
    let calls = [];
    const fakeBrowser = (shouldThrow) => ({
      newPage: async () => ({
        setContent: async (html2, opts2) => { calls.push(["setContent", html2.length, opts2]); },
        pdf: async (opts2) => {
          calls.push(["pdf", opts2]);
          if (shouldThrow) throw new Error("page crashed");
          return Buffer.from("%PDF-1.4 fake bytes");
        }
      }),
      close: async () => { calls.push(["close"]); }
    });

    calls = [];
    const okDeps = { connect: async (opts2) => { calls.push(["connect", opts2]); return fakeBrowser(false); } };
    const r2 = await pdfModel.renderPdf(sampleReport, "body{}", okDeps);
    ok("connects to the configured WS endpoint", calls[0][0] === "connect" && calls[0][1].browserWSEndpoint === "wss://example.invalid/fake");
    ok("prints with background graphics enabled (colors, not just text)", calls.find((c) => c[0] === "pdf")[1].printBackground === true);
    ok("returns a real buffer on success", r2.rendered === true && Buffer.isBuffer(r2.buffer));
    ok("closes the browser after a successful render", calls[calls.length - 1][0] === "close");

    calls = [];
    const throwDeps = { connect: async () => fakeBrowser(true) };
    try {
      await pdfModel.renderPdf(sampleReport, "body{}", throwDeps);
      ok("a page crash propagates to the caller", false);
    } catch (err) {
      ok("a page crash propagates to the caller", /page crashed/.test(err.message));
    }
    ok("browser is still closed after a crash (no leaked instance)", calls.some((c) => c[0] === "close"));

    delete process.env.PDF_BROWSER_WS_ENDPOINT;
  }

  console.log("\nnarrative — fact-sheet discipline and graceful degradation");
  {
    delete process.env.OPENAI_API_KEY;
    const narrative = require("../lib/narrative");

    ok("reports unconfigured with no API key set", !narrative.isConfigured());
    const r1 = await narrative.generateSummary({ resort: { name: "x" } });
    ok("generateSummary no-ops cleanly when unconfigured", r1.configured === false && r1.generated === false);

    process.env.OPENAI_API_KEY = "sk-fake-for-testing";
    ok("reports configured once the key is set", narrative.isConfigured());

    const sampleReport = {
      resort: { name: "Mad Mountain", location: "Gahanna, OH", operating_months: "November–March" },
      climate: { seasons_analyzed: 6, total_season_weeks: 20, avg_qualified_ad_days: 3.4, avg_suppressed_days: 1.1 },
      weather_marketing_readiness: { score: 68, band: "Strong weather-trigger market" },
      historical_weekly_plan: [
        { recommendation: "Aggressive activation" }, { recommendation: "Aggressive activation" },
        { recommendation: "Hold or use future-date offers" }
      ],
      audience: { estimated_targeted_skiing_households: 18900, feeder_markets: ["Columbus", "Cleveland"] },
      savings_model: { always_on_season_spend: 30000, modeled_trigger_controlled_spend: 22800, estimated_budget_protected: 7200, estimated_budget_protected_percent: 24 },
      budget_plan: { budget: 6000, objective: "lift_tickets", channels: [{ channel: "Connected TV", share_percent: 36 }] }
    };

    const facts = narrative.factSheet(sampleReport);
    ok("fact sheet carries the readiness score exactly (68)", facts.readiness_score === 68);
    ok("fact sheet carries budget protected exactly ($7,200)", facts.estimated_budget_protected === 7200);
    ok("fact sheet derives week counts from the actual weekly array (2 aggressive, 1 hold)",
       facts.strong_activation_weeks === 2 && facts.hold_weeks === 1);
    ok("fact sheet does NOT include arbitrary/unlisted report fields", !("generated_at" in facts) && !("contact" in facts));

    let captured = null;
    const okDeps = {
      fetch: async (url, opts2) => {
        captured = { url, opts: opts2 };
        return {
          ok: true,
          text: async () => JSON.stringify({ choices: [{ message: { content: "Mad Mountain shows a readiness score of 68..." } }] })
        };
      }
    };
    const r2 = await narrative.generateSummary(sampleReport, okDeps);
    const sentBody = JSON.parse(captured.opts.body);

    ok("calls the OpenAI chat completions endpoint", captured.url === "https://api.openai.com/v1/chat/completions");
    ok("sends the API key as a bearer token, not in the URL or body", captured.opts.headers.Authorization === "Bearer sk-fake-for-testing" && !captured.url.includes("sk-fake"));
    ok("system prompt forbids inventing numbers", /never invent|ONLY the numbers/i.test(sentBody.messages[0].content));
    ok("system prompt forbids new calculations", /Do not perform new calculations/i.test(sentBody.messages[0].content));
    ok("user message carries this report's actual figures (7200, 18900)",
       sentBody.messages[1].content.includes("7200") && sentBody.messages[1].content.includes("18900"));
    ok("returns the generated text on success", r2.generated === true && r2.text.includes("Mad Mountain"));

    // Failure and timeout paths must degrade, never throw.
    const failDeps = { fetch: async () => ({ ok: false, text: async () => "rate limited" }) };
    const r3 = await narrative.generateSummary(sampleReport, failDeps);
    ok("an API error degrades to generated:false without throwing", r3.configured === true && r3.generated === false && /rate limited/.test(r3.error));

    const throwDeps = { fetch: async () => { throw new Error("network down"); } };
    const r4 = await narrative.generateSummary(sampleReport, throwDeps);
    ok("a network exception degrades to generated:false without throwing", r4.generated === false && /network down/.test(r4.error));

    delete process.env.OPENAI_API_KEY;
  }

  console.log("\nserver — non-blocking when neither integration is configured");
  {
    // No PDF_BROWSER_WS_ENDPOINT, no CLOUDINARY_*, no OPENAI_API_KEY.
    // The pipeline test (test/pipeline.test.js) already proves /api/analyze
    // returns ok:true end to end in exactly this state — this just confirms
    // the report shape carries the new (empty) fields rather than crashing
    // JSON.stringify or the client renderer on an undefined access.
    const reportModel = require("../lib/report");
    const r = reportModel.build({
      body: { resort_name: "X", zip_code: "43230", season_start_month: 11, season_end_month: 3, monthly_budget: 6000, contact_name: "T", contact_email: "t@x.com" },
      site: { zip_code: "43230", city: "Gahanna", state: "OH", latitude: 40, longitude: -82.9, coordinates_source: "ZIP centroid", site_elevation_ft: 900, base_elevation_ft: 900, elevation_source: "test" },
      climate: { seasons_analyzed: 6, season_years: [], weekly: [], total_season_weeks: 0, rules: {}, units_reported_by_source: { snowfall: "in", temperature: "F" }, elevation_adjustment: {} },
      audience: { estimated_targeted_skiing_households: 1000, feeder_households_used: 100000, feeder_markets: [], markets: [] },
      outlook: null
    });
    r.narrative_summary = null;
    r.pdf = { configured: false, url: null };
    const serialized = JSON.stringify(r);
    ok("report with empty integration fields still serializes cleanly", typeof serialized === "string" && serialized.length > 0);

    const { markup } = require("../public/report.js");
    const html = markup(r, {});
    ok("report renders with no narrative section when narrative_summary is null", !html.includes("narrative-block"));
    ok("toolbar falls back to the print button when no hosted PDF exists", html.includes('data-act="print"'));
  }

  console.log(fail.length ? `\n✗ ${fail.length} failing\n` : "\n✓ all checks passed\n");
  process.exit(fail.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
