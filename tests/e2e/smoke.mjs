// Live smoke test: opens a live Twitch channel in your installed Chrome with the built page script injected
// before Twitch's own scripts (as the extension's content script is), then prints what each feature reports.
//
//   npm run build && npm run test:e2e                    # a live channel from Twitch's front page list
//   npm run test:e2e -- --channel=somechannel            # a given channel
//   npm run test:e2e -- --settings='{"quality.ceiling":"720"}'
//   npm run test:e2e -- --headed                         # watch it
//   npm run test:e2e -- --no-inject                      # baseline: plain Twitch, to tell its own errors apart
//   npm run test:e2e -- --screenshot=shot.png            # save what the page looks like at the end
//   npm run test:e2e -- --fake-link=https://youtu.be/x   # feed chat a message with this link (for link cards)
//   npm run test:e2e -- --open-viewer-card               # click the first name in chat (for chat logs)
//
// It needs network access to twitch.tv and runs signed out, in a throwaway profile.
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { performFetch } from '../../lib/relay.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const WAIT_MS = Number(args.wait ?? 20000);
const payload = await readFile(new URL('../../.output/chrome-mv3/content-scripts/page.js', import.meta.url), 'utf8');
const settings = args.settings ? JSON.parse(args.settings) : {};

const browser = await chromium.launch({ channel: 'chrome', headless: !args.headed, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

// Errors plain Twitch also throws in this setup (checked with --no-inject), so they say nothing about us.
const TWITCH_OWN = [/getLayoutMap\(\) must be called from a top-level browsing context/];
const problems = [];
page.on('pageerror', (e) => { if (!TWITCH_OWN.some((re) => re.test(e.message))) problems.push(`pageerror: ${e.message}`); });
page.on('console', (m) => {
  if (m.type() === 'error' && /Twitch Plus|Twitch Native|Rewind|Pins|Latency|Screenshot/i.test(m.text())) problems.push(`console: ${m.text()}`);
});

// Same order as the extension: settings copy first (the bridge's job), then the page script.
await page.addInitScript(({ settings }) => {
  if (!/(^|\.)twitch\.tv$/.test(location.hostname)) return;
  localStorage.setItem('twitchPlus.settings', JSON.stringify(settings));
  localStorage.setItem('twitchNativeRewind.debug', '1');
}, { settings });
// Like the manifest: every twitch.tv host and frame (the loader keeps most features to www's top frame).
if (!args['no-inject']) await page.addInitScript({ content: `if (/(^|\\.)twitch\\.tv$/.test(location.hostname)) {
${payload}
}` });

// Stand-in for the bridge and background worker: answers the page's fetch requests (lib/relay.ts) with the
// same performFetch the background worker runs, here in Node.
await page.exposeFunction('__twitchPlusTestFetch', (request) => performFetch(request));
await page.addInitScript(() => {
  if (location.hostname !== 'www.twitch.tv' || window !== window.top) return;
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.type !== 'twitchPlus.fetch') return;
    const result = await window.__twitchPlusTestFetch(event.data.request);
    window.postMessage({ type: 'twitchPlus.fetchResult', id: event.data.id, result }, location.origin);
  });
});

if (args['fake-link']) {
  // Wraps Twitch's chat WebSocket; after the first real chat line, dispatches one made-up line with the link,
  // copying that line's room tags so Twitch shows it.
  await page.addInitScript((link) => {
    if (location.hostname !== 'www.twitch.tv' || window !== window.top) return;
    const Native = window.WebSocket;
    const debug = (window.__twitchPlusFakeLink = { sockets: [], sent: null });
    window.WebSocket = class extends Native {
      constructor(...a) {
        super(...a);
        debug.sockets.push(String(a[0]));
        if (!String(a[0]).includes('irc-ws')) return;
        let sent = false;
        this.addEventListener('message', (event) => {
          const line = String(event.data).split('\r\n').find((l) => l.includes(' PRIVMSG #'));
          if (sent || !line || event.__fake) return;
          sent = true;
          const room = /room-id=(\d+)/.exec(line)?.[1] ?? '';
          const channel = / PRIVMSG (#\S+) /.exec(line)[1];
          const id = crypto.randomUUID();
          // IRC lines end in CRLF; Twitch's parser splits on it.
          const fake = `@badge-info=;badges=;color=#1E90FF;display-name=TwitchPlusTest;emotes=;first-msg=0;flags=;id=${id};mod=0;returning-chatter=0;room-id=${room};subscriber=0;tmi-sent-ts=${Date.now()};turbo=0;user-id=1;user-type= :twitchplustest!twitchplustest@twitchplustest.tmi.twitch.tv PRIVMSG ${channel} :link card test ${link}\r\n`;
          setTimeout(() => {
            const message = new MessageEvent('message', { data: fake });
            message.__fake = true;
            this.dispatchEvent(message);
            debug.sent = { channel, room, at: Date.now() };
          }, 2000);
        });
      }
    };
  }, args['fake-link']);
}

let channel = args.channel;
if (!channel) {
  await page.goto('https://www.twitch.tv/robots.txt');
  channel = await page.evaluate(async () => {
    const html = await fetch('/').then((r) => r.text());
    const clientId = /clientId="([a-z0-9]+)"/.exec(html)?.[1];
    const res = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST', headers: { 'Client-ID': clientId },
      body: JSON.stringify({ query: '{ streams(first: 1) { edges { node { broadcaster { login } } } } }' }),
    }).then((r) => r.json());
    return res.data.streams.edges[0].node.broadcaster.login;
  });
}

