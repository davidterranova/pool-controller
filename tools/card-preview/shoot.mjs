// Drives tools/card-preview/ headless, in Playwright's image (the Makefile's card-shots and card-preview-check):
//
//   node tools/card-preview/shoot.mjs [--only <scenario>[,<scenario>…]]   screenshots into tools/card-preview/shots/
//   node tools/card-preview/shoot.mjs --check                            every scenario and tab, no screenshot
//
// Screenshots: each scenario's tile and panel (on its own tab) at 390 px and 760 px, light and dark, reduced motion,
// at a fixed time (FIXED, Europe/Paris), so two runs draw the same. The check loads every scenario on each of the
// panel's tabs, at both widths, and fails on a page error, a console error, or « undefined », « NaN » or
// « [object Object] » in what the card shows.
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, ".card-preview", "package.json"));
const { chromium } = require("playwright-core");

const FIXED = new Date("2026-07-14T16:20:00+02:00"); // a summer afternoon, in the plan's second block
const WIDTHS = [390, 760];
const TABS = ["pump", "settings", "controller"];
const OUT = path.join(ROOT, "tools", "card-preview", "shots");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".yaml": "text/plain", ".css": "text/css" };

const args = process.argv.slice(2);
const check = args.includes("--check");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;

// The repo, served read-only: the page fetches the card and the dashboard's YAML.
const server = createServer(async (req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" }).end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}/tools/card-preview/index.html`;

const browser = await chromium.launch();
const problems = [];
let shots = 0;

async function open(theme, width) {
  const ctx = await browser.newContext({ viewport: { width: width + 32, height: 900 }, colorScheme: theme, reducedMotion: "reduce",
    timezoneId: "Europe/Paris", locale: "fr-FR" });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(FIXED);
  const errors = [];
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  return { ctx, page, errors };
}
async function load(page, q) {
  await page.goto(`${base}?shot&${new URLSearchParams(q)}`);
  await page.waitForFunction(() => window.preview && window.preview.ready);
  await page.evaluate(() => window.preview.ready);
}
/** What the cards show: their rendered text (not their styles, nor what is hidden), for the check. */
const shown = (page) => page.evaluate(() => window.preview.cards
  .flatMap((c) => [...(c.shadowRoot ? c.shadowRoot.children : [])].map((el) => el.innerText || "")).join("\n"));

const list = async () => {
  const { ctx, page } = await open("light", 390);
  await load(page, { s: "normal" });
  const all = await page.evaluate(() => window.preview.scenarios);
  await ctx.close();
  return all;
};
const scenarios = (await list()).filter((s) => !only || only.includes(s.id));
if (!scenarios.length) { console.error(`no scenario ${only}`); process.exit(2); }

if (check) {
  for (const width of WIDTHS) {
    const { ctx, page, errors } = await open("light", width);
    for (const s of scenarios) for (const tab of TABS) {
      errors.length = 0;
      await load(page, { s: s.id, w: width, tab });
      const text = await shown(page);
      for (const bad of ["undefined", "NaN", "[object Object]"]) if (text.includes(bad)) errors.push(`shows « ${bad} »`);
      for (const e of errors) problems.push(`${s.id} ${tab} ${width} px: ${e}`);
    }
    await ctx.close();
  }
  console.log(`${scenarios.length} scenarios × ${TABS.length} tabs × ${WIDTHS.length} widths checked${problems.length ? "" : ": OK"}`);
} else {
  await mkdir(OUT, { recursive: true });
  for (const theme of ["light", "dark"]) for (const width of WIDTHS) {
    const { ctx, page, errors } = await open(theme, width);
    for (const s of scenarios) {
      errors.length = 0;
      await load(page, { s: s.id, w: width, theme, tab: s.tab });
      const file = path.join(OUT, `${s.id}-${width}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots++;
      for (const e of errors) problems.push(`${s.id} ${width} px ${theme}: ${e}`);
    }
    await ctx.close();
  }
  console.log(`${shots} screenshots in ${path.relative(ROOT, OUT)}/`);
}

await browser.close();
server.close();
for (const p of problems) console.error(`ERROR ${p}`);
process.exit(problems.length ? 1 : 0);
