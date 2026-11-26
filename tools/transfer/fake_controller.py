"""A fake controller for transfer.py's tests (`make transfer-test`): it speaks
ESPHome's native API (plaintext framing, the messages aioesphomeapi sends) on
127.0.0.1, lists the entities it is given, sends their states on subscribing,
and takes writes the way the firmware does:

  - a number, a text, a switch: the new value is published;
  - a select: only one of its current options; Rescan Probes makes the options
    « none » plus the probes on its bus, which a client sees on its next
    connection (the options are listed once per connection, as on the device);
  - Fill Water Import, History Import: a line sets the sensor it carries
    (Fill Water Days or Months; Daily History…; today:'s sensors), and the
    entity publishes an outcome code, `imported:…`, or `refused:<code>` for a
    tag set in `refuse`;
  - a text longer than its max_length is dropped, as ESPHome's TextCall does.

Every write is logged in `writes`, so a test sees what reached which device,
and in which order. Made-up values only: no real controller is ever reached.
"""

from __future__ import annotations

import asyncio
import zlib

from aioesphomeapi import api_pb2 as pb
from aioesphomeapi.core import MESSAGE_TYPE_TO_PROTO

TYPE_OF = {cls: number for number, cls in MESSAGE_TYPE_TO_PROTO.items()}

# kind -> (ListEntities response, state response)
KINDS = {
    "number": (pb.ListEntitiesNumberResponse, pb.NumberStateResponse),
    "select": (pb.ListEntitiesSelectResponse, pb.SelectStateResponse),
    "text": (pb.ListEntitiesTextResponse, pb.TextStateResponse),
    "switch": (pb.ListEntitiesSwitchResponse, pb.SwitchStateResponse),
    "button": (pb.ListEntitiesButtonResponse, None),
    "sensor": (pb.ListEntitiesSensorResponse, pb.SensorStateResponse),
    "text_sensor": (pb.ListEntitiesTextSensorResponse, pb.TextSensorStateResponse),
    "binary_sensor": (pb.ListEntitiesBinarySensorResponse, pb.BinarySensorStateResponse),
}

HISTORY_TARGETS = {
    "daily": "Daily History",
    "plan": "Daily Plan History",
    "outdoor": "Daily Outdoor History",
    "pad": "Daily Equipment Pad History",
}
TODAY_TARGETS = {
    "water": ("Pool Water Min Today", "Pool Water Max Today"),
    "outdoor": ("Outdoor Min Today", "Outdoor Max Today"),
    "pad": ("Equipment Pad Min Today", "Equipment Pad Max Today"),
}

