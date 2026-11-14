/*
 * Builds the page inside ESPHome's index.html, which is only a <head> with a link to /0.css and a
 * <body> with the script that loads this bundle. The markup comes from webui/index.html, inlined as
 * text by the bundler, so the page the mock serves (make mock-webui) and the one on the device share
 * one source: its <title>, its named <meta> tags (viewport, color-scheme), and its whole <body>. Its
 * <script> and stylesheet tags are left out: on the device the bundle and /0.css replace them.
 */
import html from "./index.html";

const page = new DOMParser().parseFromString(html, "text/html");
document.documentElement.lang = page.documentElement.lang;
document.title = page.title;
for (const meta of page.head.querySelectorAll("meta[name]")) document.head.appendChild(meta);
document.body.replaceChildren(...page.body.childNodes);
