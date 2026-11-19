"""page_login: the device's page behind a login screen of its own.

Replaces web_server's HTTP auth (digest, a fixed user, the browser's own
dialog, no logout) with a password-only login in the page, backed by a
session cookie. See docs/plans/page-login.md for the design and its contract.

It registers a gate in front of web_server's handlers. While a password is
set (set_password(); none = setup mode, nothing gated), the gate answers
every request without a valid session with a 401 that carries no
WWW-Authenticate, so the browser never shows its dialog. It lets through
only the page shell (/, /0.js, /0.css) and its own endpoints: GET
/login/challenge, POST /login, GET /login/session, POST /logout.

The login is challenge-response: the page proves it knows the password
without sending it (HMAC-SHA256 over a single-use nonce). A session ends
after `idle_timeout` with no request (the /events stream doesn't count), on
logout, and for every browser at once with logout_all() (a password change,
Factory Reset, Logout All Devices); the device then closes that session's
open /events streams. Tokens are kept in NVS, so a reboot logs nobody out.

Needs web_server WITHOUT its `auth:`: with it, web_server would challenge
every request itself.
"""

import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.const import CONF_ID
from esphome.types import ConfigType

DEPENDENCIES = ["web_server"]

CONF_IDLE_TIMEOUT = "idle_timeout"

page_login_ns = cg.esphome_ns.namespace("page_login")
PageLogin = page_login_ns.class_("PageLogin", cg.Component)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(PageLogin),
        cv.Optional(CONF_IDLE_TIMEOUT, default="6h"): cv.All(
            cv.positive_time_period_milliseconds,
            cv.Range(min=cv.TimePeriod(minutes=1)),
        ),
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config: ConfigType) -> None:
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    cg.add(var.set_idle_timeout(config[CONF_IDLE_TIMEOUT]))
