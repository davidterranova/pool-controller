# A Home Assistant dashboard for the Pool Controller

Building blocks for a dashboard around this firmware, not anyone's dashboard in particular:

| File | What it is |
|---|---|
| [dashboard.yaml](dashboard.yaml) | A two-view dashboard whose sections are the components: the pump (piscine-card, which has the controls and settings itself), temperatures, plan against reality, fill water; then alerts, settings (piscine-card's settings variant), today's plan and the controller. |
| [scripts.yaml](scripts.yaml) | The two scripts piscine-card calls to force a speed and to go back to Auto. |
| [../blueprints/pool_fill_too_long.yaml](../blueprints/pool_fill_too_long.yaml) | An automation blueprint: phone reminders while a fill runs too long, with « Acquitter » (see « Fill alarm notifications »). |

They use Home Assistant's own cards only, plus [piscine-card](../piscine-card.js) from this repo (its
panel and its settings variant). No helper, no other custom card, and the blueprint is optional.

## Building the dashboard

1. **Install the card.** Settings → Marketplace (HACS on Home Assistant before 2026.11) → custom
   repository `davidterranova/pool-controller`, type Dashboard → « Piscine Card ». See the repo's
   README, « Installing it in Home Assistant ».
2. **Add the scripts.** Copy [scripts.yaml](scripts.yaml) into Home Assistant's `scripts.yaml`, or
   create each script in Settings → Automations & scenes → Scripts → ⋮ → Edit in YAML, with the key
   as its id (`piscine_forcer_vitesse`, `piscine_retour_auto`). The card writes the Manual Override
   select only through them.
3. **Create the dashboard.** Settings → Dashboards → Add dashboard → New dashboard from scratch (any
   URL). Open it → ✏️ → ⋮ → Raw configuration editor, paste [dashboard.yaml](dashboard.yaml), save.
4. **Or take only some components.** Each section of `dashboard.yaml` stands on its own: copy one into
   a sections view of your own dashboard the same way (its cards, or the whole `- type: grid` block).

### The card as a tile with a pop-up

On a phone the card works best as a tile on your main dashboard that opens the panel in a pop-up, which
is how it was designed. That takes [Bubble Card](https://github.com/Clooos/Bubble-Card) (HACS) for the
pop-up; the tile is the card's own:

```yaml
- type: custom:piscine-card
  variant: tile            # tapping it opens #piscine
  layout: horizontal       # or vertical
  entities: { … the same map as in dashboard.yaml … }
- type: vertical-stack
  cards:
    - type: custom:bubble-card
      card_type: pop-up
      hash: "#piscine"
      popup_mode: adaptive-dialog   # a centred dialog on a screen, a bottom sheet on a phone
      width_desktop: 760px          # the panel's two-column layout starts at 680 px
    - type: custom:piscine-card
      variant: panel
      entities: { … }
```

The panel has three tabs, the controller's own page's, so the pop-up needs no dashboard behind it:

- « Contrôle »: state, today's plan, the pool's temperature (24 h to a year), Auto/Manuel, then the fill
  water today, this month, and by day, week or month. The fill water needs the `volume` entity, the
  recorder, and Fill Meter on (`fillEnabled`); without them it isn't there (`variant: water` draws it alone,
  and hides itself while the meter is off). A fill running longer than Fill Alarm After adds a banner with
  « Acquitter »;
- « Réglages »: today's plan in detail with « Recalculer », the probes with « Relire » (a tap on one opens
  Home Assistant's more-info, with its history), « Filtration et hors gel », every setting with its Apply
  gate, then the last 7 days of filtration against the plan. On a screen, two columns cut after
  « Appliquer »: « Filtration » on the left, « Impulsions et hors gel » on the right;
