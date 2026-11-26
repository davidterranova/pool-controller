# The characters of the font glyph sets the panel's fonts use (local-panel.yaml, font: glyphsets:), as ESPHome's
# own esphome-glyphsets has them: make panel-glyphsets writes tools/i18n/panel-glyphsets.json, which
# tools/i18n/panel-header.mjs reads to refuse a text a font can't draw. Runs in the ESPHome image.
import importlib.metadata
import json

import esphome_glyphsets as glyphsets

SETS = ["GF_Latin_Core"]

about = (
    "The characters of the font glyph sets the panel uses (local-panel.yaml, font: glyphsets:), from "
    f"esphome-glyphsets {importlib.metadata.version('esphome-glyphsets')} in the ESPHome image: "
    "tools/i18n/panel-header.mjs fails when a text needs a character no font covers. Regenerate with make panel-glyphsets."
)
out = {"about": about}
for name in SETS:
    out[name] = "".join(chr(c) for c in sorted(set(glyphsets.unicodes_per_glyphset(name))))
print(json.dumps(out, ensure_ascii=False, indent=2))
