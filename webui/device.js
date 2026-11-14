/*
 * The page as the device serves it. `make webui` bundles this file into webui/dist/device.js, which
 * the firmware embeds (web_server: js_include) and serves as /0.js; app.css becomes /0.css
 * (css_include). ESPHome's own index.html then only loads those two, so everything else comes from
 * here.
 *
 * Imports run in order: the shell first (device-shell.js builds the page from webui/index.html), then
 * Home Assistant's card, then the app, which looks up the shell's elements as it loads.
 */
import "./device-shell.js";
import "./piscine-card.js";
import "./app.js";