- « Réglages contrôleur »: the controller's position and time zone, with « Utiliser la position et le
  fuseau de Home Assistant » (Home Assistant's location rounded to 0.01°, its zone as the controller's
  Timezone Name and its POSIX string), then the firmware on its update entity (installed and latest
  version, a tap opening Home Assistant's own update dialog with the release notes, « Vérifier »,
  « Installer », held by the firmware while a manual override or a fill runs: the card asks first, then
  says it waits, and the wait can be cancelled; automatic updates, what a scheduled check finds, and how
  often to check). A firmware without the update entity (before v1.4) has no firmware section.

`settings_tab: false` drops both « Réglages » tabs, and with them the tab bar. `temperatures` (before
1.8.0) is deprecated: accepted and ignored, the outdoor and equipment-pad probes are in « Réglages » › Sondes.

Its header, and the tile, have a light for the controller: green while it talks (the Device Clock, `clock`,
changes every minute), amber when it goes quiet or has been offline for less than 15 min, red beyond. In the
header it says when the controller was last heard and opens Home Assistant's device page for the controller
(Paramètres › Appareils et services › ESPHome › Pool Controller), where its link, Wi-Fi signal and
disconnections are; `more_path` leads elsewhere instead. `controller_light: false` drops it;
`controller_health: { warn: 3, alert: 15, beat: 4 }` sets its minutes before amber and red. While a fill runs
too long and nobody has acknowledged it, the light is amber and keeps pulsing (steady with reduced motion),
reads « Remplissage depuis 1 h 12 », and leads to the banner in « Contrôle » instead.

What this dashboard adds to the card: the three probes' curves and their 90-day daily means, the
pump's plan against reality over the last days, and the fill water with Home Assistant's own cards.

## Fill alarm notifications

The fill meter is optional (Fill Meter, on by default). While it is on, the controller raises **Fill Running
Too Long** once a fill has run **Fill Alarm After** minutes (60 by default, `0` = never): the card's light
pulses amber, and the card, the controller's own page and the alerts component above show it with
« Acquitter ». Both settings are on the controller's device page in Home Assistant (Paramètres › Appareils
et services › ESPHome › Pool Controller › Configuration) and in its own page (« Réglages contrôleur » ›
« Compteur d'eau »), not in the card.

To get it on a phone, import the blueprint:

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fdavidterranova%2Fpool-controller%2Fblob%2Fmain%2Fhome-assistant%2Fblueprints%2Fpool_fill_too_long.yaml)

or Settings → Automations & scenes → Blueprints → Import blueprint, with the URL
`https://github.com/davidterranova/pool-controller/blob/main/home-assistant/blueprints/pool_fill_too_long.yaml`.
Then « Create automation » from it:

| Input | What it is |
|---|---|
| Fill Running Too Long, Fill Alarm Acknowledged, Acknowledge Fill Alarm | The controller's alarm, its acknowledgement and the button that sets it. Pre-filled with a fresh install's ids. |
| Phones | Phones with the Home Assistant app (none or several). Each gets the reminders, with an « Acquitter » action. |
| Repeat every | Minutes between reminders, 15 by default. |
| Title, Message | The reminder's text, in French by default. The message may use `{{ since }}`, the time the alarm went on. |
| All-clear message | Sent when the fill ends, in place of the last reminder. Empty for none. |
| On each reminder, When the alarm ends | Actions of your own (a speaker, a light, another notifier), under « More actions ». |

What it does:

- the alarm turns on: a notification at once, then one every « Repeat every » minutes, each replacing the last
  (one `tag`), until someone acknowledges it or the fill ends;
