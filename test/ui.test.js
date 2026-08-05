/* Loads index.html in jsdom (with report.js inlined, since jsdom will not
   fetch /report.js), walks the intake, submits, and inspects the report. */

const { JSDOM, requestInterceptor } = require("jsdom");
const fs = require("fs");
const path = require("path");

const REPORT = JSON.parse(fs.readFileSync("test/.report.json", "utf8"));

// Serve /report.js and /styles.css from disk exactly as the real server would,
// so script load order and parsing are exercised for real rather than spliced.
const fromDisk = requestInterceptor((request) => {
  const file = path.join("public", new URL(request.url).pathname);
  if (!fs.existsSync(file)) return undefined;
  return new Response(fs.readFileSync(file, "utf8"), {
    headers: { "Content-Type": file.endsWith(".css") ? "text/css" : "application/javascript" }
  });
});

const dom = new JSDOM(fs.readFileSync("public/index.html", "utf8"), {
  runScripts: "dangerously",
  resources: { interceptors: [fromDisk] },
  pretendToBeVisual: true,
  url: "https://smart1ski.onrender.com/",
  beforeParse(window) {
    window.__opened = null;
    window.fetch = async () => ({
      status: 200,
      json: async () => ({ ok: true, webhook: { configured: true, delivered: true }, report: REPORT })
    });
    window.print = () => {};
    window.open = () => {
      const w = { document: { write: (s) => { window.__opened = s; }, close: () => {} }, setInterval: () => 0, clearInterval: () => {} };
      return w;
    };
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.URL.createObjectURL = () => "blob:x";
    window.URL.revokeObjectURL = () => {};
  }
});

const { window } = dom;
const { document } = window;

