// Minimal slices of HA's frontend types — enough for these cards without pulling in the frontend repo.
export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any> & {
    friendly_name?: string;
    brightness?: number;
    rgb_color?: [number, number, number];
    supported_color_modes?: string[];
  };
}

export interface EntityRegistryDisplayEntry {
  entity_id: string;
  name?: string | null;
  device_id?: string | null;
  area_id?: string | null;
  hidden?: boolean;
  entity_category?: "config" | "diagnostic" | null;
}

export interface DeviceRegistryEntry {
  id: string;
  area_id?: string | null;
  name?: string | null;
}

export interface AreaRegistryEntry {
  area_id: string;
  name: string;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  entities?: Record<string, EntityRegistryDisplayEntry>;
  devices?: Record<string, DeviceRegistryEntry>;
  areas?: Record<string, AreaRegistryEntry>;
  themes?: { darkMode?: boolean };
  callService(domain: string, service: string, data?: Record<string, unknown>): Promise<unknown>;
  callWS?<T>(msg: Record<string, unknown>): Promise<T>;
  formatEntityState?(stateObj: HassEntity, state?: string): string;
  locale?: { language: string };
}

export interface CustomCardEntry {
  type: string;
  name: string;
  description?: string;
  preview?: boolean;
  documentationURL?: string;
}

declare global {
  interface Window {
    customCards?: CustomCardEntry[];
  }
}

export function registerCard(entry: CustomCardEntry): void {
  window.customCards = window.customCards ?? [];
  if (!window.customCards.some((c) => c.type === entry.type)) window.customCards.push(entry);
}

/** Open HA's native more-info dialog for an entity (same event the built-in cards fire). */
export function fireMoreInfo(node: HTMLElement, entityId: string): void {
  node.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
}
