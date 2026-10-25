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
// Every twitch.tv host and frame, because ad blocking also has to run in player.twitch.tv embeds; the loader starts
// only features marked `subdomains` outside www.twitch.tv's top frame.
export default defineContentScript({
  matches: ['https://*.twitch.tv/*'],
  allFrames: true,
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
    const place = location.hostname === 'www.twitch.tv' && window === window.top ? 'main' : 'other';
    window.__twitchPlus = { settings, status: startFeatures(settings, MODULES, place) };
  },
});
