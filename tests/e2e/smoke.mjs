// Live smoke test: opens a live Twitch channel in your installed Chrome with the built page script injected
// before Twitch's own scripts (as the extension's content script is), then prints what each feature reports.
//
//   npm run build && npm run test:e2e                    # a live channel from Twitch's front page list
//   npm run test:e2e -- --channel=somechannel            # a given channel
//   npm run test:e2e -- --settings='{"quality.ceiling":"720"}'
//   npm run test:e2e -- --headed                         # watch it
//   npm run test:e2e -- --no-inject                      # baseline: plain Twitch, to tell its own errors apart
//   npm run test:e2e -- --screenshot=shot.png            # save what the page looks like at the end
//
// It needs network access to twitch.tv and runs signed out, in a throwaway profile.
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

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
  if (location.hostname !== 'www.twitch.tv') return;
  localStorage.setItem('twitchPlus.settings', JSON.stringify(settings));
  localStorage.setItem('twitchNativeRewind.debug', '1');
}, { settings });
// Like the manifest (www.twitch.tv only, top frame only); init scripts otherwise run in every frame.
if (!args['no-inject']) await page.addInitScript({ content: `if (window === window.top && location.hostname === 'www.twitch.tv') {
${payload}
}` });

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

const report = await page.evaluate(() => {
  const safe = (f) => { try { return f(); } catch (e) { return `error: ${e.message}`; } };
  const q = window.__twitchPreferredQualityReport?.();
  return {
    status: window.__twitchPlus?.status,
    rewind: safe(() => { const r = window.__twitchRewindReport?.(); return r && { state: r.patch.state, matched: r.patch.matched, executed: r.patch.executed, calls: r.patch.calls, lastEligibility: r.patch.lastEligibility, bridge: r.bridge, lastEvents: r.events.slice(-4) }; }),
    // Sliders in the player: volume always; Rewind's DVR seek bar too when it is working.
    playerSliders: [...document.querySelectorAll('[data-a-target="video-player"] [role="slider"], [data-a-target="video-player"] input[type="range"]')]
      .map((e) => e.getAttribute('aria-label') || e.getAttribute('data-a-target') || e.className.toString().slice(0, 40)),
    quality: q && { state: q.state, matched: q.matched, ceiling: q.activePlayers?.map((p) => p.ceiling?.name).filter(Boolean) },
    latency: safe(() => window.__twitchNativeLatencyReport?.()),
    screenshot: safe(() => window.__twitchNativeScreenshotReport?.()),
    pins: safe(() => window.__twitchNativePinsReport?.()),
    hoverPause: window.__twitchChatHoverPause?.state,
    videoPlaying: !!document.querySelector('video') && !document.querySelector('video').paused,
  };
});

if (args.screenshot) await page.screenshot({ path: args.screenshot });
console.log(JSON.stringify({ channel, ...report, problems }, null, 2));
await browser.close();
const failed = args['no-inject'] ? false : Object.values(report.status ?? {}).includes('error') || problems.length > 0 || !report.status;
process.exit(failed ? 1 : 0);
