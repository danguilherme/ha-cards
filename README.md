# ha-cards

Custom [Home Assistant](https://www.home-assistant.io/) dashboard cards, built with **Lit + TypeScript** and
bundled by **Rspack** into a single ES module (`dist/ha-cards.js`). Distributed through Home Assistant's
**Marketplace** (Settings → Marketplace; HACS became the built-in Marketplace in HA 2026.11).

## Cards

### `custom:dg-light-tile`

An Apple Home-style light tile.

- **Tap** toggles the light.
- **Drag horizontally** sets the brightness. The fill follows your finger and is applied on release;
  dragging to 0 turns the light off.
- **Long-press** opens HA's more-info dialog (color, temperature, big slider).
- When on, the whole tile is tinted with the bulb's actual color (`rgb_color`).

```yaml
type: custom:dg-light-tile
entity: light.living_room_ceiling_c1600
name: Ceiling # optional, defaults to the friendly name
icon: mdi:ceiling-light # optional, defaults to HA's state icon
```

In a sections view it takes half the width and two rows, the same footprint as a vertical tile.

### `custom:dg-floor-plan`

The home as a floor plan, made for phones.

- **Quick actions** on top (scenes, scripts, a vacuum, anything toggleable).
- **Rooms glow with their lights**: every positioned bulb that's on glows in its own colour and
  brightness, clipped to its room, so a room with a warm ceiling light and a purple lamp shows both.
  Media players, sensors and the vacuum show as icons; the vacuum moves to the room it's cleaning.
- **Tap a room** to zoom into it. Its devices sit on the map where they really are, with their names:
  tap a light (or switch, fan…) to toggle it, hold any of them for its details. Below the map is
  everything assigned to the room's HA area (directly or through the device): sensor chips, the room's
  light group with a slider plus a `dg-light-tile` per bulb, scenes, a vacuum card with "Clean this
  room" (`vacuum.clean_area`), media players and other devices. Hidden entities, config/diagnostic
  entities, light groups and the vacuum's own entities are left out. Back (or the phone's Back) zooms out.
- **Hold a room** on the whole-home map to toggle its light group.
- **Edit** (in a zoomed room): drag the room's devices to where they really are and add the ones not on
  the map yet. Every change is saved as you make it, per HA user (`frontend/set_user_data`), so it
  follows you across devices; **Cancel** puts back what you had when you started editing. **Copy
  positions for the dashboard YAML** gives a `positions:` block for the card config; saved positions win
  over YAML until you **Reset all rooms to defaults**.

```yaml
type: custom:dg-floor-plan
size: [985, 745]            # plan size in your own units (e.g. cm)
vacuum: vacuum.monica       # optional
vacuum_room_sensor: sensor.monica_current_room  # optional: moves the vacuum icon while cleaning
quick_actions:
  - name: Lights off
    entity: scene.all_lights_off   # scene/script → turn_on, vacuum → start/dock, else → toggle
    icon: mdi:lightbulb-group-off
  - name: Party
    action: script.turn_on         # or any domain.service
    data: { entity_id: script.party }
rooms:
  - area: living_room              # HA area id
    name: Living room              # optional, defaults to the area name
    shape: [[37, 37], [485, 37], [485, 435], [37, 435]]   # polygon, plan units
    label: [261, 270]              # optional, defaults to the shape's centre
    light: light.all_living_room_lights  # optional: hold to toggle, slider in the room view
    clean: true                    # optional: show "Clean this room" (vacuum.clean_area)
    vacuum_room: Living room       # optional: name in vacuum_room_sensor, if different
    exclude: [media_player.old_tv] # optional
positions:                         # optional defaults, plan units
  light.living_room_ceiling: [250, 200]
  vacuum.monica: [115, 105]        # the dock
```

"Clean this room" calls `vacuum.clean_area` with the room's area, so the vacuum needs its map segments
mapped to HA areas.

Preview with mocked data: `yarn dev`, then <http://localhost:5173/preview/floor-plan.html>.

## Install (Marketplace)

1. Settings → **Marketplace**. The first time, accept the community-code notice.
2. **Add from link** → `https://github.com/danguilherme/ha-cards`. Custom repositories need a one-time
   GitHub device sign-in (read-only, public data).
3. Open **ha-cards** → **Install**. The resource `/local/community/ha-cards/ha-cards.js?v=…` (JavaScript
   module) is registered for you.
4. If a card says "Custom element doesn't exist", refresh the browser. In the Companion app, reset
   the frontend cache (App settings → Companion app → Troubleshooting).

New `v*` releases show up under Settings → Updates. `hacs.json` is kept: the Marketplace carries the
HACS repository format over.

## Develop

```bash
yarn install
yarn dev        # serves the bundle on your LAN + a mocked preview
yarn build      # type-check + production bundle in dist/
```

`yarn dev` prints the resource URL, e.g. `http://192.168.50.159:5173/ha-cards.js`. It also serves a
preview with a mocked `hass` at <http://localhost:5173/preview/>, so you can iterate without HA.

### Test against your real Home Assistant

1. Profile → enable **Advanced mode** (resources are hidden otherwise).
2. Settings → Dashboards → ⋮ → **Resources**.
3. Temporarily point the ha-cards resource the Marketplace registered at the dev server. Note its
   current URL, then edit it to `http://<your-mac-ip>:5173/ha-cards.js`, type **JavaScript module**.
   Edit it rather than adding a second resource: both would define the same custom elements and the
   first one loaded wins.
4. Refresh the dashboard. The dev server live-reloads the page on every rebuild.
5. When you're done, set the URL back to the one you noted.

Notes:
- This only works while HA is opened over **http** (e.g. `http://homeassistant.local:8123`). An https
  HA page blocks http resources (mixed content).
- The phone must be on the same network as the Mac.
- Resources are cached aggressively; if a change doesn't show up, hard-refresh. In the Companion app,
  reset the frontend cache.

## Release

```bash
npm version patch   # or minor/major: bumps package.json and creates the vX.Y.Z tag
git push --follow-tags
```

`.github/workflows/release.yml` runs on `v*` tags. It checks that the tag matches `package.json`,
builds, and publishes a GitHub release with `dist/ha-cards.js` attached; the Marketplace installs that
asset.

## Notes for contributors

- Lit reactive properties must use `declare` (or decorators). SWC emits class fields with define
  semantics otherwise, which shadows Lit's accessors and the card never renders. The Rspack config
  also sets `useDefineForClassFields: false`.
- HA's own elements (`ha-card`, `ha-state-icon`, `ha-icon`) are used but not bundled; the preview page
  stubs them.
- Open HA dialogs by dispatching `hass-more-info` (see `src/types.ts`).
