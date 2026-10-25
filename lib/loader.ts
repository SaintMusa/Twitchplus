import { FEATURES } from './features';
import type { Module } from './modules';
import { optionsOf, type Settings } from './settings';

export type Status = Record<string, 'on' | 'off' | 'error'>;

/** Starts every module whose feature is on, each isolated so one failure leaves the rest running. */
export function startFeatures(settings: Settings, modules: Record<string, Module>): Status {
  const status: Status = {};
  for (const feature of FEATURES) {
    const start = modules[feature.id];
    if (!start) continue;
    if (settings[feature.id] !== true) {
      status[feature.id] = 'off';
      continue;
    }
    // One broken feature must never take Twitch or the other features down with it.
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