window.addEventListener("load", () => {
  const fail = [];
  const ok = (label, cond, extra) => {
    console.log((cond ? "  ✓ " : "  ✗ ") + label + (extra ? "  " + extra : ""));
    if (!cond) fail.push(label);
  };
  const $ = (s) => document.querySelector(s);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
  const at = (n) => $(`.step[data-step='${n}']`).classList.contains("is-current");

  console.log("\nintake");
  ok("7 steps in the rail", document.querySelectorAll(".rail-step").length === 7);
  ok("honeypot present, off-screen, unlabelled", !!$(".trap #s1_qx7") && !$(".trap label"));
  ok("no wall-clock stamp to skew", !document.querySelector('[name="form_started_at"]'));
  ok("season defaults to November–March",
    document.getElementById("season_start_month").value === "11" &&
    document.getElementById("season_end_month").value === "3");

  document.getElementById("nextBtn").click();
  ok("empty required field blocks Continue", at(1) && !!$(".field.is-invalid"));

  set("resort_name", "Hollow Ridge Mountain");
  set("zip_code", "432");
  document.getElementById("nextBtn").click();
  ok("bad ZIP blocks Continue", at(1));

  set("zip_code", "16341");
  set("base_elevation_ft", "1150");
  set("summit_elevation_ft", "900");
  document.getElementById("nextBtn").click();
  ok("summit below base blocks Continue", at(1));

  set("summit_elevation_ft", "2400");
  document.getElementById("nextBtn").click();
  ok("valid step 1 advances", at(2));

  console.log("\nbooking window drives the floor");
  const floor = document.getElementById("minimum_activation_share");
  ok("floor prefilled from default booking window (35%)", floor.value === "35", `(${floor.value})`);

  const booking = document.getElementById("booking_window");
  booking.value = "season";
  booking.dispatchEvent(new window.Event("change"));
  ok("floor stays at the 35% default whatever the booking window", floor.value === "35", `(${floor.value})`);
  ok("booking note explains the lead", /Media lead/.test(document.getElementById("bookingNote").textContent));

  booking.value = "week";
  booking.dispatchEvent(new window.Event("change"));
  floor.value = "42";
  floor.dispatchEvent(new window.Event("input"));
  booking.value = "season";
  booking.dispatchEvent(new window.Event("change"));
  ok("a floor the user typed is not overwritten", floor.value === "42", `(${floor.value})`);

  booking.value = "week";
  booking.dispatchEvent(new window.Event("change"));

  document.getElementById("nextBtn").click(); // 3
  set("target_markets", "Columbus\nPittsburgh\nCleveland");
  document.getElementById("nextBtn").click(); // 4
  set("competitors", "Mad River Mountain");
  set("current_media", "Paid social and some Google Ads");
  document.getElementById("nextBtn").click(); // 5
  set("monthly_budget", "500");
  document.getElementById("nextBtn").click();
  ok("out-of-range budget blocks Continue", at(5));
  set("monthly_budget", "6000");
  document.getElementById("nextBtn").click(); // 6
  set("contact_name", "Dana Reyes");
  set("contact_email", "nope");
  document.getElementById("nextBtn").click();
  ok("bad email blocks Continue", at(6));
  set("contact_email", "dana@hollowridge.com");
  document.getElementById("nextBtn").click(); // 7

  const review = document.getElementById("reviewList").textContent;
  ok("review reached", at(7));
  ok("review shows the base elevation", review.includes("1,150 ft"));
  ok("review shows the booking window", /week/i.test(review));

  document.getElementById("intake").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));

  setTimeout(() => {
    if (!window.Smart1Report) console.log("  !! window.Smart1Report is undefined — report.js did not load");
    const fe = document.getElementById("formError");
    if (fe && fe.style.display !== "none") console.log("  !! form error shown:", fe.textContent);
    const rpt = document.getElementById("report");
    const text = rpt.textContent;
    const html2 = rpt.innerHTML;

    console.log("\nreport");
    ok("empty state replaced", !document.getElementById("empty"));
    ok("resort on the board", text.includes(REPORT.resort.name));
    ok("readiness band on the board", text.includes(REPORT.weather_marketing_readiness.band));
    ok("media lead on the board", /Media lead/i.test(text));

    ok("provenance section names the declared snowfall unit", text.includes("cm"));
    ok("elevation correction explained", /Elevation corrected/.test(text));
    ok("reclassified days reported", /reclassified as snow/.test(text));

    const bars = rpt.querySelectorAll(".seasonboard svg rect");
    ok("season board drew qualified + activation bars", bars.length >= REPORT.historical_weekly_plan.length * 2);
    ok("no unresolved CSS vars in SVG", !html2.includes('fill="var('));

    ok("weekly table has the weekend column", /Of those, weekend/.test(text));
    ok("weekly table has the in-market column", /In market/.test(text));

    ok("16-day outlook rendered", /next 16 days/i.test(text));
    ok("outlook rows present", rpt.querySelectorAll("table").length >= 4);

    ok("per-market table rendered", REPORT.audience.markets.every((m) => text.includes(m.name)));
    ok("distances shown", /\d+ mi/.test(text));
    ok("relevance percentages shown", text.includes(REPORT.audience.markets[0].drive_relevance_percent + "%"));

    ok("budget verdict shown", text.includes("Read this before you quote the number"));
    ok("floor source explained", /floor is set by the booking window/i.test(text));
    ok("'not a refund' framing kept", /not a refund/.test(text));

    ok("score rubric with 4 bars", rpt.querySelectorAll(".scorebar").length === 4);
    ok("bands published", /strong weather-trigger market/i.test(text));

    ok("current-media gap analysis shown", /running today/i.test(text));
    ok("all four channels", text.includes("Connected TV") && text.includes("Data-Driven Targeted Display") &&
     text.includes("Streaming Radio and Podcasts") && text.includes("Digital Out-of-Home"));
  ok("no newspaper or news-site language", !/newspaper|news site|news sites/i.test(text));
  ok("campgrounds and state parks are targeted", /campground/i.test(text) && /state park/i.test(text));
  ok("DOOH venues listed", /gas station/i.test(text) && /bars/i.test(text));
  ok("outdoor-recreation lookback present", /Outdoor-recreation lookback/i.test(text));
    ok("search/social exclusion stated", /Paid search and paid social are intentionally excluded/.test(text));

    ok("8 triggers with timing", rpt.querySelectorAll(".trigger").length === 8 && /Timing/.test(text));
    ok("freeze, frost, and ice storm triggers present",
       /Freeze Warning/.test(text) && /Frost Advisory/.test(text) && /Ice Storm/.test(text));
    ok("good/better/best tiers rendered", rpt.querySelectorAll(".tier").length === 3 && /Recommended for this market/.test(text));
    ok("budget disclaimer with consult link present",
       /suggested budget/i.test(text) &&
       !!rpt.querySelector('a[href="https://smart1marketing.com/skimarketingconsult"]'));
    ok("traditional comparison rendered", /cannot be weather-controlled/.test(text) && !!rpt.querySelector("table.vs"));
    ok("final CTA panel with gold button", !!rpt.querySelector(".cta-btn"));
    ok("5 phases", rpt.querySelectorAll(".phase").length === 5);
    ok("9 disclosures", rpt.querySelectorAll(".fineprint li").length === 9);
    ok("no stray undefined/NaN", !/\bundefined\b|\bNaN\b/.test(text));

    console.log("\nstandalone report window");
    rpt.querySelector('[data-act="open"]').click();
    const opened = window.__opened || "";
    ok("new window opened", opened.length > 0);
    ok("links the shared stylesheet", opened.includes("/styles.css"));
    ok("loads the shared renderer", opened.includes("/report.js"));
    ok("has its own print button", /window.print\(\)/.test(opened));
    ok("titled with the resort", opened.includes(REPORT.resort.name));

    console.log(fail.length ? `\n✗ ${fail.length} failing\n` : "\n✓ all checks passed\n");
    process.exit(fail.length ? 1 : 0);
  }, 300);
});
