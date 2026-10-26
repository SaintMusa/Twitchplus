import { FEATURES, optionKey, type Value } from './features';

// Settings are one flat object: "<feature>" is its on/off switch, "<feature>.<option>" its options.
export type Settings = Record<string, Value>;

/** Key in browser.storage.sync, written by the popup. */
export const STORE_KEY = 'settings';

/**
 * Key in twitch.tv's localStorage. Page-side code runs before Twitch's own scripts and cannot wait
 * for the async extension storage, so the bridge content script keeps this copy in step with it.
 */
export const MIRROR_KEY = 'twitchPlus.settings';

export function defaults(): Settings {
  const out: Settings = {};
  for (const f of FEATURES) {
    out[f.id] = f.default;
    for (const o of f.options ?? []) out[optionKey(f.id, o.id)] = o.default;
  }
  return out;
}

const sameType = (a: Value, b: unknown) => typeof a === typeof b;

/** Defaults overlaid with whatever stored values are known and of the right type. */
export function resolve(stored: unknown): Settings {
  const out = defaults();
  if (!stored || typeof stored !== 'object') return out;
  for (const [key, value] of Object.entries(stored)) {
    if (key in out && sameType(out[key]!, value)) out[key] = value as Value;
  }
  return out;
}

export function parse(json: string | null): Settings {
  try {
    return resolve(json ? JSON.parse(json) : null);
  } catch {
    return defaults();
  }
}

/** The options of one feature, keyed by option id. */
export function optionsOf(settings: Settings, feature: string): Record<string, Value> {
  const prefix = `${feature}.`;
  const out: Record<string, Value> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  }
  return out;
}
