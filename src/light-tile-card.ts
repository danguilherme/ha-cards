import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { fireMoreInfo, registerCard, type HassEntity, type HomeAssistant } from "./types";

export interface LightTileConfig {
  type: string;
  entity: string;
  name?: string;
  icon?: string;
}

const TAG = "dg-light-tile";
const HOLD_MS = 500;
const DRAG_THRESHOLD_PX = 8;
const FALLBACK_ON: [number, number, number] = [255, 179, 64];

/**
 * Apple Home-style light tile.
 *  - tap: toggle
 *  - drag horizontally: set brightness (the fill follows the finger, applied on release)
 *  - long-press: HA's more-info dialog
 * When on, the whole tile is tinted with the bulb's actual color (rgb_color).
 */
export class LightTileCard extends LitElement {
  static properties = {
    hass: { attribute: false },
    _config: { state: true },
    _dragPct: { state: true },
  };

  // `declare`: reactive properties must not be emitted as class fields, or they shadow Lit's accessors.
  declare hass?: HomeAssistant;
  private declare _config?: LightTileConfig;
  private declare _dragPct?: number;

  private _pointer?: { id: number; x: number; startPct: number; dragging: boolean; timer?: number; held: boolean };

  static getStubConfig(hass: HomeAssistant): Partial<LightTileConfig> {
    const light = Object.keys(hass.states).find((id) => id.startsWith("light."));
    return { entity: light ?? "light.example" };
  }

  setConfig(config: LightTileConfig): void {
    if (!config?.entity?.startsWith("light.")) throw new Error(`${TAG}: 'entity' must be a light.* entity`);
    this._config = config;
  }

  getCardSize(): number {
    return 2;
  }

  /** Sections view sizing: half width, two rows (same footprint as a vertical tile). */
  getGridOptions() {
    return { columns: 6, rows: 2, min_columns: 4, min_rows: 2 };
  }

  protected shouldUpdate(changed: PropertyValues): boolean {
    if (changed.has("_config") || changed.has("_dragPct")) return true;
    const old = changed.get("hass") as HomeAssistant | undefined;
    return !old || !this._config || old.states[this._config.entity] !== this.hass?.states[this._config.entity];
  }

  private get _stateObj(): HassEntity | undefined {
    return this._config ? this.hass?.states[this._config.entity] : undefined;
  }

  private _brightnessPct(s: HassEntity): number {
    return s.state === "on" ? Math.max(1, Math.round(((s.attributes.brightness ?? 255) / 255) * 100)) : 0;
  }

  private _dimmable(s: HassEntity): boolean {
    const modes = s.attributes.supported_color_modes ?? [];
    return modes.some((m) => m !== "onoff");
  }

  // --- pointer handling: tap / hold / horizontal drag ---------------------------------------------

  private _onDown(ev: PointerEvent): void {
    const s = this._stateObj;
    if (!s || ev.button !== 0) return;
    try {
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is best-effort (e.g. pointer already released) */
    }
    const timer = window.setTimeout(() => {
      if (this._pointer && !this._pointer.dragging) {
        this._pointer.held = true;
        fireMoreInfo(this, s.entity_id);
      }
    }, HOLD_MS);
    this._pointer = { id: ev.pointerId, x: ev.clientX, startPct: this._brightnessPct(s), dragging: false, held: false, timer };
  }