await page.goto(`https://www.twitch.tv/${channel}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(WAIT_MS);
// Move over the video so Twitch draws the player controls (seek bar, latency chip, screenshot button).
const videoBox = await (await page.$('video'))?.boundingBox();
if (videoBox) {
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(videoBox.x + videoBox.width * (0.3 + i * 0.08), videoBox.y + videoBox.height * 0.6, { steps: 4 });
    await page.waitForTimeout(150);
  }
}

if (args['open-viewer-card']) {
  const name = page.locator('[data-a-target="chat-message-username"]').first();
  await name.click({ timeout: 10_000 }).catch((e) => problems.push(`test: could not open a viewer card: ${e.message}`));
  // Viewer logs builds its panel on the first click of Chat Logs.
  if (settings.viewerLogs) {
    await page.locator('.enhancer-chatlogs-toggle-button').click({ timeout: 10_000 })
      .catch((e) => problems.push(`test: no Chat Logs button: ${e.message}`));
  }
  await page.waitForTimeout(8000);
}

const report = await page.evaluate(() => {
  const safe = (f) => { try { return f(); } catch (e) { return `error: ${e.message}`; } };
  const q = window.__twitchPreferredQualityReport?.();
  return {
    status: window.__twitchPlus?.status,
    rewind: safe(() => { const r = window.__twitchRewindReport?.(); return r && { state: r.patch.state, matched: r.patch.matched, executed: r.patch.executed, calls: r.patch.calls, lastEligibility: r.patch.lastEligibility, bridge: r.bridge, lastEvents: r.events.slice(-4) }; }),
    // Sliders in the player: volume always; Rewind's DVR seek bar too when it is working.
    playerSliders: [...document.querySelectorAll('[data-a-target="video-player"] [role="slider"], [data-a-target="video-player"] input[type="range"]')]
      .map((e) => e.getAttribute('aria-label') || e.getAttribute('data-a-target') || e.className.toString().slice(0, 40)),
    quality: q && { state: q.state, matched: q.matched, viewport: q.viewport, ceiling: q.activePlayers?.map((p) => p.ceiling?.name).filter(Boolean),
      current: q.activePlayers?.map((p) => p.current?.name).filter(Boolean),
      playerSize: safe(() => { const v = document.querySelector('video'); return `${v.clientWidth}x${v.clientHeight}`; }) },
    latency: safe(() => window.__twitchNativeLatencyReport?.()),
    screenshot: safe(() => window.__twitchNativeScreenshotReport?.()),
    pins: safe(() => window.__twitchNativePinsReport?.()),
    hoverPause: window.__twitchChatHoverPause?.state,
    linkCards: window.__twitchChatLinkCards && { ...window.__twitchChatLinkCards, cardsShown: document.querySelectorAll('[data-link-card-shape]').length, testLine: [...document.querySelectorAll('.chat-line__message')].some((e) => e.textContent.includes('link card test')), fake: window.__twitchPlusFakeLink },
    viewerLogs: {
      viewerCard: !!document.querySelector('[data-a-target="viewer-card"], .viewer-card'),
      toolbar: document.querySelectorAll('.chatlogs-toolbar').length,
      messages: document.querySelectorAll('.chatlogs-message').length,
      loading: document.querySelectorAll('.chatlogs-loading').length,
      badges: document.querySelectorAll('.chatlogs-badge').length,
      emotes: document.querySelectorAll('.chatlogs-emote').length,
      status: document.querySelector('.chatlogs-status')?.textContent,
      accountCreated: document.querySelector('.enhancer-account-created')?.textContent?.trim(),
    },
    adBlock: { vaftVersion: window.twitchAdSolutionsVersion, supportApi: typeof window.vaftSupport, workerHooked: !/\[native code\]/.test(String(window.Worker)) },
    videoPlaying: !!document.querySelector('video') && !document.querySelector('video').paused,
  };
});

if (args.screenshot) await page.screenshot({ path: args.screenshot });
console.log(JSON.stringify({ channel, ...report, problems }, null, 2));
await browser.close();
const failed = args['no-inject'] ? false : Object.values(report.status ?? {}).includes('error') || problems.length > 0 || !report.status;
process.exit(failed ? 1 : 0);
