import { defineConfig } from 'wxt';

export default defineConfig({
  // Every icon size is generated from this one file; replace it to change the logo.
  modules: ['@wxt-dev/auto-icons'],
  autoIcons: { baseIconPath: 'assets/icon.svg' },
  manifest: ({ browser }) => ({
    name: 'Twitch Plus',
    description: "Extra features for Twitch that look and behave like Twitch's own, each one switchable.",
    permissions: ['storage'],
    // Lets the popup find open Twitch tabs to reload after a settings change.
    host_permissions: ['https://www.twitch.tv/*'],
    // Firefox 128 is the first with page-context ("MAIN" world) content scripts.
    ...(browser === 'firefox' && {
      browser_specific_settings: { gecko: { id: 'twitch-plus@local', strict_min_version: '128.0' } },
    }),
  }),
});
