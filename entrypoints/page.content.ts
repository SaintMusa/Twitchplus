import { startFeatures, type Status } from '@/lib/loader';
import { MODULES } from '@/lib/modules';
import { MIRROR_KEY, parse, type Settings } from '@/lib/settings';

declare global {
  interface Window {
    __twitchPlus?: { settings: Settings; status: Status };
  }
}

// Page context, before Twitch's own scripts: features that patch Twitch's code must hook in this early.
// Settings come from the localStorage copy the bridge keeps (see lib/settings.ts).
export default defineContentScript({
  matches: ['https://www.twitch.tv/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    if (window.__twitchPlus) return;
    let json: string | null = null;
    try {
      json = localStorage.getItem(MIRROR_KEY);
    } catch {}
    const settings = parse(json);
    // Inspect from the console: __twitchPlus.status
    window.__twitchPlus = { settings, status: startFeatures(settings, MODULES) };
  },
});
