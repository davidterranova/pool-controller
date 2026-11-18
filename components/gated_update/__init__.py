"""gated_update: an update entity whose install is an automation.

It shows another update entity (its `source_id`, usually an `internal:`
http_request one) as it is: state, versions, progress, release URL. A check
goes straight to the source; an install, whoever asks (Home Assistant's
update.install, the device's page, a lambda calling perform()), only runs
`on_install`, which decides when to call `update.perform` on the source.

ESPHome has no template update platform, and http_request's own entity can't
be wrapped otherwise: both the API and web_server call the entity's virtual
perform() directly, and HttpRequestUpdate is final. See updates.yaml.
"""

import esphome.codegen as cg

gated_update_ns = cg.esphome_ns.namespace("gated_update")
