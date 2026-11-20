// make i18n-export: every surface's texts, in English, as one Markdown file for any translation tool:
// one paragraph per text, its id in the HTML comment above it. make i18n-import reads the translation back.
//
//   node tools/i18n/export.mjs [--out .i18n/translations.en.md]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { exportMarkdown, FALLBACK } from "./lib.mjs";

const args = process.argv.slice(2);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : `.i18n/translations.${FALLBACK}.md`;

const { markdown, count } = exportMarkdown(process.cwd());
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, markdown);
console.log(`${out}: ${count} text(s). Translate it, then: make i18n-import TO=<lang> FILE=<the translated file>`);
