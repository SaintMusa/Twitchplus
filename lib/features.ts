// Every switchable feature, grouped into the sections the popup shows.
// The popup, the defaults and the page-side loader are all built from this list, so a new
// feature only needs an entry here and a module in lib/modules/, registered in lib/modules.ts.

export type Value = boolean | string;

export type Option =
  | { kind: 'toggle'; id: string; label: string; default: boolean }
  | { kind: 'select'; id: string; label: string; default: string; choices: { value: string; label: string }[] };

export interface Feature {
  /** Unique across all sections; also the storage key of the feature's own on/off value. */
  id: string;
  label: string;
  description: string;
  default: boolean;
  /** Also runs on other twitch.tv hosts (player.twitch.tv embeds) and in frames; others run on www, top frame only. */
  subdomains?: boolean;
  /** Optional host permissions the popup asks for when the feature is switched on (manifest: optional_host_permissions). */
  origins?: string[];
  options?: Option[];
}

export interface Section {
  id: string;
  label: string;
  features: Feature[];
}

export const SECTIONS: Section[] = [
  {
    id: 'player',
    label: 'Player',
    features: [
      {
        id: 'rewind',
        label: 'Live rewind seek bar',
        description: "Twitch's own seek bar on live streams, so you can scrub back.",
        default: true,
      },
      {
        id: 'quality',
        label: 'Preferred quality',
        description: 'Keeps Auto quality but aims for your ceiling, even in a small player. Auto still drops lower on a slow connection.',
        default: true,
        options: [
          {
            kind: 'select',
            id: 'ceiling',
            label: 'Highest quality',
            default: '1080',
            choices: [
              { value: 'source', label: 'Source' },
              { value: '1080', label: '1080p' },
              { value: '720', label: '720p' },
              { value: '480', label: '480p' },
            ],
          },
        ],
      },
      {
        id: 'latency',
        label: 'Live delay on the LIVE badge',
        description: 'Shows the stream delay next to LIVE. Click it to jump back to the live edge.',
        default: true,
      },
      {
        id: 'screenshot',
        label: 'Screenshot button',
        description: 'Saves the current frame as a PNG at the playback resolution.',
        default: true,
      },
      {
        id: 'subOnlyVods',
        label: 'Watch sub-only VODs',
        description: 'Plays subscriber-only VODs by rebuilding their playlist from the public storyboard link, and hides the lock on their cards. Based on TwitchNoSub (Apache-2.0).',
        default: true,
      },
    ],
  },
  {
    id: 'chat',
    label: 'Chat',
    features: [
      {
        id: 'chatHotkeys',
        label: 'Chat and search hotkeys',
        description: 'Escape leaves the box again, so player keys work.',
        default: true,
        options: [
          { kind: 'toggle', id: 'chatKey', label: '/ jumps into chat', default: true },
          { kind: 'toggle', id: 'searchKey', label: '? jumps into search', default: true },
        ],
      },
      {
        id: 'hoverPause',
        label: 'Keep chat paused while hovering',
        description: 'Chat stays paused as long as the mouse is over it, not just 5 seconds.',
        default: true,
      },
      {
        id: 'linkCards',
        label: 'Link preview cards',
        description: "Twitch's own chat card for links. Links in chat are sent to Chatterino's link resolver, and pages it can't read are fetched directly.",
        default: false,
        origins: ['https://*/*'],
        options: [{ kind: 'toggle', id: 'history', label: 'Also for chat history on join', default: false }],
      },
      {
        id: 'viewerLogs',
        label: 'Chat logs on viewer cards',
        description: "A viewer's earlier messages on their card, from logs.zonian.dev, plus live lines over Twitch chat.",
        default: false,
      },
    ],
  },
  {
    id: 'sidebar',
    label: 'Sidebar',
    features: [
      {
        id: 'pins',
        label: 'Pins and folders',
        description: "Pin followed channels and sort them into folders. Group by category is in Twitch's own Sort By menu.",
        default: true,
      },
    ],
  },
  {
    id: 'ads',
    label: 'Ads',
    features: [
      {
        id: 'adBlock',
        label: 'Block ads',
        description: 'Based on vaft from pixeltris/TwitchAdSolutions (MIT).',
        default: true,
        subdomains: true,
        options: [
          {
            kind: 'select',
            id: 'version',
            label: 'Version',
            default: 'support',
            choices: [
              // Support: per-channel switch in the player's Settings menu, AD alarm in the tab title, stream kept big.
              { value: 'support', label: 'Support' },
              // Timer: also hides client-side ads, fewer requests, ad countdown in the banner.
              { value: 'timer', label: 'Timer' },
            ],
          },
        ],
      },
    ],
  },
];

export const FEATURES: Feature[] = SECTIONS.flatMap((s) => s.features);

/** Storage key of a feature option: "<feature>.<option>". */
export const optionKey = (feature: string, option: string) => `${feature}.${option}`;
