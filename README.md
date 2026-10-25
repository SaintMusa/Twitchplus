# Twitch Plus

A browser extension (Chrome and Firefox) that adds features to Twitch which look and behave like Twitch's own.
Each feature can be turned on or off, by section, in the extension's popup.

| Section | Feature | Status |
|---|---|---|
| Player | Live rewind seek bar | Coming soon |
| Player | Preferred quality | Coming soon |
| Player | Live delay on the LIVE badge | Coming soon |
| Player | Screenshot button | Coming soon |
| Chat | Chat and search hotkeys (`/` and `?`) | Ready |
| Chat | Keep chat paused while hovering | Coming soon |
| Chat | Link preview cards | Coming soon |
| Chat | Chat logs on viewer cards | Coming soon |
| Sidebar | Pins and folders | Coming soon |
| Ads | Block ads | Coming soon |

## Install from source

Needs Node 22 or later.

```bash
npm install
npm run build            # Chrome: load .output/chrome-mv3 via chrome://extensions > Load unpacked
npm run build:firefox    # Firefox 128+: load .output/firefox-mv3/manifest.json via about:debugging
```

`npm run dev` opens a browser with the extension loaded and reloads it on every change.

## How it is built

- `lib/features.ts` lists every feature by section. The popup, the defaults and the loader are generated from it.
- `lib/modules/` holds one file per feature. A module runs in Twitch's page context at document start, before
  Twitch's own scripts, and only when its feature is on.
- Settings are saved in `storage.sync` by the popup. `entrypoints/bridge.content.ts` copies them into twitch.tv's
  `localStorage` (`twitchPlus.settings`), because page-context code can't wait for async extension storage.
- Each module starts inside its own `try/catch`. `__twitchPlus.status` in the console shows which features are on.

### Adding a feature

1. Add it to `lib/features.ts` with `ready: false` while you work on it.
2. Write `lib/modules/<name>.ts`, which exports a function that takes the feature's options.
3. Register it in `lib/modules.ts` and set `ready: true`. `npm test` checks that the two match.

## Checks

```bash
npm run compile   # type-check
npm test          # unit tests
```

## Privacy

The extension has no server of its own. Features that contact a third-party service say so in the popup and are
off by default.

## Licence

MIT, see [LICENSE](LICENSE). The ad-blocking feature will include vaft from
[pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) (MIT); its notice will ship with it.
