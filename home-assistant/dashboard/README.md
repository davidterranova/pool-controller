# A Home Assistant dashboard for the Pool Controller

Building blocks for a dashboard around this firmware, not anyone's dashboard in particular:

| File | What it is |
|---|---|
| [dashboard.yaml](dashboard.yaml) | A two-view dashboard whose sections are the components: the pump (piscine-card), temperatures, plan against reality, fill water; then alerts, settings, today's plan and the controller. |
| [scripts.yaml](scripts.yaml) | The two scripts piscine-card calls to force a speed and to go back to Auto. |

They use Home Assistant's own cards only, plus [piscine-card](../piscine-card.js) from this repo. No
helper, no other custom card.

## Building the dashboard

1. **Install the card.** Settings → Marketplace (HACS on Home Assistant before 2026.11) → custom
   repository `davidterranova/pool-controller`, type Dashboard → « Piscine Card ». See the repo's
   README, « Installing it in Home Assistant ».
2. **Add the scripts.** Copy [scripts.yaml](scripts.yaml) into Home Assistant's `scripts.yaml`, or
   create each script in Settings → Automations & scenes → Scripts → ⋮ → Edit in YAML, with the key
   as its id (`piscine_forcer_vitesse`, `piscine_retour_auto`). The card writes the Manual Override
   select only through them.
3. **Create the dashboard.** Settings → Dashboards → Add dashboard → New dashboard from scratch, with
   the URL `dashboard-piscine` (the card's « Planning, réglages » link opens
   `/dashboard-piscine/reglages`; change `more_path` in the card if you pick another URL). Open it →
   ✏️ → ⋮ → Raw configuration editor, paste [dashboard.yaml](dashboard.yaml), save.
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

## Entity ids

Everything here uses the ids a fresh install gets: Home Assistant names an ESPHome entity after the
device's friendly name and the entity's own, so `Pool Return Temperature` on « Pool Controller »
becomes `sensor.pool_controller_pool_return_temperature`. ESPHome's text sensors are `sensor.` in
Home Assistant.

If yours differ (the device was renamed, or added under another name), check them in Settings →
Devices & services → ESPHome → Pool Controller, then either rename the entities to these ids or
replace the `pool_controller_` prefix in the files.

piscine-card has default entity ids of its own, but they are one particular install's: give it the
whole `entities:` map, as `dashboard.yaml` does.

## Keeping it in step with the firmware

`make ha-dashboard-check` (also in CI) reads `pool-controller.yaml` and its packages and fails when
the dashboard or the scripts name a controller entity that doesn't exist, or when the pool card in
`dashboard.yaml` leaves out an entity the card uses. A firmware change that renames or adds an
entity the dashboard relies on therefore can't land without the dashboard following.

## What the components show, and why that way

- **Temperatures.** The pool probe sits on the return pipe: it reads the pool only while water flows,
  and with the pump stopped it drifts toward the equipment pad's air (warmer than the water in winter:
  14.5 °C in the pipe for a 13.1 °C pool on a November night). The component shows the three probes
  as measured, labelled so. The pool's own range, from pumping readings only, is the card's
  temperature graph (24 h, 7 and 30 days), which draws the freeze-protection threshold too.
- **Plan and reality, filtration.** Raw history (the recorder keeps about 10 days), not daily
  statistics: Filtration Hours Today resets at midnight, and a statistics day also counts the value
  it starts with, so a day that filtered less than the one before would show the day before's total.
- **Fill water.** The meter's total only grows, so its daily statistics (`change`) are exact, over
  any span.
- **Settings.** Everything the controller lets you tune, grouped by when it applies: the four
  filtration-length settings wait for « Appliquer » because they reshape today's plan; freeze
  protection, the boost pulses and the override timeout apply at once. The device's own page
  (Avancé › Réglages) shows the same settings.
