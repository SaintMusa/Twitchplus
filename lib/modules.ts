import type { Value } from './features';
import chatHotkeys from './modules/chat-hotkeys';

/** Runs in twitch.tv's page context at document start, once, only when its feature is on. */
export type Module = (options: Record<string, Value>) => void;

// Keyed by feature id (lib/features.ts). Features marked ready: false have no module yet.
export const MODULES: Record<string, Module> = {
  chatHotkeys,
};
