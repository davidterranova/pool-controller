// The page reads each state message's entity id the way the controller's ESPHome sends it, and reloads itself when
// the controller comes back on another firmware.
import { test } from "node:test";
import assert from "node:assert/strict";
import { entityId, firmwareChanged } from "../esphome-hass.js";

test("ESPHome 2026.11: the id is « domain/Name »", () => {
  assert.equal(entityId({ id: "sensor/Pool Return Temperature", state: "13.2 °C" }), "sensor/Pool Return Temperature");
});

test("before 2026.11: name_id wins over the « domain-object_id » id", () => {
  assert.equal(entityId({ id: "select-manual_override", name_id: "select/Manual Override" }), "select/Manual Override");
});

test("an old-style id alone, or no id, is ignored", () => {
  assert.equal(entityId({ id: "sensor-wifi_signal" }), null);
  assert.equal(entityId({}), null);
});

test("a firmware update reloads the page, a reboot on the same firmware doesn't", () => {
  assert.equal(firmwareChanged(null, "v1.10.0"), false, "the first one seen, at load");
  assert.equal(firmwareChanged("v1.10.0", "v1.10.0"), false);
  assert.equal(firmwareChanged("v1.10.0", "v1.11.0"), true);
  assert.equal(firmwareChanged("v1.10.0", ""), false, "a firmware that doesn't say");
});