# The controller's entities transfer.py reads or writes: name -> (kind, extra).
ENTITIES = {
    "Min Filtration Hours": ("number", {"min_value": 0, "max_value": 24, "step": 0.5}),
    "Max Filtration Hours": ("number", {"min_value": 0, "max_value": 24, "step": 0.5}),
    "Warmest Part of Day Offset": ("number", {"min_value": 0, "max_value": 6, "step": 0.25}),
    "Filtration Hour Offset": ("number", {"min_value": -6, "max_value": 6, "step": 0.5}),
    "Boost Pulse Duration": ("number", {"min_value": 0, "max_value": 15, "step": 1}),
    "Boost Pulse Interval": ("number", {"min_value": 5, "max_value": 60, "step": 5}),
    "High Boost Frequency": ("number", {"min_value": 1, "max_value": 10, "step": 1}),
    "Apply Filtration Config": ("button", {}),
    "Freeze Protection Temperature": ("number", {"min_value": 0, "max_value": 10, "step": 0.5}),
    "Manual Override Timeout": ("number", {"min_value": 0, "max_value": 480, "step": 5}),
    "Manual Override": ("select", {"options": ["Auto", "Off", "Low", "Medium", "High"]}),
    "Timezone": ("text", {"max_length": 64}),
    "Timezone Name": ("text", {"max_length": 64}),
    "Latitude": ("number", {"min_value": -90, "max_value": 90, "step": 0.01}),
    "Longitude": ("number", {"min_value": -180, "max_value": 180, "step": 0.01}),
    "Rescan Probes": ("button", {}),
    "Pool Probe": ("select", {"options": ["none"]}),
    "Pad Probe": ("select", {"options": ["none"]}),
    "Outdoor Probe": ("select", {"options": ["none"]}),
    "Fill Meter": ("switch", {}),
    "Fill Alarm After": ("number", {"min_value": 0, "max_value": 1440, "step": 5}),
    "Fill Water Import": ("text", {"max_length": 255}),
    "Fill Water Days": ("text_sensor", {}),
    "Fill Water Months": ("text_sensor", {}),
    "Fill Water Today": ("sensor", {}),
    "History Import": ("text", {"max_length": 255}),
    "Daily History": ("text_sensor", {}),
    "Daily Plan History": ("text_sensor", {}),
    "Daily Outdoor History": ("text_sensor", {}),
    "Daily Equipment Pad History": ("text_sensor", {}),
    "Filtration Hours Today": ("sensor", {}),
    "Pool Water Min Today": ("sensor", {}),
    "Pool Water Max Today": ("sensor", {}),
    "Outdoor Min Today": ("sensor", {}),
    "Outdoor Max Today": ("sensor", {}),
    "Equipment Pad Min Today": ("sensor", {}),
    "Equipment Pad Max Today": ("sensor", {}),
    "Auto Update": ("switch", {}),
    "Update Check Interval": ("select", {"options": ["on_request", "6h", "24h", "7d"]}),
    "Page Password": ("text", {"max_length": 64}),
    "API Key": ("text", {"max_length": 44}),
    "Panel Language": ("select", {"options": ["en", "fr", "es"]}),
    "Manual Override Active": ("binary_sensor", {}),
}


def varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


async def read_varint(reader: asyncio.StreamReader) -> int:
    value, shift = 0, 0
    while True:
        byte = (await reader.readexactly(1))[0]
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value
        shift += 7


def key_of(name: str) -> int:
    return zlib.crc32(name.encode()) & 0x7FFFFFFF


