import { REQUEST, performFetch, type FetchRequest } from '@/lib/relay';

// Fetches for page-context features, relayed by the bridge content script (see lib/relay.ts).
export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: { type?: string; request?: FetchRequest }, sender) => {
    if (message?.type !== REQUEST || !message.request) return undefined;
    // Only our own content scripts on twitch.tv.
    if (sender.id !== browser.runtime.id || !sender.url || !/^https:\/\/([a-z0-9-]+\.)*twitch\.tv\//.test(sender.url)) return undefined;
    return performFetch(message.request);
  });
});
