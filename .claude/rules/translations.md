# Every user-facing text ships in English, French and Spanish

The controller's interface is translated (plan: [docs/plans/i18n.md](../../docs/plans/i18n.md)). Any feature or change that adds, edits or removes text a person reads must keep all three languages complete **in the same change**. This covers the card, the controller's page and wizard, the install page, the Home Assistant files and the firmware's states.

## Where text goes

- **Card** (`home-assistant/piscine-card.js`): never a literal. Use `this._t("key", vars)` and add the key to `home-assistant/i18n/{en,fr,es}.json`. The helpers outside the class use `T("key")` and `F` (formats), the language of the card being drawn (`_use()`). A key built at run time is `t(\`card.row.${key}.label\`)`, so the check sees its prefix. French that must stay as it is (an older firmware's states, `LEGACY_STATUS`) carries `// i18n-ignore` on its line. The device page shows the card too.
- **Controller's page and wizard** (`webui/`): `t()` from `page-i18n.js`, with keys in `webui/i18n-page/{en,fr,es}.json` (the card's keys work too: reuse `common.*` and the card's words for what both show). Static HTML takes `data-i18n="key"` (an element's text) or `data-i18n-<attribute>="key"`. A cache of what was drawn includes `pageLang()`, so a change of language redraws.
- **Install page** (`docs/install/`): its own `en`, `fr` and `es` dictionaries (`docs/install/i18n/`). In `index.html`, `data-i18n="key"` on the element (`data-i18n-aria-label="key"` for an attribute); in the scripts, `t()`. No markup in its texts: a command, an address, a link or one of ESP Web Tools' English buttons is a `{placeholder}` filled by `snippets()` (`install-i18n.js`).
- **Firmware** (`*.yaml`, `*.h`):
  - a state a person reads is a **code** (ASCII, lower snake case, `:` before an argument: `pending:fill`), never a sentence in any language. Translate the code in the UIs' `status.*` keys;
  - entity `name`s stay English;
  - **an existing entity name, entity id, select option or code that is already published is never renamed**: the card, the dashboard, users' automations and the recorder's history depend on them. Add a new code rather than change one;
  - log messages stay English.
- **Home Assistant files** (dashboard, scripts, blueprints under `home-assistant/`):
  - the per-language files are generated: edit the template (`*.tmpl.yaml`, a text as `{{t:key}}`) and the texts in `home-assistant/i18n-yaml/{en,fr,es}.json`, then run `make ha-files`. Never edit a generated file;
  - script ids, fields and options are the card's API: they stay in the template, identical in every language, never translated.
- **Formatting:** numbers, dates and times through the `fmt` helpers (`Intl`), never a hard-coded locale such as `"fr-FR"`.

## How to translate

- Translate everything a person reads, product terms included: the speeds (Low/Medium/High), « Override », Auto's label. Only codes stay untranslated: what the firmware publishes, and the values sent to HA (`vitesse: Low`). A label shows the word, and the code is what's sent.
- Write real translations in all three languages. Never copy the English into `fr` or `es`, and never leave a key empty or `TODO`.
- Your Spanish (and any later language) is a draft. Before a release, `make i18n-export` produces a plain Markdown file that the owner runs through a translation tool, and `make i18n-import` brings it back. A key is the only context the translator gets, so name keys after where they show (`card.settings.fill.alarm_after`, not `text42`).
- Follow the glossary (`tools/i18n/glossary.json`), so a term reads the same everywhere. A new term goes there first. A text that is exactly a term must be the glossary's word (`make i18n-check`, `make i18n-import`); in a sentence, use the same word.
- Write English that a machine can't misread: a status as a status, not a bare verb (« Speed forced to {speed} for {duration} », not « Override {speed} for {duration} », which a tool translated as a command).
- Keep `{placeholders}` and markup (`<b>`) identical across languages. A plural is an object of CLDR forms (`{"one": "{count} day", "other": "{count} days"}`), with the forms each language uses.
- A text that is the same as English on purpose (« Auto ») goes in `SAME_AS_ENGLISH` (`tools/i18n/surfaces.mjs`); the check refuses any other copy.
- Spanish and French run longer than English: check the card at 390 px and the page's buttons and tabs for overflow (`make card-shots`, the mock). `make card-preview-check` runs every situation in each language and fails on a key shown instead of a text.
- Remove a key from all three files when its text goes away.

## Before committing

- Run `make i18n-check` (keys, placeholders, plurals, markup, copies of English, keys used but missing; on a strict surface also unused keys and French left in the sources; the generated HA files up to date), `make webui-test` and `make ha-dashboard-check`.
- Once a surface is fully translated, its WP sets `strict: true` in `tools/i18n/surfaces.mjs`: from then on a leftover literal fails the check.
- Docs stay English: quote a UI label in English with the French in brackets: « Settings » (« Réglages »).

## Until the i18n feature is merged

Until `home-assistant/i18n/` exists on the branch you work from, the plan is still in progress. Write new text the way the surrounding code does. List it in the plan's I7 section (« strings brought in from main »), so the feature branch translates it when it merges main.
