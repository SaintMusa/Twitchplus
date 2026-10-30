# Twitch Plus

A browser extension for Chrome and Firefox that adds features to Twitch, made to look and feel like part of the site.
You can turn each feature on or off in the extension's popup.

This is a personal project, built for my own use and shared as it is. It is not affiliated with or endorsed by Twitch,
and I make no promises about support or updates. Issues and pull requests are welcome, but I may not get to them.

Built with a lot of help from AI (Claude).

## What it does

- **Player:** rewind live streams, hold your preferred quality, lower it in background tabs, see your stream delay,
  take screenshots and watch sub-only VODs.
- **Chat:** jump to chat with `/` and search with `?`, keep chat paused while your mouse is over it, preview links, and
  see a viewer's earlier messages on their card (Twitch's card, and 7TV's card when 7TV is installed).
- **Sidebar:** pin channels, sort them into folders, and see offline channels by when they last went live.
- **Ads:** block ads, with two versions to choose from.

Link previews and chat logs stay off until you turn them on, because they use outside services. Link previews also ask
for access to all sites when you switch them on.

## Install from source

You need [Node](https://nodejs.org) 22.12 or later, which is the tool that builds the extension.

```bash
npm install
npm run build            # Chrome: load .output/chrome-mv3 via chrome://extensions > Load unpacked
npm run build:firefox    # Firefox 128+: load .output/firefox-mv3/manifest.json via about:debugging
```

`npm run dev` opens a browser with the extension loaded and reloads it whenever the code changes.

## How it works

Each feature is one file in `lib/modules/`, and `lib/features.ts` lists them all. The popup and default settings are
built from that list.

Features run inside the Twitch page before Twitch's own code starts, which lets them change how the site behaves. They
need your settings straight away, so `entrypoints/bridge.content.ts` copies them into twitch.tv's `localStorage`, a
small store the page can read instantly. If one feature crashes, the others keep running. To see which features are on,
type `__twitchPlus.status` in the browser console.

To add a feature, list it in `lib/features.ts`, write `lib/modules/<name>.ts`, and register it in `lib/modules.ts`.
`npm test` checks that every listed feature has a module.

## Checks

```bash
npm run compile   # check the code for type errors
npm test          # run the unit tests
npm run build && npm run test:e2e   # try the build on live Twitch in your installed Chrome
```

The options for the live test are in `tests/e2e/smoke.mjs`.

## Privacy

The extension has no server of its own. Features that contact an outside service say so in the popup and are off by
default.

## Licence

MIT, see [LICENSE](LICENSE). Code taken from other projects keeps its own licence, listed below.

## Credits

Some features are built on other people's work:

- **Block ads** is based on vaft from [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) (MIT),
  with credit to its contributors and to the projects it credits in turn. Its licence notice is kept in `lib/modules/vaft-*.ts`.
- **Watch sub-only VODs** is based on [besuper/TwitchNoSub](https://github.com/besuper/TwitchNoSub) (Apache-2.0).
  See the header of `lib/modules/sub-only-vods.ts` for the licence notice and what was changed.
- **Link preview cards** use [Chatterino](https://chatterino.com)'s public link resolver.
- **Chat logs on viewer cards** read from [logs.zonian.dev](https://logs.zonian.dev).

Twitch is a trademark of Twitch Interactive, Inc.
