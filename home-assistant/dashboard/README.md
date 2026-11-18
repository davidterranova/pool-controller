# A Home Assistant dashboard for the Pool Controller

Building blocks for a dashboard around this firmware, not anyone's dashboard in particular:

| File | What it is |
|---|---|
| [dashboard.yaml](dashboard.yaml) | A two-view dashboard whose sections are the components: the pump (piscine-card, which has the controls and settings itself), temperatures, plan against reality, fill water; then alerts, settings (piscine-card's settings variant), today's plan and the controller. |
| [scripts.yaml](scripts.yaml) | The two scripts piscine-card calls to force a speed and to go back to Auto. |

They use Home Assistant's own cards only, plus [piscine-card](../piscine-card.js) from this repo (its
panel and its settings variant). No helper, no other custom card.

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

The panel has four tabs, so the pop-up needs no dashboard behind it:

- « Pompe »: state, today's plan, the pool's temperature (24 h to a year), Auto/Manuel, and at its foot
  the outdoor and equipment-pad temperatures (a tap opens Home Assistant's more-info, with their history);
- « Remplissage »: the fill water today, this month, and by day, week or month. It needs the `volume`
  entity and the recorder; without them the tab isn't there (`variant: water` draws it alone);
- « Avancé », in the device page's order: today's plan in detail with « Recalculer », the controller's
  link and Wi-Fi, the probes with « Relire », the firmware on its update entity (installed and latest
  version, a tap opening Home Assistant's own update dialog with the release notes, « Vérifier »,
  « Installer », held by the firmware while a manual override or a fill runs: the card asks first, then
  says it waits, and the wait can be cancelled; automatic updates, what a scheduled check finds, and how
  often to check), then the last 7 days of filtration against the plan. A firmware without the update
  entity (before v1.4) has no firmware section. The controller's light opens it at « Contrôleur »;
- « Réglages »: every setting, with its Apply gate, then the controller's position and time zone, with
  « Utiliser la position et le fuseau de Home Assistant » (Home Assistant's location rounded to 0.01°,
  its zone as the controller's Timezone Name and its POSIX string). `settings_tab: false` drops it and
  « Avancé » (the light then opens `more_path`, if given); `temperatures: false` drops the temperatures
  at the foot of « Pompe ».

Its header, and the tile, have a light for the controller: green while it talks (the Device Clock, `clock`,
changes every minute), amber when it goes quiet or has been offline for less than 15 min, red beyond. In the
header it says when the controller was last heard and opens « Avancé » › Contrôleur. `controller_light:
false` drops it; `controller_health: { warn: 3, alert: 15, beat: 4 }` sets its minutes before amber and red.

What this dashboard adds to the card: the three probes' curves and their 90-day daily means, the
pump's plan against reality over the last days, and the fill water with Home Assistant's own cards.

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
`cancelUpdate`, `autoUpdate`, `updateInterval`, `updateStatus`) already are a fresh install's ids.

## Keeping it in step with the firmware

`make ha-dashboard-check` (also in CI) reads `pool-controller.yaml` and its packages and fails when
the dashboard or the scripts name a controller entity that doesn't exist, or when the pool card in
`dashboard.yaml` leaves out an entity the card uses (unless the card's default already is a fresh
install's id; one the firmware doesn't have yet is only noted, since the card hides its rows). A
firmware change that renames or adds an entity the dashboard relies on therefore can't land without
the dashboard following.

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
  span. The card's « Remplissage » tab shows them by day (30 days), by week (13 weeks) or by month
  (12 months), with the period's total, its average and its largest bar; the running day, week or
  month adds what the meter counted since the last hour Home Assistant compiled. The component in
  the Piscine view draws the same with Home Assistant's own cards.
- **Settings.** Everything the controller lets you tune, grouped by when it applies: the four
  filtration-length settings wait for « Appliquer » because they reshape today's plan; freeze
  protection and the boost pulses apply at once. The override's duration isn't one of them: it is
  chosen with the override, in the panel's « Pompe » › Manuel. It is piscine-card's settings
  variant, not Home Assistant's entities card: the latter cuts a long name short on a phone
  (« Min filtration h… ») and has no line for what a setting does. The panel's « Réglages » tab and
  the device's own page (Avancé › Réglages) draw the same rows, so all three read alike.
