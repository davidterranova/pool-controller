from esphome import automation
import esphome.codegen as cg
from esphome.components import update
import esphome.config_validation as cv
from esphome.const import CONF_SOURCE_ID, DEVICE_CLASS_FIRMWARE
from esphome.types import ConfigType

from . import gated_update_ns

DEPENDENCIES = ["update"]

GatedUpdate = gated_update_ns.class_("GatedUpdate", update.UpdateEntity, cg.Component)

CONF_ON_INSTALL = "on_install"

CONFIG_SCHEMA = (
    update.update_schema(GatedUpdate, device_class=DEVICE_CLASS_FIRMWARE)
    .extend(
        {
            cv.Required(CONF_SOURCE_ID): cv.use_id(update.UpdateEntity),
            # x: perform()'s `force` (Home Assistant and the page never set it)
            cv.Required(CONF_ON_INSTALL): automation.validate_automation(single=True),
        }
    )
    .extend(cv.COMPONENT_SCHEMA)
)


async def to_code(config: ConfigType) -> None:
    var = await update.new_update(config)
    await cg.register_component(var, config)
    source = await cg.get_variable(config[CONF_SOURCE_ID])
    cg.add(var.set_source(source))
    await automation.build_automation(
        var.get_install_trigger(), [(cg.bool_, "force")], config[CONF_ON_INSTALL]
    )
