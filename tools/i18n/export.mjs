// make i18n-export: every surface's texts, in English, as one Markdown file to machine-translate (Lokalise),
// each text's id and context in the HTML comment above it. make i18n-import reads the translation back.
//
//   node tools/i18n/export.mjs [--from en] [--out .i18n/translations.en.md]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { exportMarkdown, FALLBACK } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const from = opt("--from", FALLBACK);
const out = opt("--out", `.i18n/translations.${from}.md`);
const glossary = JSON.parse(readFileSync(new URL("./glossary.json", import.meta.url), "utf8"));

const { markdown, count } = exportMarkdown(process.cwd(), { from, glossary });
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, markdown);
console.log(`${out}: ${count} text(s) in ${from}. Translate it, then: make i18n-import TO=<lang> FILE=<the translated file>`);
