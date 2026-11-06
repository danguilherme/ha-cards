import { LitElement, css, html, nothing, svg, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import "./light-tile-card";
import { fireMoreInfo, registerCard, type HassEntity, type HomeAssistant } from "./types";

type Point = [number, number];

export interface QuickAction {
  name: string;
  icon?: string;
  /** Tap: scene/script → turn_on, vacuum → start / return to base, anything else → toggle. */
  entity?: string;
  /** Overrides the entity behaviour: "domain.service", called with `data` (+ entity_id when `entity` is set). */
  action?: string;
  data?: Record<string, unknown>;
}

export interface RoomConfig {
  /** HA area id. The sheet lists everything assigned to it (directly or through its device). */
  area: string;
  name?: string;
  /** Polygon in plan units, e.g. [[37, 37], [485, 37], [485, 435], [37, 435]]. */
  shape: Point[];
  /** Where the room name goes. Defaults to the polygon's centroid. */
  label?: Point;
  /** Light group for the whole room: hold the room to toggle it, room slider in the sheet. */
  light?: string;
  /** The vacuum can clean this area (vacuum.clean_area). Needs the area ↔ map-segment mapping in HA. */
  clean?: boolean;
  /** Name of this room in the vacuum's current-room sensor, if it differs from `name`. */
  vacuum_room?: string;
  /** Entities to leave out of this room's sheet and map. */
  exclude?: string[];
}

export interface FloorPlanConfig {
  type: string;
  /** Plan size in plan units (any unit, e.g. centimetres): [width, height]. */
  size: Point;
  rooms: RoomConfig[];
  quick_actions?: QuickAction[];
  vacuum?: string;
  /** Sensor holding the vacuum's current room name (moves its icon on the map while cleaning). */
  vacuum_room_sensor?: string;
  /** Default positions, plan units. Positions saved from the card's arrange mode take precedence. */
  positions?: Record<string, Point>;
  /** Key for positions saved per HA user (frontend user data). */
  layout_key?: string;
  /** Hide the "n lights on · …" line. */
  hide_summary?: boolean;
}

const TAG = "dg-floor-plan";
const HOLD_MS = 500;
const HISTORY_KEY = "dgFloorPlanSheet";
const FALLBACK_RGB: [number, number, number] = [255, 179, 64];
const CHIP_SENSORS: Record<string, string[]> = {
  sensor: ["temperature", "humidity", "illuminance", "co2", "pm25"],
  binary_sensor: ["motion", "occupancy", "presence", "door", "window", "opening", "moisture", "smoke"],
};
const DEVICE_DOMAINS = ["switch", "input_boolean", "fan", "cover", "climate", "lock", "humidifier", "valve", "siren", "water_heater"];
const TOGGLE_DOMAINS = ["switch", "input_boolean", "fan", "cover", "lock", "humidifier", "valve", "siren", "light"];
const PLACEABLE_DOMAINS = ["light", "media_player", "vacuum", "fan", "cover", "climate", "lock", "humidifier", "valve", "water_heater"];
const PLACEABLE_SENSORS = ["door", "window", "opening", "garage_door", "motion", "occupancy", "presence", "moisture", "smoke"];
const DRAG_SLOP_PX = 4;

interface RoomEntities {
  lights: HassEntity[];
  scenes: HassEntity[];
  media: HassEntity[];
  devices: HassEntity[];
  chips: HassEntity[];
}

const domainOf = (id: string) => id.slice(0, id.indexOf("."));
const isOff = (s?: HassEntity) => !s || ["off", "unavailable", "unknown", "idle", "standby", "docked"].includes(s.state);

/**
 * Floor plan of the home: quick actions on top, rooms tinted by their lights (each bulb glows in its own
 * colour at its position). Tap a room to zoom into it: its devices sit on the map where they are (tap to
 * toggle, hold for details) with everything else in the area below. Hold a room to toggle its light group.
 * Each room has an Edit mode to drag its devices to where they really are; changes save as you go.
 */
export class FloorPlanCard extends LitElement {
  static properties = {
    hass: { attribute: false },
    _config: { state: true },
    _room: { state: true },
    _arrange: { state: true },
    _saved: { state: true },
    _draft: { state: true },
    _selected: { state: true },
    _yaml: { state: true },
    _dragging: { state: true },
    _pressing: { state: true },
  };

  declare hass?: HomeAssistant;
  private declare _config?: FloorPlanConfig;
  private declare _room?: string;
  private declare _arrange: boolean;
  private declare _saved?: Record<string, Point | null>;
  // null = removed from the map (overrides a YAML default until saved positions are reset).
  private declare _draft?: Record<string, Point | null>;
  private declare _selected?: string;
  private declare _yaml?: string;
  private declare _dragging?: string;
  private declare _pressing?: string;

  private _loadedLayout = false;
  private _hold?: { timer: number; fired: boolean };
  private _dragFrom?: { x: number; y: number; moved: boolean };
  /** Saved positions when editing started, so Cancel can put them back. `null` = nothing was saved. */
  private _snapshot?: Record<string, Point | null> | null;
  private _ctlHold?: { timer: number; fired: boolean };

  constructor() {
    super();
    this._arrange = false;
  }

  static getStubConfig(): Partial<FloorPlanConfig> {
    return { size: [1000, 600], rooms: [{ area: "living_room", shape: [[0, 0], [600, 0], [600, 600], [0, 600]] }] };
  }

  setConfig(config: FloorPlanConfig): void {
    if (!Array.isArray(config?.size) || config.size.length !== 2) throw new Error(`${TAG}: 'size' must be [width, height]`);
    if (!Array.isArray(config.rooms) || !config.rooms.length) throw new Error(`${TAG}: 'rooms' is required`);
    for (const r of config.rooms) {
      if (!r.area || !Array.isArray(r.shape) || r.shape.length < 3) throw new Error(`${TAG}: each room needs 'area' and a 'shape' with 3+ points`);
    }
    this._config = config;
  }

  getCardSize(): number {
    return 8;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  // --- Back closes the sheet ---------------------------------------------------------------------
  // Opening the sheet pushes a history entry (same URL), so the phone's Back / browser back pops it and
  // closes the sheet instead of leaving the view. Closing it any other way pops that entry again. HA's
  // more-info dialogs stack their own entries on top, so Back closes those first, then the sheet.

  private _historyPushed = false;

  private _onPopState = (): void => {
    if (!this._historyPushed || (history.state as Record<string, unknown> | null)?.[HISTORY_KEY]) return;
    this._historyPushed = false;
    this._room = undefined;
    this._arrange = false;
    this._selected = undefined;
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("popstate", this._onPopState);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("popstate", this._onPopState);
    this._historyPushed = false;
    this._room = undefined;
  }

  private _syncHistory(wasOpen: boolean): void {
    const open = !!this._room;
    if (open && !wasOpen && !this._historyPushed) {
      history.pushState({ [HISTORY_KEY]: true }, "");
      this._historyPushed = true;
    } else if (!open && wasOpen && this._historyPushed) {
      this._historyPushed = false;
      history.back();
    }
  }

  protected updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("_room")) {
      this._syncHistory(!!changed.get("_room"));
      if (this._room && !changed.get("_room")) this.renderRoot.querySelector("ha-card")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    if (!this._loadedLayout && this.hass?.callWS) {
      this._loadedLayout = true;
      this.hass
        .callWS<{ value: Record<string, Point | null> | null }>({ type: "frontend/get_user_data", key: this._layoutKey })
        .then((r) => (this._saved = r?.value ?? undefined))
        .catch(() => undefined);
    }
  }

  private get _layoutKey(): string {
    return this._config?.layout_key ?? TAG;
  }

  private get _positions(): Record<string, Point> {
    const merged = { ...(this._config?.positions ?? {}), ...(this._saved ?? {}), ...(this._draft ?? {}) };
    return Object.fromEntries(Object.entries(merged).filter((e): e is [string, Point] => Array.isArray(e[1])));
  }


  // --- registry helpers ---------------------------------------------------------------------------

  private _areaOf(entityId: string): string | undefined {
    const e = this.hass?.entities?.[entityId];
    if (!e) return undefined;
    return e.area_id ?? (e.device_id ? this.hass?.devices?.[e.device_id]?.area_id ?? undefined : undefined);
  }

  private _isGroup(s: HassEntity): boolean {
    return Array.isArray(s.attributes.entity_id) || s.attributes.is_hue_group === true;
  }

  private _roomEntities(room: RoomConfig): RoomEntities {
    const hass = this.hass!;
    const vacuumDevice = this._config?.vacuum ? hass.entities?.[this._config.vacuum]?.device_id : undefined;
    const exclude = new Set([...(room.exclude ?? []), ...(room.light ? [room.light] : [])]);
    const out: RoomEntities = { lights: [], scenes: [], media: [], devices: [], chips: [] };
    for (const [id, reg] of Object.entries(hass.entities ?? {})) {
      if (reg.hidden || reg.entity_category || exclude.has(id)) continue;
      if (vacuumDevice && reg.device_id === vacuumDevice) continue;
      if (this._areaOf(id) !== room.area) continue;
      const s = hass.states[id];
      if (!s) continue;
      const d = domainOf(id);
      if (d === "light") {
        if (!this._isGroup(s)) out.lights.push(s);
      } else if (d === "scene") out.scenes.push(s);
      else if (d === "media_player") out.media.push(s);
      else if (DEVICE_DOMAINS.includes(d)) out.devices.push(s);
      else if (CHIP_SENSORS[d]?.includes(s.attributes.device_class) && s.state !== "unavailable" && s.state !== "unknown") out.chips.push(s);
    }
    const byName = (a: HassEntity, b: HassEntity) => this._name(a, room).localeCompare(this._name(b, room));
    out.lights.sort(byName);
    out.scenes.sort(byName);
    out.media.sort((a, b) => Number(a.state === "unavailable") - Number(b.state === "unavailable") || byName(a, b));
    out.devices.sort((a, b) => Number(a.state === "unavailable") - Number(b.state === "unavailable") || byName(a, b));
    return out;
  }

  /** Friendly name without the room prefix ("Living Room Entspannen" → "Entspannen"). */
  private _name(s: HassEntity, room?: RoomConfig): string {
    let n = String(this.hass?.entities?.[s.entity_id]?.name ?? s.attributes.friendly_name ?? s.entity_id);
    n = n.replace(/^HA\s+/, "");
    const prefixes = [room?.name, room && this.hass?.areas?.[room.area]?.name].filter(Boolean) as string[];
    for (const p of prefixes) {
      if (n.toLowerCase().startsWith(p.toLowerCase()) && n.length > p.length) {
        n = n.slice(p.length).replace(/^[\s:–-]+/, "");
        break;
      }
    }
    return n.charAt(0).toUpperCase() + n.slice(1);
  }

  private _roomName(room: RoomConfig): string {
    return room.name ?? this.hass?.areas?.[room.area]?.name ?? room.area;
  }

  private _state(s: HassEntity): string {
    return this.hass?.formatEntityState?.(s) ?? `${s.state}${s.attributes.unit_of_measurement ? ` ${s.attributes.unit_of_measurement}` : ""}`;
  }

  private _rgb(s: HassEntity): [number, number, number] {
    return (s.attributes.rgb_color as [number, number, number] | undefined) ?? FALLBACK_RGB;
  }

  private _pct(s: HassEntity): number {
    return s.state === "on" ? Math.max(1, Math.round(((s.attributes.brightness ?? 255) / 255) * 100)) : 0;
  }

  private _centroid(shape: Point[]): Point {
    const xs = shape.map((p) => p[0]);
    const ys = shape.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }

  private _vacuumRoom(): RoomConfig | undefined {
    const c = this._config!;
    const v = c.vacuum ? this.hass?.states[c.vacuum] : undefined;
    if (!v || v.state !== "cleaning" || !c.vacuum_room_sensor) return undefined;
    const current = this.hass?.states[c.vacuum_room_sensor]?.state?.toLowerCase();
    return c.rooms.find((r) => (r.vacuum_room ?? this._roomName(r)).toLowerCase() === current);
  }

  // --- actions ------------------------------------------------------------------------------------

  private _call(domain: string, service: string, data: Record<string, unknown>): void {
    this.hass?.callService(domain, service, data);
  }

  private _runQuick(a: QuickAction): void {
    if (a.action) {
      const [domain, service] = a.action.split(".");
      this._call(domain, service, { ...(a.entity ? { entity_id: a.entity } : {}), ...(a.data ?? {}) });
      return;
    }
    if (!a.entity) return;
    const d = domainOf(a.entity);
    if (d === "scene" || d === "script") this._call(d, "turn_on", { entity_id: a.entity });
    else if (d === "vacuum") {
      const s = this.hass?.states[a.entity]?.state;
      this._call("vacuum", s === "cleaning" ? "return_to_base" : "start", { entity_id: a.entity });
    } else this._call("homeassistant", "toggle", { entity_id: a.entity });
  }

  private _toggleEntity(s: HassEntity): void {
    if (s.state === "unavailable") return;
    const d = domainOf(s.entity_id);
    if (TOGGLE_DOMAINS.includes(d)) this._call(d === "cover" || d === "lock" || d === "valve" ? "homeassistant" : d, "toggle", { entity_id: s.entity_id });
    else fireMoreInfo(this, s.entity_id);
  }

  private _roomDown(ev: PointerEvent, room: RoomConfig): void {
    if (this._arrange) {
      this._mapDown(ev);
      return;
    }
    if (ev.button !== 0 || this._room) return;
    const timer = window.setTimeout(() => {
      if (!this._hold) return;
      this._hold.fired = true;
      this._pressing = undefined;
      if (room.light) {
        navigator.vibrate?.(15);
        this._call("light", "toggle", { entity_id: room.light });
      }
    }, HOLD_MS);
    this._hold = { timer, fired: false };
    this._pressing = room.area;
  }

  // The sheet opens on `click`, not `pointerup`: on touch the compatibility click fires after pointerup
  // and is hit-tested at the finger, which by then is over the freshly rendered scrim — it would close
  // the sheet straight away. The hold timer still runs on pointer events.
  // Up, leave and cancel only stop the timer: on touch, pointerleave fires between pointerup and click,
  // and the click still needs to know whether the hold fired. pointerdown starts a fresh _hold.
  private _roomUp(): void {
    if (this._hold) clearTimeout(this._hold.timer);
    this._pressing = undefined;
  }

  private _roomClick(room: RoomConfig): void {
    const held = this._hold?.fired;
    this._hold = undefined;
    if (this._arrange || held) return;
    this._room = room.area;
  }

  // --- arrange mode -------------------------------------------------------------------------------

  private _toPlan(ev: PointerEvent): Point | undefined {
    const svgEl = this.renderRoot.querySelector("svg.plan");
    if (!svgEl || !this._config) return undefined;
    const b = svgEl.getBoundingClientRect();
    const [w, h] = this._config.size;
    const x = Math.round(((ev.clientX - b.left) / b.width) * w);
    const y = Math.round(((ev.clientY - b.top) / b.height) * h);
    return [Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y))];
  }

  private _mapDown(_ev: PointerEvent): void {
    // Tapping empty map while editing just clears the selection.
    if (this._arrange) this._selected = undefined;
  }

  /** Point-in-polygon (ray casting), plan units. */
  private _inside([x, y]: Point, shape: Point[]): boolean {
    let inside = false;
    for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
      const [xi, yi] = shape[i];
      const [xj, yj] = shape[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** In the room if it sits inside the room's outline, or (when not placed) belongs to the room's area. */
  private _inRoom(id: string, room: RoomConfig): boolean {
    const p = this._positions[id];
    if (p) return this._inside(p, room.shape) || (id === this._dragging);
    return this._areaOf(id) === room.area;
  }

  private _dragStart(ev: PointerEvent, id: string): void {
    if (!this._arrange) return;
    ev.stopPropagation();
    ev.preventDefault();
    this._dragging = id;
    this._selected = id;
    this._dragFrom = { x: ev.clientX, y: ev.clientY, moved: false };
    try {
      (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    } catch {
      // No capture (e.g. synthetic events): moves still reach the map's pointermove.
    }
  }

  private _dragMove(ev: PointerEvent): void {
    if (!this._dragging || !this._dragFrom) return;
    if (!this._dragFrom.moved && Math.hypot(ev.clientX - this._dragFrom.x, ev.clientY - this._dragFrom.y) < DRAG_SLOP_PX) return;
    this._dragFrom.moved = true;
    const p = this._toPlan(ev);
    if (p) this._draft = { ...(this._draft ?? {}), [this._dragging]: p };
  }

  private _dragEnd(): void {
    const moved = this._dragFrom?.moved;
    this._dragging = undefined;
    this._dragFrom = undefined;
    if (moved) void this._persist();
  }

  private _placeable(): { id: string; name: string; room: string }[] {
    const out: { id: string; name: string; room: string }[] = [];
    const ok = (s: HassEntity) => {
      const d = domainOf(s.entity_id);
      return PLACEABLE_DOMAINS.includes(d) || (d === "binary_sensor" && PLACEABLE_SENSORS.includes(String(s.attributes.device_class)));
    };
    for (const room of this._config!.rooms) {
      const e = this._roomEntities(room);
      for (const s of [...e.lights, ...e.media, ...e.devices, ...e.chips]) {
        if (ok(s)) out.push({ id: s.entity_id, name: this._name(s, room), room: this._roomName(room) });
      }
    }
    const v = this._config!.vacuum;
    if (v && this.hass?.states[v]) out.push({ id: v, name: `${this._name(this.hass.states[v])} dock`, room: "" });
    // Positioned entities outside the rooms' areas (e.g. a door sensor with no area) can still be moved.
    for (const id of Object.keys(this._positions)) {
      const s = this.hass?.states[id];
      if (s && !out.some((p) => p.id === id)) out.push({ id, name: this._name(s), room: "" });
    }
    return out;
  }

  /** Drops an unplaced item in the middle of the room and selects it, so the next move is a drag. */
  private _add(id: string, room: RoomConfig): void {
    const [w, h] = this._config!.size;
    const unit = Math.max(w, h) / 100;
    const p = room.label ?? this._centroid(room.shape);
    this._draft = { ...(this._draft ?? {}), [id]: [Math.round(p[0]), Math.round(p[1] + 7 * unit)] };
    this._selected = id;
    void this._persist();
  }

  private _remove(id: string): void {
    this._draft = { ...(this._draft ?? {}), [id]: null };
    this._selected = undefined;
    void this._persist();
  }

  /** Every change is written straight away: nothing is lost if the page reloads or Back is pressed. */
  private async _persist(): Promise<void> {
    if (!this._draft || !Object.keys(this._draft).length) return;
    const value = { ...(this._saved ?? {}), ...this._draft };
    this._saved = value;
    this._draft = undefined;
    await this.hass?.callWS?.({ type: "frontend/set_user_data", key: this._layoutKey, value });
  }

  private get _changedSinceStart(): boolean {
    return JSON.stringify(this._saved ?? null) !== JSON.stringify(this._snapshot ?? null);
  }

  private _enterArrange(): void {
    this._arrange = true;
    this._selected = undefined;
    this._yaml = undefined;
    this._draft = undefined;
    this._snapshot = this._saved ? { ...this._saved } : null;
  }

  private _exitArrange(): void {
    this._arrange = false;
    this._selected = undefined;
    this._yaml = undefined;
    this._draft = undefined;
    this._snapshot = undefined;
  }

  private async _cancelArrange(): Promise<void> {
    if (this._changedSinceStart) {
      const value = this._snapshot ?? null;
      this._saved = value ?? undefined;
      await this.hass?.callWS?.({ type: "frontend/set_user_data", key: this._layoutKey, value });
    }
    this._exitArrange();
  }

  private async _reset(): Promise<void> {
    if (!confirm("Put every device back where the dashboard config places it? Your saved positions are removed.")) return;
    await this.hass?.callWS?.({ type: "frontend/set_user_data", key: this._layoutKey, value: null });
    this._saved = undefined;
    this._draft = undefined;
    this._selected = undefined;
  }

  // --- zoomed-room controls -----------------------------------------------------------------------

  private _ctlDown(ev: PointerEvent, id: string): void {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    const timer = window.setTimeout(() => {
      if (!this._ctlHold) return;
      this._ctlHold.fired = true;
      navigator.vibrate?.(15);
      fireMoreInfo(this, id);
    }, HOLD_MS);
    this._ctlHold = { timer, fired: false };
  }

  private _ctlUp(): void {
    if (this._ctlHold) clearTimeout(this._ctlHold.timer);
  }

  private _ctlClick(s: HassEntity): void {
    const held = this._ctlHold?.fired;
    this._ctlHold = undefined;
    if (held) return;
    if (domainOf(s.entity_id) === "light") {
      if (s.state !== "unavailable") this._call("light", "toggle", { entity_id: s.entity_id });
    } else this._toggleEntity(s);
  }

  private _showYaml(): void {
    const pos = this._positions;
    const lines = Object.keys(pos)
      .sort()
      .map((id) => `  ${id}: [${pos[id][0]}, ${pos[id][1]}]`);
    this._yaml = `positions:\n${lines.join("\n")}\n`;
    navigator.clipboard?.writeText(this._yaml).catch(() => undefined);
  }

  // --- render -------------------------------------------------------------------------------------

  protected render() {
    if (!this._config || !this.hass) return nothing;
    const c = this._config;
    const lightsOn = Object.values(this.hass.states).filter(
      (s) => domainOf(s.entity_id) === "light" && s.state === "on" && !this._isGroup(s) && c.rooms.some((r) => r.area === this._areaOf(s.entity_id)),
    ).length;
    const media = c.rooms.flatMap((r) => this._roomEntities(r).media).filter((s) => !isOff(s));
    const vac = c.vacuum ? this.hass.states[c.vacuum] : undefined;
    const summary = [
      lightsOn ? `${lightsOn} light${lightsOn > 1 ? "s" : ""} on` : "All lights off",
      ...media.map((s) => `${this._name(s)} on`),
      ...(vac ? [`${this._name(vac)} ${this._state(vac).toLowerCase()}`] : []),
    ].join(" · ");

    const room = this._room ? c.rooms.find((r) => r.area === this._room) : undefined;
    return html`
      <ha-card class=${room ? "zoomed" : ""}>
        ${room
          ? this._renderRoomBar(room)
          : html`${c.hide_summary ? nothing : html`<div class="summary">${summary}</div>`}
              ${c.quick_actions?.length ? this._renderQuick(c.quick_actions) : nothing}`}
        ${this._renderMap(room)}
        ${room ? (this._arrange ? this._renderArrange(room) : this._renderRoom(room)) : this._renderPills()}
      </ha-card>
    `;
  }

  private _renderQuick(actions: QuickAction[]) {
    return html`<div class="quick" style="grid-template-columns:repeat(${Math.min(actions.length, 4)}, minmax(0, 1fr))">
      ${actions.map((a) => {
        const s = a.entity ? this.hass!.states[a.entity] : undefined;
        const d = a.entity ? domainOf(a.entity) : "";
        const active = !!s && (d === "vacuum" ? s.state === "cleaning" : !["scene", "script"].includes(d) && !isOff(s));
        const sub = s && !["scene", "script"].includes(d) ? this._state(s) : "";
        return html`<button class="qa ${active ? "active" : ""}" @click=${() => this._runQuick(a)}>
          <span class="qa-icon">${a.icon ? html`<ha-icon .icon=${a.icon}></ha-icon>` : s ? html`<ha-state-icon .hass=${this.hass} .stateObj=${s}></ha-state-icon>` : nothing}</span>
          <span class="qa-name">${a.name}</span>
          ${sub ? html`<span class="qa-sub">${sub}</span>` : nothing}
        </button>`;
      })}
    </div>`;
  }

  private _renderMap(zoom?: RoomConfig) {
    const c = this._config!;
    const hass = this.hass!;
    const [w, h] = c.size;
    const pos = this._positions;
    const dark = !!hass.themes?.darkMode;
    const unit = Math.max(w, h) / 100; // 1% of the longer side, for sizes in plan units
    const glows: TemplateResult[] = [];
    const defs: TemplateResult[] = [];
    const rooms = c.rooms.map((room, i) => {
      const e = this._roomEntities(room);
      const points = room.shape.map((p) => p.join(",")).join(" ");
      defs.push(svg`<clipPath id="room-${i}"><polygon points=${points}></polygon></clipPath>`);
      const roomGlows = e.lights
        .filter((s) => s.state === "on" && pos[s.entity_id])
        .map((s) => {
          const [x, y] = pos[s.entity_id];
          const pct = this._pct(s);
          const [r, g, b] = this._rgb(s);
          const gid = `glow-${s.entity_id.replace(/\W/g, "_")}`;
          const a = ((dark ? 0.26 : 0.28) + (dark ? 0.36 : 0.45) * (pct / 100)).toFixed(2);
          defs.push(svg`<radialGradient id=${gid}><stop offset="0" stop-color="rgb(${r},${g},${b})" stop-opacity=${a}></stop><stop offset="1" stop-color="rgb(${r},${g},${b})" stop-opacity="0"></stop></radialGradient>`);
          return svg`<circle cx=${x} cy=${y} r=${(15 + 17 * (pct / 100)) * unit} fill="url(#${gid})"></circle>`;
        });
      if (!this._arrange) glows.push(svg`<g clip-path="url(#room-${i})" pointer-events="none">${roomGlows}</g>`);
      const dim = zoom && zoom.area !== room.area;
      return svg`<polygon class="room ${dim ? "dim" : ""} ${this._pressing === room.area ? "pressing" : ""}" points=${points}
        @pointerdown=${(ev: PointerEvent) => this._roomDown(ev, room)}
        @pointerup=${() => this._roomUp()}
        @click=${() => this._roomClick(room)}
        @pointerleave=${() => this._roomUp()}
        @pointercancel=${() => this._roomUp()}
        @contextmenu=${(ev: Event) => ev.preventDefault()}></polygon>`;
    });

    const dots = Object.entries(pos)
      .filter(([id]) => !zoom && domainOf(id) === "light" && hass.states[id])
      .map(([id, [x, y]]) => {
        const s = hass.states[id];
        const [r, g, b] = this._rgb(s);
        const on = s.state === "on";
        const cls = `dot ${on ? "on" : ""} ${s.state === "unavailable" ? "na" : ""}`;
        return svg`<circle class=${cls} cx=${x} cy=${y} r=${1.1 * unit} style=${on ? `fill: rgb(${r},${g},${b})` : ""}></circle>`;
      });

    // Non-light devices and the vacuum as HTML icons over the SVG.
    const vacRoom = this._vacuumRoom();
    const icons = Object.entries(pos)
      .filter(([id]) => !zoom && domainOf(id) !== "light" && hass.states[id])
      .map(([id, p]) => {
        const s = hass.states[id];
        let [x, y] = p;
        if (id === c.vacuum && vacRoom && !this._arrange) [x, y] = (([lx, ly]) => [lx, ly + 6 * unit])(vacRoom.label ?? this._centroid(vacRoom.shape));
        const active = id === c.vacuum ? s.state === "cleaning" : !isOff(s);
        return html`<span class="icon ${active ? "active" : ""} ${id === c.vacuum ? "vacuum" : ""}"
          style="left:${(x / w) * 100}%;top:${(y / h) * 100}%">
          <ha-state-icon .hass=${hass} .stateObj=${s}></ha-state-icon>
        </span>`;
      });

    // Zoom: scale the stage so the room's outline fills the map, then keep it inside the plan's edges.
    let stage = "";
    let inv = 1;
    if (zoom) {
      const xs = zoom.shape.map((p) => p[0]);
      const ys = zoom.shape.map((p) => p[1]);
      const pad = 3 * unit;
      const [x0, x1, y0, y1] = [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...ys) - pad, Math.max(...ys) + pad];
      const k = Math.min(w / (x1 - x0), h / (y1 - y0), 3.2);
      const clamp = (v: number) => Math.min(0, Math.max((1 - k) * 100, v));
      const tx = clamp((0.5 - (k * (x0 + x1)) / 2 / w) * 100);
      const ty = clamp((0.5 - (k * (y0 + y1)) / 2 / h) * 100);
      stage = `transform: translate(${tx}%, ${ty}%) scale(${k})`;
      inv = 1 / k;
    }

    const ctls = Object.entries(pos)
      .filter(([id]) => zoom && !this._arrange && hass.states[id] && this._inRoom(id, zoom))
      .map(([id, [x, y]]) => {
        const s = hass.states[id];
        const light = domainOf(id) === "light";
        const on = light ? s.state === "on" : id === c.vacuum ? s.state === "cleaning" : !isOff(s);
        const fill = light && on ? `--fill: rgb(${this._rgb(s).join(",")})` : "";
        // Map labels are short: drop a trailing "(model)" such as "Lava Lamp (LEDVANCE Plug Z3)".
        const name = (id === c.vacuum ? this._name(s) : this._name(s, zoom)).replace(/\s*\([^)]*\)$/, "");
        return html`<button class="ctl ${on ? "on" : ""} ${s.state === "unavailable" ? "na" : ""}"
          style="left:${(x / w) * 100}%;top:${(y / h) * 100}%;--inv:${inv};${fill}"
          aria-label="${name}: ${this._state(s)}"
          @pointerdown=${(ev: PointerEvent) => this._ctlDown(ev, id)}
          @pointerup=${() => this._ctlUp()}
          @pointerleave=${() => this._ctlUp()}
          @pointercancel=${() => this._ctlUp()}
          @click=${() => this._ctlClick(s)}
          @contextmenu=${(ev: Event) => ev.preventDefault()}>
          <span class="ctl-icon"><ha-state-icon .hass=${hass} .stateObj=${s}></ha-state-icon></span>
          <span class="ctl-name">${name}</span>
        </button>`;
      });

    const names = this._arrange ? new Map(this._placeable().map((p) => [p.id, p.name])) : undefined;
    const handles = Object.entries(pos)
      .filter(([id]) => zoom && this._arrange && hass.states[id] && (this._inRoom(id, zoom) || id === this._selected))
      .map(([id, [x, y]]) => {
        const s = hass.states[id];
        const light = domainOf(id) === "light";
        const ring = light && s.state === "on" ? `--ring: rgb(${this._rgb(s).join(",")})` : "";
        const sel = this._selected === id;
        const below = zoom ? y - Math.min(...zoom.shape.map((p) => p[1])) < 12 * unit : y / h < 0.18;
        return html`<span class="handle ${sel ? "selected" : ""} ${this._dragging === id ? "dragging" : ""}"
          style="left:${(x / w) * 100}%;top:${(y / h) * 100}%;--inv:${inv};${ring}"
          @pointerdown=${(ev: PointerEvent) => this._dragStart(ev, id)}>
          <ha-state-icon .hass=${hass} .stateObj=${s}></ha-state-icon>
          ${sel ? html`<span class="tag ${below ? "below" : ""}">${names?.get(id) ?? this._name(s)}</span>` : nothing}
        </span>`;
      });

    const labels = (zoom ? [] : c.rooms).map((room) => {
      const [x, y] = room.label ?? this._centroid(room.shape);
      const e = this._roomEntities(room);
      const on = e.lights.filter((s) => s.state === "on").length;
      const sub = [on ? `${on} on` : "Off", ...e.media.filter((s) => !isOff(s)).map((s) => `${this._name(s, room)} on`)].join(" · ");
      return html`<div class="label" style="left:${(x / w) * 100}%;top:${(y / h) * 100}%">
        <div class="label-name">${this._roomName(room)}</div>
        <div class="label-sub">${sub}</div>
      </div>`;
    });

    return html`<div class="map ${this._arrange ? "arranging" : ""} ${zoom ? "zoomed" : ""}" style="aspect-ratio:${w} / ${h}"
        @pointermove=${(ev: PointerEvent) => this._dragMove(ev)}
        @pointerup=${() => this._dragEnd()}
        @pointercancel=${() => this._dragEnd()}>
      <div class="stage" style=${stage}>
        <svg class="plan" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" @pointerdown=${(ev: PointerEvent) => this._mapDown(ev)}>
          <defs>${defs}</defs>
          <rect class="walls" x="0" y="0" width=${w} height=${h} rx=${unit * 1.5}></rect>
          ${rooms}${glows}${dots}
        </svg>
        <div class="overlay">${labels}${icons}${ctls}${handles}</div>
      </div>
    </div>`;
  }

  private _renderPills() {
    return html`<div class="pills">
      ${this._config!.rooms.map((room) => {
        const on = this._roomEntities(room).lights.filter((s) => s.state === "on");
        return html`<button class="pill" @click=${() => (this._room = room.area)}>
          ${this._roomName(room)}
          <span class="pill-dots">${on.map((s) => html`<i style="background:rgb(${this._rgb(s).join(",")})"></i>`)}</span>
        </button>`;
      })}
    </div>`;
  }

  private _renderArrange(room: RoomConfig) {
    const pos = this._positions;
    const all = this._placeable();
    const sel = this._selected ? all.find((p) => p.id === this._selected) : undefined;
    const selState = sel ? this.hass!.states[sel.id] : undefined;
    const roomName = this._roomName(room);
    const unplaced = all.filter((p) => !pos[p.id] && (p.room === roomName || this._areaOf(p.id) === room.area));
    return html`<div class="arrange">
      ${sel && selState
        ? html`<div class="selected-row">
            <span class="sel-icon"><ha-state-icon .hass=${this.hass} .stateObj=${selState}></ha-state-icon></span>
            <span class="sel-text"><b>${sel.name}</b><span>Drag it to where it really is</span></span>
            <button class="btn" @click=${() => this._remove(sel.id)}>Remove</button>
          </div>`
        : html`<div class="hint">Drag each device to where it really is. Changes save as you go.</div>`}
      ${unplaced.length
        ? html`<div class="section">Not on the map yet</div>
            <div class="wrap">
              ${unplaced.map((p) => html`<button class="pill" @click=${() => this._add(p.id, room)}><ha-icon icon="mdi:plus"></ha-icon>${p.name}</button>`)}
            </div>`
        : nothing}
      <div class="arrange-more">
        <button class="link" @click=${() => this._showYaml()}>Copy positions for the dashboard YAML</button>
        ${this._saved ? html`<button class="link danger" @click=${() => this._reset()}>Reset all rooms to defaults</button>` : nothing}
      </div>
      ${this._yaml
        ? html`<textarea class="yaml" readonly rows="8" .value=${this._yaml} @focus=${(e: Event) => (e.target as HTMLTextAreaElement).select()}></textarea>
            <div class="hint">Copied. Paste it into the card config to keep these positions in git.</div>`
        : nothing}
    </div>`;
  }

  private _headline(room: RoomConfig): string {
    const c = this._config!;
    const e = this._roomEntities(room);
    const vac = c.vacuum ? this.hass!.states[c.vacuum] : undefined;
    const cleaningHere = !!vac && vac.state === "cleaning" && this._vacuumRoom()?.area === room.area;
    const lightsOn = e.lights.filter((s) => s.state === "on").length;
    return [
      lightsOn ? `${lightsOn} light${lightsOn > 1 ? "s" : ""} on` : "Lights off",
      ...e.media.filter((s) => !isOff(s)).map((s) => `${this._name(s, room)} on`),
      ...(cleaningHere ? ["Cleaning"] : []),
    ].join(" · ");
  }

  private _renderRoomBar(room: RoomConfig) {
    if (this._arrange) {
      return html`<div class="room-bar">
        <button class="btn" @click=${() => this._cancelArrange()}>Cancel</button>
        <div class="room-title center"><h2>Edit ${this._roomName(room)}</h2></div>
        <button class="btn primary" @click=${() => this._exitArrange()}>Done</button>
      </div>`;
    }
    return html`<div class="room-bar">
      <button class="round" aria-label="Back to the whole home" @click=${() => (this._room = undefined)}><ha-icon icon="mdi:chevron-left"></ha-icon></button>
      <div class="room-title">
        <h2>${this._roomName(room)}</h2>
        <div class="headline">${this._headline(room)}</div>
      </div>
      <button class="btn" @click=${() => this._enterArrange()}><ha-icon icon="mdi:cursor-move"></ha-icon>Edit</button>
    </div>`;
  }

  private _renderRoom(room: RoomConfig) {
    const c = this._config!;
    const hass = this.hass!;
    const e = this._roomEntities(room);
    const group = room.light ? hass.states[room.light] : undefined;
    const groupPct = group ? this._pct(group) : 0;
    const vac = c.vacuum ? hass.states[c.vacuum] : undefined;
    const cleaningHere = !!vac && vac.state === "cleaning" && this._vacuumRoom()?.area === room.area;
    const na = (s: HassEntity) => s.state === "unavailable";
    const media = e.media.filter((s) => !na(s));
    const devices = e.devices.filter((s) => !na(s));
    const offline = [...e.media, ...e.devices].filter(na);
    const tileRef = (entity: string, name: string) =>
      ref((el?: Element) => {
        const t = el as (HTMLElement & { setConfig(c: unknown): void; _dgKey?: string }) | undefined;
        if (t && t._dgKey !== entity + name) {
          t.setConfig({ type: "custom:dg-light-tile", entity, name });
          t._dgKey = entity + name;
        }
      });

    return html`<div class="room-panel" @keydown=${(ev: KeyboardEvent) => ev.key === "Escape" && (this._room = undefined)}>
        ${e.chips.length
          ? html`<div class="chips">
              ${e.chips.map(
                (s) => html`<button class="chip" @click=${() => fireMoreInfo(this, s.entity_id)}>
                  <ha-state-icon .hass=${hass} .stateObj=${s}></ha-state-icon>${this._state(s)}
                </button>`,
              )}
            </div>`
          : nothing}

        ${group || e.lights.length
          ? html`<h3>Lights</h3>
              ${group
                ? html`<div class="row card">
                    <button class="round big ${groupPct ? "lit" : ""}" aria-label="Toggle all lights" @click=${() => this._call("light", "toggle", { entity_id: group.entity_id })}>
                      <ha-icon icon="mdi:lightbulb-group"></ha-icon>
                    </button>
                    <span class="row-text">
                      <span class="row-line"><span class="row-name">All lights</span><span class="row-sub">${groupPct ? `${groupPct}%` : "Off"}</span></span>
                      <input type="range" min="1" max="100" .value=${String(groupPct)} aria-label="Room brightness"
                        @change=${(ev: Event) => this._call("light", "turn_on", { entity_id: group.entity_id, brightness_pct: Number((ev.target as HTMLInputElement).value) })} />
                    </span>
                  </div>`
                : nothing}
              <div class="grid">${e.lights.map((s) => html`<dg-light-tile .hass=${hass} ${tileRef(s.entity_id, this._name(s, room))}></dg-light-tile>`)}</div>`
          : nothing}

        ${e.scenes.length
          ? html`<h3>Scenes</h3>
              <div class="chips scroll">
                ${e.scenes.map((s) => html`<button class="chip scene" @click=${() => this._call("scene", "turn_on", { entity_id: s.entity_id })}>
                  <ha-icon icon="mdi:palette-outline"></ha-icon>${this._name(s, room)}
                </button>`)}
              </div>`
          : nothing}

        ${vac
          ? html`<h3>Cleaning</h3>
            <div class="row card">
              <span class="row-icon ${vac.state === "cleaning" ? "green" : ""}"><ha-state-icon .hass=${hass} .stateObj=${vac}></ha-state-icon></span>
              <span class="row-text">
                <span class="row-name">${this._name(vac)}</span>
                <span class="row-sub">${room.clean ? (cleaningHere ? `Cleaning ${this._roomName(room).toLowerCase()}` : this._state(vac)) : "This room isn't on the map"}</span>
              </span>
              ${room.clean
                ? cleaningHere
                  ? html`<button class="btn" @click=${() => this._call("vacuum", "return_to_base", { entity_id: vac.entity_id })}>Stop</button>`
                  : html`<button class="btn primary" @click=${() => this._call("vacuum", "clean_area", { entity_id: vac.entity_id, cleaning_area_id: [room.area] })}>Clean this room</button>`
                : nothing}
            </div>`
          : nothing}

        ${media.length
          ? html`<h3>Media</h3>
              <div class="list">
                ${media.map((s) => {
                  const title = s.attributes.media_title ?? s.attributes.app_name ?? s.attributes.source;
                  return html`<div class="row card ${!isOff(s) ? "media-on" : ""}">
                    <button class="row-main" @click=${() => fireMoreInfo(this, s.entity_id)}>
                      <span class="row-icon"><ha-state-icon .hass=${hass} .stateObj=${s}></ha-state-icon></span>
                      <span class="row-text">
                        <span class="row-name">${this._name(s, room)}</span>
                        <span class="row-sub">${this._state(s)}${title && !isOff(s) ? ` · ${title}` : ""}</span>
                      </span>
                    </button>
                    ${s.state === "playing" || s.state === "paused"
                      ? html`<button class="round" aria-label="Play or pause" @click=${() => this._call("media_player", "media_play_pause", { entity_id: s.entity_id })}>
                          <ha-icon icon=${s.state === "playing" ? "mdi:pause" : "mdi:play"}></ha-icon>
                        </button>`
                      : nothing}
                    <button class="round" aria-label="Power" @click=${() => this._call("media_player", "toggle", { entity_id: s.entity_id })}>
                      <ha-icon icon="mdi:power"></ha-icon>
                    </button>
                  </div>`;
                })}
              </div>`
          : nothing}

        ${devices.length
          ? html`<h3>Devices</h3>
              <div class="grid">
                ${devices.map((s) => {
                  return html`<button class="tile ${!isOff(s) ? "on" : ""}"
                    @click=${() => this._toggleEntity(s)}
                    @contextmenu=${(ev: Event) => {
                      ev.preventDefault();
                      fireMoreInfo(this, s.entity_id);
                    }}>
                    <span class="row-icon"><ha-state-icon .hass=${hass} .stateObj=${s}></ha-state-icon></span>
                    <span class="row-text"><span class="row-name">${this._name(s, room)}</span><span class="row-sub">${this._state(s)}</span></span>
                  </button>`;
                })}
              </div>`
          : nothing}

        ${offline.length
          ? html`<details class="offline">
              <summary>Unavailable (${offline.length})</summary>
              <div class="offline-list">
                ${offline.map(
                  (s) => html`<button class="offline-item" @click=${() => fireMoreInfo(this, s.entity_id)}>
                    <ha-state-icon .hass=${hass} .stateObj=${s}></ha-state-icon>${this._name(s, room)}
                  </button>`,
                )}
              </div>
            </details>`
          : nothing}
      </div>`;
  }

  static styles = css`
    :host {
      display: block;
      --fp-bg: var(--ha-card-background, var(--card-background-color, #fff));
      --fp-surface: color-mix(in srgb, var(--primary-text-color, #1c1c1e) 9%, transparent);
      --fp-accent: var(--primary-color, #ff9f0a);
    }
    ha-card {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    button {
      font: inherit;
      color: inherit;
      border: none;
      background: none;
      padding: 0;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    .summary {
      color: var(--secondary-text-color);
      font-size: 14px;
    }
    .quick {
      display: grid;
      gap: 8px;
    }
    .qa {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      padding: 10px;
      border-radius: 18px;
      background: var(--fp-surface);
      text-align: left;
      min-height: 84px;
      transition: transform 120ms ease;
    }
    .qa:active,
    .pill:active,
    .chip:active,
    .tile:active {
      transform: scale(0.96);
    }
    .qa-icon {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--fp-bg);
      color: var(--secondary-text-color);
      --mdc-icon-size: 20px;
      margin-bottom: 4px;
    }
    .qa.active .qa-icon {
      background: var(--fp-accent);
      color: #1c1c1e;
    }
    .qa-name {
      font-size: 13px;
      font-weight: 600;
      line-height: 1.2;
    }
    .qa-sub {
      font-size: 12px;
      color: var(--secondary-text-color);
    }
    .map {
      position: relative;
      width: 100%;
      overflow: hidden;
      border-radius: calc(var(--ha-card-border-radius, 12px) - 6px);
      user-select: none;
      -webkit-user-select: none;
    }
    .stage {
      position: absolute;
      inset: 0;
      transform-origin: 0 0;
      transition: transform 450ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    @media (prefers-reduced-motion: reduce) {
      .stage {
        transition: none;
      }
    }
    .room.dim {
      opacity: 0.4;
    }
    .map.zoomed .walls {
      opacity: 0.25;
    }
    /* Controls in a zoomed room: counter-scaled so they keep their size, shown once the zoom lands. */
    .ctl {
      position: absolute;
      transform: translate(-50%, -21px) scale(var(--inv, 1));
      transform-origin: 50% 21px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      pointer-events: all;
      -webkit-tap-highlight-color: transparent;
      animation: ctl-in 220ms ease 300ms both;
    }
    @keyframes ctl-in {
      from {
        opacity: 0;
      }
    }
    .ctl-icon {
      width: 42px;
      height: 42px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--fp-bg);
      color: var(--secondary-text-color);
      box-shadow: 0 0 0 1px var(--divider-color, rgba(0, 0, 0, 0.12)), 0 2px 8px rgba(0, 0, 0, 0.25);
      --mdc-icon-size: 22px;
      transition: background 150ms ease, color 150ms ease;
    }
    .ctl.on .ctl-icon {
      background: var(--fill, var(--fp-accent));
      color: #1c1c1e;
    }
    .ctl.na .ctl-icon {
      opacity: 0.45;
      box-shadow: 0 0 0 1px var(--divider-color, rgba(0, 0, 0, 0.12));
    }
    .ctl:active .ctl-icon {
      transform: scale(0.92);
    }
    .ctl-name {
      max-width: 96px;
      padding: 1px 6px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--fp-bg) 80%, transparent);
      font-size: 11px;
      font-weight: 600;
      line-height: 1.3;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .room-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
    }
    .room-title {
      flex: 1;
      min-width: 0;
    }
    .room-title.center {
      text-align: center;
    }
    .room-title h2 {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .btn ha-icon {
      --mdc-icon-size: 16px;
      margin-right: 4px;
      vertical-align: -3px;
    }
    /* The room's controls sit on the card itself, so their surfaces get a tint instead of the card colour. */
    .room-panel {
      --ha-card-background: color-mix(in srgb, var(--primary-text-color, #1c1c1e) 8%, var(--card-background-color, #fff));
    }
    .room-panel .chip,
    .room-panel .card,
    .room-panel .tile {
      background: var(--fp-surface);
    }
    .room-panel > h3:first-child,
    .room-panel > .chips:first-child {
      margin-top: 0;
    }
    .map.arranging {
      touch-action: none;
    }
    svg.plan {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
    }
    .walls {
      fill: var(--secondary-text-color);
      opacity: 0.35;
    }
    .room {
      fill: var(--fp-bg);
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    .room.pressing {
      fill: color-mix(in srgb, var(--fp-accent) 22%, var(--fp-bg));
      transition: fill 450ms ease;
    }
    .room.selected {
      stroke: var(--fp-accent);
      stroke-width: 6;
    }
    .dot {
      fill: none;
      stroke: var(--secondary-text-color);
      stroke-width: 3;
      pointer-events: none;
    }
    .dot.on {
      stroke: var(--fp-bg);
    }
    .dot.na {
      stroke-dasharray: 4 4;
    }
    .overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .label {
      position: absolute;
      transform: translate(-50%, -50%);
      text-align: center;
      white-space: nowrap;
    }
    .label {
      text-shadow: 0 0 2px var(--fp-bg), 0 0 6px var(--fp-bg), 0 0 10px var(--fp-bg);
    }
    .label-name {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: -0.2px;
    }
    .label-sub {
      font-size: 11px;
      color: var(--secondary-text-color);
    }
    .icon {
      position: absolute;
      transform: translate(-50%, -50%);
      width: 26px;
      height: 26px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--fp-bg);
      color: var(--secondary-text-color);
      box-shadow: 0 0 0 0.5px var(--divider-color, rgba(0, 0, 0, 0.12));
      --mdc-icon-size: 16px;
      transition: left 1s ease, top 1s ease;
    }
    .icon.active {
      background: var(--fp-accent);
      color: #1c1c1e;
    }
    .icon.vacuum.active {
      background: var(--success-color, #34c759);
      color: #fff;
    }
    .arranging .label {
      opacity: 0.35;
    }
    .arranging .room {
      cursor: default;
    }
    .handle {
      position: absolute;
      transform: translate(-50%, -50%) scale(var(--inv, 1));
      width: 30px;
      height: 30px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--fp-bg);
      color: var(--primary-text-color);
      box-shadow: 0 0 0 2px var(--ring, var(--secondary-text-color)), 0 2px 6px rgba(0, 0, 0, 0.35);
      --mdc-icon-size: 17px;
      pointer-events: all;
      cursor: grab;
      touch-action: none;
      transition: transform 120ms ease;
    }
    /* 44px touch target around the 30px handle. */
    .handle::before {
      content: "";
      position: absolute;
      inset: -7px;
      border-radius: 50%;
    }
    .handle.selected {
      z-index: 2;
      box-shadow: 0 0 0 3px var(--fp-accent), 0 2px 8px rgba(0, 0, 0, 0.4);
    }
    .handle.dragging {
      cursor: grabbing;
      transform: translate(-50%, -50%) scale(calc(var(--inv, 1) * 1.2));
    }
    .tag {
      position: absolute;
      bottom: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      padding: 4px 9px;
      border-radius: 8px;
      background: var(--primary-text-color);
      color: var(--fp-bg);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      pointer-events: none;
    }
    .tag.below {
      bottom: auto;
      top: calc(100% + 8px);
    }
    /* While dragging, lift the name clear of the finger. */
    .handle.dragging .tag:not(.below) {
      bottom: calc(100% + 30px);
    }
    .selected-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 8px 8px 10px;
      border-radius: 14px;
      background: var(--fp-surface);
    }
    .sel-icon {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--fp-bg);
      --mdc-icon-size: 18px;
    }
    .sel-text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      font-size: 14px;
    }
    .sel-text span {
      font-size: 12px;
      color: var(--secondary-text-color);
    }
    .add-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .add-room {
      font-size: 12px;
      font-weight: 600;
      color: var(--secondary-text-color);
    }
    .pill ha-icon {
      --mdc-icon-size: 16px;
      margin-left: -4px;
    }
    .arrange-more {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 16px;
      margin-top: 4px;
    }
    .link {
      padding: 6px 0;
      font-size: 13px;
      color: var(--secondary-text-color);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .link.danger {
      color: var(--error-color, #ff453a);
    }
    .arrange-btn {
      position: absolute;
      right: 6px;
      bottom: 6px;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--fp-bg);
      color: var(--secondary-text-color);
      display: grid;
      place-items: center;
      --mdc-icon-size: 18px;
      opacity: 0.8;
    }
    .pills,
    .chips.scroll {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      scrollbar-width: none;
      margin: 0 -14px;
      padding: 0 14px;
    }
    .pill {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 36px;
      padding: 0 14px;
      border-radius: 999px;
      background: var(--fp-surface);
      font-size: 13px;
      font-weight: 500;
    }
    .pill.selected {
      background: var(--fp-accent);
      color: #1c1c1e;
    }
    .pill-dots {
      display: inline-flex;
    }
    .pill-dots i {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-left: 2px;
    }
    .pill-room {
      font-size: 11px;
      color: var(--secondary-text-color);
    }
    .arrange {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .hint,
    .section {
      font-size: 13px;
      color: var(--secondary-text-color);
    }
    .wrap {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .btn {
      height: 36px;
      padding: 0 14px;
      border-radius: 999px;
      background: var(--fp-surface);
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
    }
    .btn.primary {
      background: var(--fp-accent);
      color: #1c1c1e;
    }
    .btn:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .yaml {
      width: 100%;
      box-sizing: border-box;
      font: 12px ui-monospace, monospace;
      border-radius: 12px;
      border: 1px solid var(--divider-color);
      background: var(--fp-surface);
      color: var(--primary-text-color);
      padding: 8px;
    }
    h2 {
      margin: 0;
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.4px;
    }
    .headline {
      font-size: 13px;
      color: var(--secondary-text-color);
      margin-top: 2px;
    }
    details.offline {
      margin-top: 18px;
      font-size: 13px;
      color: var(--secondary-text-color);
    }
    details.offline summary {
      cursor: pointer;
      padding: 6px 0;
    }
    .offline-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding-top: 6px;
    }
    .offline-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--fp-surface);
      --mdc-icon-size: 16px;
      opacity: 0.7;
    }
    h3 {
      margin: 18px 0 8px;
      font-size: 13px;
      font-weight: 500;
      color: var(--secondary-text-color);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }
    .chips.scroll {
      flex-wrap: nowrap;
      margin: 0 -16px;
      padding: 0 16px;
    }
    .chip {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 12px;
      border-radius: 999px;
      background: var(--fp-bg);
      font-size: 13px;
      --mdc-icon-size: 16px;
      color: var(--secondary-text-color);
    }
    .chip.scene {
      color: var(--primary-text-color);
      font-weight: 500;
      height: 36px;
      box-sizing: border-box;
    }
    .card {
      background: var(--fp-bg);
      border-radius: 18px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      margin-top: 14px;
    }
    h3 + .row,
    .list .row {
      margin-top: 0;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .row-main {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      text-align: left;
    }
    .row-icon {
      flex: none;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--fp-surface);
      color: var(--secondary-text-color);
      --mdc-icon-size: 20px;
    }
    .row-icon.green {
      background: var(--success-color, #34c759);
      color: #fff;
    }
    .row-text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .row-line {
      display: flex;
      justify-content: space-between;
    }
    .row-name {
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .row-sub {
      font-size: 12px;
      color: var(--secondary-text-color);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .media-on {
      background: rgba(255, 159, 10, 0.16);
    }
    .round {
      flex: none;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--fp-surface);
      display: grid;
      place-items: center;
      --mdc-icon-size: 20px;
    }
    .round.big {
      width: 44px;
      height: 44px;
    }
    .round.lit {
      background: var(--fp-accent);
      color: #1c1c1e;
    }
    input[type="range"] {
      width: 100%;
      accent-color: var(--fp-accent);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 8px;
    }
    h3 + .grid {
      margin-top: 0;
    }
    /* The tile sets its own min-height; a fixed height here made it overflow into the next row. */
    .grid dg-light-tile {
      display: block;
    }
    .tile {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px;
      min-height: 64px;
      border-radius: 18px;
      background: var(--fp-bg);
      text-align: left;
      transition: transform 120ms ease;
    }
    .tile.on .row-icon {
      background: var(--fp-accent);
      color: #1c1c1e;
    }
    .na {
      opacity: 0.5;
    }
  `;
}

if (!customElements.get(TAG)) customElements.define(TAG, FloorPlanCard);

registerCard({
  type: TAG,
  name: "Floor plan",
  description: "Home floor plan: rooms glow with their lights, tap a room for everything in it, quick actions on top.",
});

declare global {
  interface HTMLElementTagNameMap {
    [TAG]: FloorPlanCard;
  }
}
