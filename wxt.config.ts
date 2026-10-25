import { defineConfig } from 'wxt';

export default defineConfig({
  // Every icon size is generated from this one file; replace it to change the logo.
  modules: ['@wxt-dev/auto-icons'],
  autoIcons: { baseIconPath: 'assets/icon.svg' },
  // Unminified on purpose: vaft (lib/modules/vaft-*.ts) builds the video worker's code from its own functions'
  // source text, which renamed identifiers would break. It also keeps the shipped code readable for review.
  vite: () => ({ build: { minify: false } }),
  manifest: ({ browser }) => ({
    name: 'Twitch Plus',
    description: "Extra features for Twitch that look and behave like Twitch's own, each one switchable.",
    permissions: ['storage'],
    // Lets the popup find open Twitch tabs to reload after a settings change.
    host_permissions: ['https://*.twitch.tv/*'],
    // Asked for only when Link cards is switched on: it fetches link previews from any site (lib/relay.ts).
    optional_host_permissions: ['https://*/*'],
    // Firefox 128 is the first with page-context ("MAIN" world) content scripts.
    ...(browser === 'firefox' && {
      browser_specific_settings: { gecko: { id: 'twitch-plus@local', strict_min_version: '128.0' } },
    }),
  }),
});