  private _onMove(ev: PointerEvent): void {
    const p = this._pointer;
    const s = this._stateObj;
    if (!p || p.id !== ev.pointerId || p.held || !s || !this._dimmable(s)) return;
    const dx = ev.clientX - p.x;
    if (!p.dragging && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    if (!p.dragging) {
      p.dragging = true;
      clearTimeout(p.timer);
    }
    const width = this.getBoundingClientRect().width || 1;
    this._dragPct = Math.round(Math.min(100, Math.max(0, p.startPct + (dx / width) * 100)));
  }

  private _onUp(ev: PointerEvent): void {
    const p = this._pointer;
    const s = this._stateObj;
    if (!p || p.id !== ev.pointerId || !s) return;
    clearTimeout(p.timer);
    this._pointer = undefined;
    if (p.held) return;
    if (p.dragging && this._dragPct !== undefined) {
      const pct = this._dragPct;
      this.hass!.callService("light", pct === 0 ? "turn_off" : "turn_on", {
        entity_id: s.entity_id,
        ...(pct > 0 ? { brightness_pct: pct } : {}),
      });
      // keep showing the target until HA reports the new state
      window.setTimeout(() => (this._dragPct = undefined), 800);
      return;
    }
    this.hass!.callService("light", "toggle", { entity_id: s.entity_id });
  }

  private _onCancel(): void {
    clearTimeout(this._pointer?.timer);
    this._pointer = undefined;
    this._dragPct = undefined;
  }

  // --- render ---------------------------------------------------------------------------------------

  protected render() {
    if (!this._config || !this.hass) return nothing;
    const s = this._stateObj;
    if (!s) return html`<ha-card class="tile missing">${this._config.entity} not found</ha-card>`;

    const on = s.state === "on";
    const unavailable = s.state === "unavailable";
    const pct = this._dragPct ?? this._brightnessPct(s);
    const [r, g, b] = s.attributes.rgb_color ?? FALLBACK_ON;
    const name = this._config.name ?? s.attributes.friendly_name ?? s.entity_id;
    const stateText = unavailable ? "Unavailable" : pct > 0 ? `${pct}%` : "Off";

    return html`
      <ha-card
        class="tile ${on || pct > 0 ? "on" : ""} ${unavailable ? "unavailable" : ""}"
        style="--light-rgb: ${r}, ${g}, ${b}; --fill: ${pct}%"
        role="button"
        tabindex="0"
        aria-label="${name}: ${stateText}"
        @pointerdown=${this._onDown}
        @pointermove=${this._onMove}
        @pointerup=${this._onUp}
        @pointercancel=${this._onCancel}
        @keydown=${(e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && this.hass!.callService("light", "toggle", { entity_id: s.entity_id })}
        @contextmenu=${(e: Event) => e.preventDefault()}
      >
        <div class="fill"></div>
        <div class="icon">
          ${this._config.icon
            ? html`<ha-icon .icon=${this._config.icon}></ha-icon>`
            : html`<ha-state-icon .hass=${this.hass} .stateObj=${s}></ha-state-icon>`}
        </div>
        <div class="info">
          <div class="name">${name}</div>
          <div class="state">${stateText}</div>
        </div>
      </ha-card>
    `;
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
    }
    .tile {
      position: relative;
      height: 100%;
      min-height: 112px;
      box-sizing: border-box;
      padding: 14px;
      border-radius: var(--ha-card-border-radius, 12px);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      overflow: hidden;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      touch-action: pan-y;
      -webkit-tap-highlight-color: transparent;
      background: var(--ha-card-background, var(--card-background-color));
      transition: transform 120ms ease;
    }
    .tile:active {
      transform: scale(0.97);
    }
    .fill {
      position: absolute;
      inset: 0 auto 0 0;
      width: var(--fill);
      background: rgba(var(--light-rgb), 0.28);
      transition: width 160ms ease, opacity 200ms ease;
      opacity: 0;
      pointer-events: none;
    }
    .tile.on {
      background: rgba(var(--light-rgb), 0.18);
    }
    .tile.on .fill {
      opacity: 1;
    }
    .icon {
      position: relative;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: var(--state-inactive-color, #aeaeb2);
      background: rgba(127, 127, 127, 0.14);
      --mdc-icon-size: 22px;
    }
    .tile.on .icon {
      color: #1c1c1e;
      background: rgb(var(--light-rgb));
    }
    .info {
      position: relative;
    }
    .name {
      font-size: var(--ha-tile-info-primary-font-size, 15px);
      font-weight: var(--ha-tile-info-primary-font-weight, 600);
      letter-spacing: var(--ha-tile-info-primary-letter-spacing, -0.2px);
      color: var(--primary-text-color);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .state {
      font-size: var(--ha-tile-info-secondary-font-size, 13px);
      color: var(--secondary-text-color);
      font-variant-numeric: tabular-nums;
    }
    .unavailable {
      opacity: 0.5;
      cursor: default;
    }
    .missing {
      padding: 14px;
      color: var(--error-color);
    }
  `;
}

if (!customElements.get(TAG)) customElements.define(TAG, LightTileCard);

registerCard({
  type: TAG,
  name: "Light tile (Apple Home-style)",
  description: "Tap to toggle, drag to dim, long-press for details. Tinted with the bulb's color.",
  preview: true,
});

declare global {
  interface HTMLElementTagNameMap {
    [TAG]: LightTileCard;
  }
}
