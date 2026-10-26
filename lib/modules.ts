import type { Value } from './features';
import adBlock from './modules/ad-block';
import chatHotkeys from './modules/chat-hotkeys';
import hoverPause from './modules/hover-pause';
import latency from './modules/latency';
import linkCards from './modules/link-cards';
import pins from './modules/pins';
import preferredQuality from './modules/preferred-quality';
import rewind from './modules/rewind';
import screenshot from './modules/screenshot';
import viewerLogs from './modules/viewer-logs';

/** Runs in twitch.tv's page context at document start, once, only when its feature is on. */
export type Module = (options: Record<string, Value>) => void;

// Keyed by feature id (lib/features.ts).
// They start in lib/features.ts order, so Rewind hooks Twitch's chunk queue before Preferred quality does.
export const MODULES: Record<string, Module> = {
  rewind,
  quality: preferredQuality,
  latency,
  screenshot,
  chatHotkeys,
  hoverPause,
  linkCards,
  viewerLogs,
  pins,
  adBlock,
};
