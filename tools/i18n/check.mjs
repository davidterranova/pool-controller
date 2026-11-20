// make i18n-check: every surface's dictionaries (tools/i18n/surfaces.mjs) complete and consistent in every
// language, and against the sources that use them. Fails on an error; prints the warnings (unused keys,
// French left in a source) of a surface not yet strict.
//
//   node tools/i18n/check.mjs
import { check } from "./lib.mjs";

const { errors, warnings, summary } = check(process.cwd());
for (const s of summary) console.log(`  ${s}`);
for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`error: ${e}`);
if (errors.length) {
  console.log(`\ni18n-check: ${errors.length} error(s)`);
  process.exit(1);
}
console.log(`i18n-check: ok${warnings.length ? ` (${warnings.length} warning(s))` : ""}`);