class FakeController:
    """One fake controller. `states`: name -> value (None = unknown); `bus`: the probe addresses it finds."""

    def __init__(self, name: str, mac: str, states: dict, *, bus=(), refuse=(), version="2.0.0",
                 entities: dict | None = None):
        self.name, self.mac, self.version = name, mac, version
        self.entities = dict(entities if entities is not None else ENTITIES)
        self.states = dict(states)
        self.options = {n: list(extra.get("options", [])) for n, (kind, extra) in self.entities.items() if kind == "select"}
        self.bus = list(bus)
        self.refuse = set(refuse)  # History Import tags (or "days"/"months") refused with refused:value
        self.writes: list = []  # (name, value), in the order they arrived
        self.connections = 0
        self._clients: set = set()
        self._server = None
        self.port = 0

    # ---------------------------------------------------------- the server

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._serve, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self.port

    async def stop(self) -> None:
        for writer in list(self._clients):
            writer.close()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    def _send(self, writer, msg) -> None:
        data = msg.SerializeToString()
        writer.write(b"\x00" + varint(len(data)) + varint(TYPE_OF[type(msg)]) + data)

    async def _serve(self, reader, writer) -> None:
        self.connections += 1
        self._clients.add(writer)
        # The options this connection was told about: a rescan shows on the next one, as on the device.
        try:
            while True:
                if (await reader.readexactly(1)) != b"\x00":
                    return
                length = await read_varint(reader)
                msg_type = await read_varint(reader)
                payload = await reader.readexactly(length)
                cls = MESSAGE_TYPE_TO_PROTO.get(msg_type)
                if cls is None:
                    continue
                msg = cls()
                msg.ParseFromString(payload)
                if not self._handle(writer, msg):
                    return
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            return
        finally:
            self._clients.discard(writer)
            writer.close()

    def _handle(self, writer, msg) -> bool:
        kind = type(msg).__name__
        if kind == "HelloRequest":
            self._send(writer, pb.HelloResponse(api_version_major=1, api_version_minor=12,
                                                server_info="fake", name=self.name))
        elif kind == "DeviceInfoRequest":
            self._send(writer, pb.DeviceInfoResponse(name=self.name, mac_address=self.mac,
                                                     esphome_version="2026.11.0", project_version=self.version))
        elif kind == "ListEntitiesRequest":
            for name, (ekind, extra) in self.entities.items():
                fields = {k: v for k, v in extra.items() if k != "options"}
                if ekind == "select":
                    fields["options"] = self.options[name]
                info_cls = KINDS[ekind][0]
                self._send(writer, info_cls(object_id=name.lower().replace(" ", "_"), key=key_of(name),
                                            name=name, **fields))
            self._send(writer, pb.ListEntitiesDoneResponse())
        elif kind == "SubscribeStatesRequest":
            for name in self.entities:
                self._publish(name, only=writer)
        elif kind == "PingRequest":
            self._send(writer, pb.PingResponse())
        elif kind == "DisconnectRequest":
            self._send(writer, pb.DisconnectResponse())
            return False
        elif kind.endswith("CommandRequest"):
            name = next((n for n in self.entities if key_of(n) == msg.key), None)
            if name is not None:
                self._command(name, None if kind == "ButtonCommandRequest" else msg.state)
        return True

    def _publish(self, name: str, only=None) -> None:
        ekind = self.entities[name][0]
        state_cls = KINDS[ekind][1]
        if state_cls is None:
            return
        value = self.states.get(name)
        if value is None:
            if ekind in ("switch", "binary_sensor"):
                msg = state_cls(key=key_of(name), state=False)
            else:
                msg = state_cls(key=key_of(name), missing_state=True)
        else:
            msg = state_cls(key=key_of(name), state=value)
        for writer in [only] if only else list(self._clients):
            self._send(writer, msg)

    def _set(self, name: str, value) -> None:
        self.states[name] = value
        self._publish(name)

    # ------------------------------------------------------- the firmware

    def _command(self, name: str, value) -> None:
        self.writes.append((name, value))
        ekind, extra = self.entities[name]
        if ekind == "button":
            if name == "Rescan Probes":
                held = [self.states.get(n) for n in self.options if n.endswith(" Probe")]
                found = self.bus + [a for a in held if a and a != "none" and a not in self.bus]
                for select in ("Pool Probe", "Pad Probe", "Outdoor Probe"):
                    if select in self.options:
                        self.options[select] = ["none"] + found
            return
        if ekind == "text" and len(str(value).encode()) > extra.get("max_length", 255):
            return  # ESPHome drops it, with a warning in the log
        if name == "Fill Water Import":
            self._fill_import(value)
        elif name == "History Import":
            self._history_import(value)
        elif ekind == "select":
            if value in self.options[name]:
                self._set(name, value)
        else:
            self._set(name, value)

    def _fill_import(self, line: str) -> None:
        head = line.split(":", 1)[0]
        what = "days" if len(head) == 10 else "months"
        if what in self.refuse:
            self._set("Fill Water Import", "refused:value")
            return
        self.states["Fill Water Days" if what == "days" else "Fill Water Months"] = line
        self._publish("Fill Water Days" if what == "days" else "Fill Water Months")
        self._set("Fill Water Import", f"imported:{what}:{len(line.split()) - 1}")

    def _history_import(self, line: str) -> None:
        tag, body = line.split(":", 1)
        if tag in self.refuse:
            self._set("History Import", "refused:value")
            return
        if tag in HISTORY_TARGETS:
            self._set(HISTORY_TARGETS[tag], body)
            days = 0 if body == "--" else body.count(", ") + 1
            self._set("History Import", f"imported:{tag}:{days}")
            return
        _, *pairs = body.split(" ")
        for pair in pairs:
            key, value = pair.split("=", 1)
            if key == "filtration":
                self._set("Filtration Hours Today", int(value) / 60)
            elif key == "fill":
                self._set("Fill Water Today", None if value == "-" else float(value))
            else:
                lo, hi = TODAY_TARGETS[key]
                low, high = (None, None) if value == "-" else map(float, value.split("/"))
                self._set(lo, low)
                self._set(hi, high)
        self._set("History Import", "imported:today")