- « Acquitter », on a phone, presses Acknowledge Fill Alarm on the controller. An acknowledgement from anywhere
  (the card, the controller's page, the device page, a phone) stops the reminders and clears the notification;
  the alarm itself stays on until the fill ends, but no longer pulses the light;
- the fill ends: the notification is cleared, then the all-clear message and actions; the next fill that runs
  too long alarms again;
- Home Assistant restarting, or the controller reconnecting, during an alarm nobody acknowledged resumes the
  reminders.

The alarm and its acknowledgement live on the controller, so it alarms without Home Assistant too (on its own
page); the blueprint only notifies. It needs Home Assistant 2024.10 or later.

## Entity ids

Everything here uses the ids a fresh install gets: Home Assistant names an ESPHome entity after the
device's friendly name and the entity's own, so `Pool Return Temperature` on « Pool Controller »
becomes `sensor.pool_controller_pool_return_temperature`. ESPHome's text sensors are `sensor.` in
Home Assistant.

If yours differ (the device was renamed, or added under another name), check them in Settings →
Devices & services → ESPHome → Pool Controller, then either rename the entities to these ids or
replace the `pool_controller_` prefix in the files.

piscine-card has default entity ids of its own, but most are one particular install's: give it the
whole `entities:` map, as `dashboard.yaml` does. The firmware-update ones (`firmware`, `checkUpdate`,
`cancelUpdate`, `autoUpdate`, `updateInterval`, `updateStatus`) and the fill meter's (`fillEnabled`,
`fillAlarmAfter`, `fillRunning`, `fillTooLong`, `fillAck`, `fillAcked`) already are a fresh install's ids;
`dashboard.yaml` maps the fill meter's anyway, so a renamed device changes them with the rest.

## Keeping it in step with the firmware

`make ha-dashboard-check` (also in CI) reads `pool-controller.yaml` and its packages and fails when
the dashboard or the scripts name a controller entity that doesn't exist, or when the pool card in
`dashboard.yaml` leaves out an entity the card uses (unless the card's default already is a fresh
install's id; one the firmware doesn't have yet is only noted, since the card hides its rows). It reads
the blueprints of `home-assistant/blueprints/` too: each `!input` must be declared and each input used,
`source_url` must be its own path in the repo (Home Assistant re-imports from it), and the ids its
inputs default to must exist. A firmware change that renames or adds an entity the dashboard relies on
therefore can't land without the dashboard following.

## What the components show, and why that way

- **Temperatures.** The pool probe sits on the return pipe: it reads the pool only while water flows,
  and with the pump stopped it drifts toward the equipment pad's air (warmer than the water in winter:
  14.5 °C in the pipe for a 13.1 °C pool on a November night). The component shows the three probes
  as measured, labelled so. The pool's own range, from pumping readings only, is the card's
  temperature graph (24 h, 7 and 30 days), which draws the freeze-protection threshold too.
- **Plan and reality, filtration.** Raw history (the recorder keeps about 10 days), not daily
  statistics: Filtration Hours Today resets at midnight, and a statistics day also counts the value
  it starts with, so a day that filtered less than the one before would show the day before's total.
- **Fill water.** The meter's total only grows, so its statistics (`change`) are exact, over any
  span. The card's « Contrôle » shows them by day (30 days), by week (13 weeks) or by month
  (12 months), with the period's total, its average and its largest bar; the running day, week or
  month adds what the meter counted since the last hour Home Assistant compiled. The component in
  the Piscine view draws the same with Home Assistant's own cards. The meter is optional: the
  component hides itself while Fill Meter is off (its condition is « not off », so a firmware from
  before the switch, without that entity, still shows it), as the card's fill section does.
- **Alerts.** One card per problem the controller raises, shown only while it is on: an open-ended
  manual override, a plan it couldn't compute, a fill running too long. The fill alarm's card says
  since when and whether it was acknowledged, and has « Acquitter » until someone does.
- **Settings.** Everything the controller lets you tune, grouped by when it applies: the four
  filtration-length settings wait for « Appliquer » because they reshape today's plan; freeze
  protection and the boost pulses apply at once. The override's duration isn't one of them: it is
  chosen with the override, in the panel's « Contrôle » › Manuel. It is piscine-card's settings
  variant, not Home Assistant's entities card: the latter cuts a long name short on a phone
  (« Min filtration h… ») and has no line for what a setting does. The panel's « Réglages » tab and
  the device's own page (Réglages › Filtration et hors gel) draw the same rows, so all three read alike.
