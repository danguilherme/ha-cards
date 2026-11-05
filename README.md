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
