import { FEATURES } from './features';
import type { Module } from './modules';
import { optionsOf, type Settings } from './settings';

export type Status = Record<string, 'on' | 'off' | 'error'>;

/** Where the page script is running: www.twitch.tv's top frame, or any other twitch.tv page or frame. */
export type Place = 'main' | 'other';

/** Starts every module whose feature is on, each isolated so one failure leaves the rest running. */
export function startFeatures(settings: Settings, modules: Record<string, Module>, place: Place = 'main'): Status {
  const status: Status = {};
  for (const feature of FEATURES) {
    const start = modules[feature.id];
    if (!start) continue;
    if (place === 'other' && !feature.subdomains) continue;
    if (settings[feature.id] !== true) {
      status[feature.id] = 'off';
      continue;
    }
    try {
      start(optionsOf(settings, feature.id));
      status[feature.id] = 'on';
    } catch (err) {
      status[feature.id] = 'error';
      console.error(`[Twitch Plus] ${feature.id} failed to start`, err);
    }
  }
  return status;
}
