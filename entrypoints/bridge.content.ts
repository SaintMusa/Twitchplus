import { REQUEST, RESULT, type FetchResult } from '@/lib/relay';
import { MIRROR_KEY, STORE_KEY, parse, resolve } from '@/lib/settings';

const RELOADED = 'twitchPlus.reloadedForSettings';
const NETWORK_ERROR: FetchResult = { status: 0, text: '', finalUrl: '', headers: '', error: 'network' };

// Extension side (isolated world): copies the popup's settings into twitch.tv's localStorage,
// where the page-side script reads them synchronously at document start.
// It also relays page-context fetches to the background worker (lib/relay.ts).
export default defineContentScript({
  // Same pages as the page script: each twitch.tv host has its own localStorage, so each needs the copy.
  matches: ['https://*.twitch.tv/*'],
  allFrames: true,
  runAt: 'document_start',
  async main() {
    // Registered before any await, so requests made while the page starts are not missed.
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.type !== REQUEST) return;
      const { id, request } = event.data;
      const answer = (result: FetchResult) => window.postMessage({ type: RESULT, id, result }, location.origin);
      browser.runtime.sendMessage({ type: REQUEST, request }).then(
        (result: FetchResult | undefined) => answer(result ?? NETWORK_ERROR),
        () => answer(NETWORK_ERROR),
      );
    });

    /** Writes the copy; true when the page started with different settings than these. */
    const mirror = (stored: unknown) => {
      const next = JSON.stringify(resolve(stored));
      let prev: string | null = null;
      try {
        prev = localStorage.getItem(MIRROR_KEY);
        if (prev !== next) localStorage.setItem(MIRROR_KEY, next);
      } catch {
        return false;
      }
      return JSON.stringify(parse(prev)) !== next;
    };

    const { [STORE_KEY]: stored } = await browser.storage.sync.get(STORE_KEY);
    // Only stale when settings changed while no Twitch tab was open (open tabs are kept current below).
    // Reload once so this page runs with them; the flag stops a loop if storage keeps failing.
    if (mirror(stored)) {
      if (!sessionStorage.getItem(RELOADED)) {
        sessionStorage.setItem(RELOADED, '1');
        location.reload();
        return;
      }
    }
    sessionStorage.removeItem(RELOADED);

    // Open tabs pick up a change on their next load; the popup offers to reload them.
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && STORE_KEY in changes) mirror(changes[STORE_KEY].newValue);
    });
  },
});
