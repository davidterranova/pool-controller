// The page reads each state message's entity id the way the controller's ESPHome sends it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { entityId } from "../esphome-hass.js";

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
