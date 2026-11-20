// The interface's translated surfaces (docs/plans/i18n.md): where each one's dictionaries are, and where its
// keys are used. make i18n-check, make i18n-export and make i18n-import read this list; a surface whose
// folder doesn't exist yet is skipped.
//
//   dir       the dictionaries, one <lang>.json per language of LANGS (home-assistant/i18n.js)
//   sources   the files that use the keys (globs: one `*` in the file name), never a symlink: the page's
//             webui/piscine-card.js is the card's file, counted once under `card`
//   usage     "code": t("key") / this._t('key') / t(`prefix.${…}`) (a used prefix); "template": {{t:key}}
//   reads     other surfaces whose keys these sources may also use (the page shows the card, so it reads its keys)
//   strict    once the surface is fully translated (its WP done): a key no source uses, or a French-looking
//             literal left in its sources, fails the check instead of being reported
export const SURFACES = [
  {
    id: "card", title: "Home Assistant card (also on the controller's page)",
    dir: "home-assistant/i18n", sources: ["home-assistant/piscine-card.js"], usage: "code", reads: [], strict: false,
  },
  {
    id: "page", title: "The controller's own page and its setup wizard",
    dir: "webui/i18n-page", sources: ["webui/*.js", "webui/index.html"], usage: "code", reads: ["card"], strict: false,
  },
  {
    id: "install", title: "The install page",
    dir: "docs/install/i18n", sources: ["docs/install/*.js", "docs/install/index.html"], usage: "code", reads: [], strict: false,
  },
  {
    id: "yaml", title: "Home Assistant dashboard, scripts and blueprints",
    dir: "home-assistant/i18n-yaml", sources: ["home-assistant/dashboard/*.tmpl.yaml", "home-assistant/blueprints/*.tmpl.yaml"],
    usage: "template", reads: [], strict: false,
  },
];

// Keys whose text is the same as English on purpose (a product name, a word every language uses), as
// "<surface>:<key>". Any other fr or es text identical to the English one is taken for an untranslated copy.
export const SAME_AS_ENGLISH = ["card:common.mode.auto"];
