# Every user-facing text ships in English, French and Spanish

The controller's interface is translated (plan: [docs/plans/i18n.md](../../docs/plans/i18n.md)). Any feature or change that adds, edits or removes text a person reads must keep all three languages complete **in the same change**. This covers the card, the controller's page and wizard, the install page, the Home Assistant files and the firmware's states.

## Where text goes

- **Card** (`home-assistant/piscine-card.js`): never a literal. Use `t("key", vars)` and add the key to `home-assistant/i18n/{en,fr,es}.json`. The device page shows the card too.
- **Controller's page and wizard** (`webui/`): `t()` with keys in `webui/i18n/{en,fr,es}.json`.
- **Install page** (`docs/install/`): its own `en`, `fr` and `es` dictionaries.
- **Firmware** (`*.yaml`, `*.h`):
  - a state a person reads is a **code** (ASCII, lower snake case, `:` before an argument: `pending:fill`), never a sentence in any language. Translate the code in the UIs' `status.*` keys;
  - entity `name`s stay English;
  - **an existing entity name, entity id, select option or code that is already published is never renamed**: the card, the dashboard, users' automations and the recorder's history depend on them. Add a new code rather than change one;
  - log messages stay English.
- **Home Assistant files** (`home-assistant/dashboard/*.<lang>.yaml`, `home-assistant/blueprints/`):
  - change the `en`, `fr` and `es` files together, with identical structure;
  - script ids, fields and options are the card's API: identical in every language, never translated.
- **Formatting:** numbers, dates and times through the `fmt` helpers (`Intl`), never a hard-coded locale such as `"fr-FR"`.

## How to translate

- Translate everything a person reads, product terms included: the speeds (Low/Medium/High), « Override », Auto's label. Only codes stay untranslated: what the firmware publishes, and the values sent to HA (`vitesse: Low`). A label shows the word, and the code is what's sent.
- Write real translations in all three languages. Never copy the English into `fr` or `es`, and never leave a key empty or `TODO`.
- Your Spanish (and any later language) is a draft. Before a release, `make i18n-export` produces a Markdown file that the owner machine-translates through Lokalise, and `make i18n-import` brings it back. The export gives the translator each key's context from its name and the files that use it, so name keys after where they show (`card.settings.fill.alarm_after`, not `text42`).
- Follow the glossary in docs/plans/i18n.md (I2), so a term reads the same everywhere.
- Keep `{placeholders}` and plural forms (`.one` / `.other`) identical across languages.
- Spanish and French run longer than English: check the card at 390 px and the page's buttons and tabs for overflow (`make card-shots`, the mock).
- Remove a key from all three files when its text goes away.

## Before committing

- Run `make i18n-check` (keys, placeholders, plurals, unused keys, French left in the sources), `make webui-test` and `make ha-dashboard-check` (parity of the HA files across languages).
- Docs stay English: quote a UI label in English with the French in brackets: « Settings » (« Réglages »).

## Until the i18n feature is merged

Until `home-assistant/i18n/` exists on the branch you work from, the plan is still in progress. Write new text the way the surrounding code does. List it in the plan's I7 section (« strings brought in from main »), so the feature branch translates it when it merges main.
