// make i18n-import: a file make i18n-export wrote, once translated (by any tool), back into every surface's
// <lang>.json. Refuses a text whose placeholders or markup changed (the draft stays), and lists what changed
// against the draft, for a look in the PR. Exit 1 when a text was refused or one is missing.
//
//   node tools/i18n/import.mjs --to es [--dry-run] <translated.md>
import { readFileSync } from "node:fs";
import { importEntries, parseMarkdown, LANGS, FALLBACK } from "./lib.mjs";

const args = process.argv.slice(2);
const to = args.includes("--to") ? args[args.indexOf("--to") + 1] : null;
const dryRun = args.includes("--dry-run");
const file = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--to").pop();
if (!to || !file) {
  console.error("usage: node tools/i18n/import.mjs --to <lang> [--dry-run] <translated.md>");
  process.exit(2);
}
if (to === FALLBACK) {
  console.error(`${FALLBACK} is the source language: edit its dictionaries directly.`);
  process.exit(2);
}
if (!LANGS.includes(to)) console.warn(`warning: ${to} isn't in LANGS (home-assistant/i18n.js) yet: add it there too.`);

const entries = parseMarkdown(readFileSync(file, "utf8"));
const r = importEntries(process.cwd(), entries, { to, dryRun });
const show = (v) => (v === undefined ? "(none)" : JSON.stringify(v));
console.log(`${file}: ${entries.size} text(s) read`);
for (const c of r.changed) console.log(`changed  ${c.id}\n         ${show(c.from)}\n      →  ${show(c.to)}`);
for (const x of r.refused) console.log(`refused  ${x.id}: ${x.why}\n         ${show(x.text)}`);
for (const id of r.missing) console.log(`missing  ${id}`);
for (const id of r.unknown) console.log(`unknown  ${id} (not a key any more: ignored)`);
console.log(`${dryRun ? "would write" : "wrote"} ${r.written.join(", ") || "nothing"}: ${r.changed.length} changed, ${r.refused.length} refused, ${r.missing.length} missing`);
if (r.refused.length || r.missing.length) process.exit(1);
