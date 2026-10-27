# Twitch Plus

A browser extension (Chrome and Firefox) that adds features to Twitch which look and behave like Twitch's own.
Each feature can be turned on or off, by section, in the extension's popup.

This is a personal project, built for my own use and shared as it is. It is not affiliated with or endorsed by Twitch,
and I make no promises about support or updates. Issues and pull requests are welcome, but I may not get to them.

**AI disclosure:** this project was built with a lot of help from AI (Claude, by Anthropic). The AI wrote and edited
much of the code, and I directed it and tested the features myself. If that is a dealbreaker for you, now you know.

| Section | Feature |
|---|---|
| Player | Live rewind seek bar |
| Player | Preferred quality |
| Player | Live delay on the LIVE badge |
| Player | Screenshot button |
| Player | Watch sub-only VODs |
| Chat | Chat and search hotkeys (`/` and `?`) |
| Chat | Keep chat paused while hovering |
| Chat | Link preview cards (asks for access to all sites when switched on) |
| Chat | Chat logs on viewer cards |
| Sidebar | Pins and folders; offline channels sorted by when they last went live |
| Ads | Block ads (vaft, Support or Timer version) |

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

1. Add it to `lib/features.ts`.
2. Write `lib/modules/<name>.ts`, which exports a function that takes the feature's options.
3. Register it in `lib/modules.ts`. `npm test` checks that every feature has a module.

## Checks

```bash
npm run compile   # type-check
npm test          # unit tests
npm run build && npm run test:e2e   # live smoke test on twitch.tv in your installed Chrome
```

`test:e2e` opens a live channel signed out, with the built page script injected before Twitch's own scripts as the
extension does, and prints each feature's status. `--channel=name`, `--settings='{"quality.ceiling":"720"}'`,
`--headed`, `--screenshot=file.png` and `--no-inject` (plain Twitch, to tell its own errors apart) are options.

## Privacy

The extension has no server of its own. Features that contact a third-party service say so in the popup and are
off by default.

## Licence

MIT, see [LICENSE](LICENSE). Code taken from other projects keeps its own licence, listed below.

## Credits

Some features are built on other people's work, and this project would be missing them without it:

- **Block ads** is based on vaft from [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) (MIT),
  with credit to its contributors and to the projects it credits in turn. Its licence notice is kept in `lib/modules/vaft-*.ts`.
- **Watch sub-only VODs** is based on [besuper/TwitchNoSub](https://github.com/besuper/TwitchNoSub) (Apache-2.0).
  See the header of `lib/modules/sub-only-vods.ts` for the licence notice and what was changed.
- **Link preview cards** use [Chatterino](https://chatterino.com)'s public link resolver.
- **Chat logs on viewer cards** read from [logs.zonian.dev](https://logs.zonian.dev).

Twitch is a trademark of Twitch Interactive, Inc.
