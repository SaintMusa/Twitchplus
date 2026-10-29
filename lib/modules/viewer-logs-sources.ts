// Where viewer logs (lib/modules/viewer-logs.ts) gets its data, each source fetched once and cached:
// - logs.zonian.dev: which months have archived lines for a viewer, and a month's lines
// - gql.twitch.tv, anonymous: badges, channel ids and account ages (one query instead of Helix + api.ivr.fi)
// - 7TV, BTTV, FFZ: emotes, global sets once, channel sets per channel
// - irc-ws.chat.twitch.tv, anonymous: live lines, one connection per channel shared by open panels
// Every host answers cross-origin requests from www.twitch.tv, so the page fetches directly (lib/relay.ts is for
// sites that do not).
import { concernsUser, messageFromTags, parseIrcLine, type ChatMessage, type Day, type Emote } from './viewer-logs-parse';

/** Keeps each key's result for `ttl` ms; concurrent callers share one request, failures are not kept. */
export function cache<T>(ttl: number, max = 50) {
  const entries = new Map<string, { value: Promise<T>; expires: number }>();
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && hit.expires > Date.now()) return hit.value;
      const value = load();
      entries.delete(key);
      entries.set(key, { value, expires: Date.now() + ttl });
      value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
      // Maps keep insertion order, so the first key is the oldest.
      if (entries.size > max) entries.delete(entries.keys().next().value!);
      return value;
    },
    forget(key: string) { entries.delete(key); },
  };
}

class HttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

/** JSON from `url`; null for 404. Network errors, 429 and 5xx are retried twice; other errors are final. */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.status === 404) return null;
      if (!response.ok) throw new HttpError(response.status);
      return await response.json() as T;
    } catch (error) {
      const retry = !(error instanceof HttpError) || error.status === 429 || error.status >= 500;
      if (!retry || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }
}

// Twitch's public web client id; without a login token these queries run anonymously.
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

async function gql<T>(query: string, variables: Record<string, string> = {}): Promise<T> {
  // Headers as a plain object: ad blocking's fetch wrapper reads gql requests' headers by key.
  const result = await fetchJson<{ data?: T; errors?: { message: string }[] }>('https://gql.twitch.tv/gql', {
    method: 'POST', headers: { 'Client-ID': CLIENT_ID }, body: JSON.stringify({ query, variables }),
  });
  if (!result?.data) throw new Error(result?.errors?.[0]?.message ?? 'No data');
  return result.data;
}

export interface UserInfo { id: string; createdAt: Date | null }

const users = cache<UserInfo | null>(60 * 60_000, 200);

/** A Twitch account's id and creation date; null when there is no such account. */
export function userInfo(login: string): Promise<UserInfo | null> {
  return users.get(login, async () => {
    const { user } = await gql<{ user: { id: string; createdAt: string } | null }>(
      'query($login: String!) { user(login: $login) { id createdAt } }', { login });
    return user && { id: user.id, createdAt: user.createdAt ? new Date(user.createdAt) : null };
  });
}

export interface Badge { url: string; title: string; setID: string }
/** Keyed "set/version", like the IRC badges tag. */
export type Badges = Map<string, Badge>;

interface GqlBadge { setID: string; version: string; title: string; imageURL: string }
const BADGE_FIELDS = 'setID version title imageURL(size: NORMAL)';
const badgeSets = cache<GqlBadge[]>(6 * 60 * 60_000, 30);

/** Global badges with the channel's own (subscriber months, bits) on top. */
export async function badgesFor(channel: string): Promise<Badges> {
  const [global, own] = await Promise.all([
    badgeSets.get('', async () => (await gql<{ badges: GqlBadge[] }>(`{ badges { ${BADGE_FIELDS} } }`)).badges ?? []),
    badgeSets.get(channel, async () => (await gql<{ user: { broadcastBadges: GqlBadge[] } | null }>(
      `query($login: String!) { user(login: $login) { broadcastBadges { ${BADGE_FIELDS} } } }`, { login: channel },
    )).user?.broadcastBadges ?? []),
  ]);
  const badges: Badges = new Map();
  for (const badge of [...global, ...own]) {
    badges.set(`${badge.setID}/${badge.version}`, { url: badge.imageURL, title: badge.title, setID: badge.setID });
  }
  return badges;
}

const ZONIAN = 'https://logs.zonian.dev';
const path = (...parts: string[]) => parts.map(encodeURIComponent).join('/');
const availability = cache<Day[] | null>(60_000, 100);
const months = cache<ChatMessage[]>(10 * 60_000, 100);

/** Days with archived lines for the viewer in the channel, newest first; null when the archive has none. */
export function loggedDays(channel: string, login: string, fresh = false): Promise<Day[] | null> {
  const key = `${channel}/${login}`;
  if (fresh) availability.forget(key);
  return availability.get(key, async () => {
    const data = await fetchJson<{ available?: { user?: boolean }; loggedData?: { list?: Day[] } }>(`${ZONIAN}/api/${path(channel, login)}`);
    return data?.available?.user ? data.loggedData?.list ?? [] : null;
  });
}

interface ArchivedLine { raw?: string; text?: string; username?: string; timestamp?: string; tags?: Record<string, string> }

/** The newest 50 archived lines of a month, oldest first. */
export function loggedMonth(channel: string, login: string, year: number, month: number, fresh = false): Promise<ChatMessage[]> {
  const key = `${channel}/${login}/${year}/${month}`;
  if (fresh) months.forget(key);
  return months.get(key, async () => {
    const data = await fetchJson<{ messages?: ArchivedLine[] }>(
      `${ZONIAN}/channel/${path(channel)}/user/${path(login)}/${year}/${month}?json&reverse=true&limit=50`);
    const lines: ChatMessage[] = [];
    for (const line of (data?.messages ?? []).reverse()) {
      const message = line.raw ? parseIrcLine(line.raw)
        : line.text && line.timestamp ? messageFromTags(line.tags ?? {}, line.username ?? login, line.text, Date.parse(line.timestamp))
        : null;
      if (message) lines.push(message);
    }
    return lines;
  });
}

type EmoteList = [name: string, emote: Emote][];

interface Provider {
  global: string;
  channel: (id: string) => string;
  parse: (data: any, global: boolean) => EmoteList;
}

// Image sizes as each CDN names them, with the density each one is for.
const sizes = (url: (size: string) => string, list: [string, string][]) => list.map(([size, density]) => `${url(size)} ${density}`).join(', ');

type FfzSet = { id: number; title?: string; emoticons?: { id: number; name: string; urls: Record<string, string> }[] };
const ffz = (sets: Record<string, FfzSet> = {}, global: boolean, only?: number[]): EmoteList =>
  Object.values(sets)
    .filter((set) => !only || only.includes(set.id))
    .flatMap((set) => (set.emoticons ?? []).map((emote): [string, Emote] => {
      const https = (url: string) => (url.startsWith('//') ? `https:${url}` : url);
      const urls = Object.entries(emote.urls).map(([scale, url]): [string, string] => [https(url), `${scale}x`]);
      return [emote.name, {
        url: urls[0]?.[0] ?? '', srcset: urls.map(([url, density]) => `${url} ${density}`).join(', '),
        provider: 'FFZ', id: String(emote.id), set: { name: set.title ?? 'FFZ', id: String(set.id), global },
      }];
    }));

const bttv = (emotes: { id: string; code: string }[] = [], global: boolean): EmoteList => emotes.map((emote) => {
  const url = (size: string) => `https://cdn.betterttv.net/emote/${emote.id}/${size}`;
  return [emote.code, {
    url: url('1x'), srcset: sizes(url, [['1x', '1x'], ['2x', '2x'], ['3x', '4x']]),
    provider: 'BTTV', id: emote.id, set: { name: global ? 'Global Emotes' : 'Channel Emotes', global },
  }];
});

type SeventvSet = { id?: string; name?: string; emotes?: { id: string; name: string }[] };
const seventv = (set: SeventvSet | undefined, global: boolean): EmoteList => (set?.emotes ?? []).map((emote) => {
  const url = (size: string) => `https://cdn.7tv.app/emote/${emote.id}/${size}.webp`;
  return [emote.name, {
    url: url('1x'), srcset: sizes(url, [['1x', '1x'], ['2x', '2x'], ['3x', '3x'], ['4x', '4x']]),
    provider: '7TV', id: emote.id, set: { name: set?.name ?? '7TV', id: set?.id, global },
  }];
});

// Later providers win a name clash, as in 7TV's own chat: FFZ, then BTTV, then 7TV.
const PROVIDERS: Provider[] = [
  {
    global: 'https://api.frankerfacez.com/v1/set/global', channel: (id) => `https://api.frankerfacez.com/v1/room/id/${id}`,
    parse: (data, global) => ffz(data?.sets, global, global ? data?.default_sets : undefined),
  },
  {
    global: 'https://api.betterttv.net/3/cached/emotes/global', channel: (id) => `https://api.betterttv.net/3/cached/users/twitch/${id}`,
    parse: (data, global) => (global ? bttv(data, true) : [...bttv(data?.channelEmotes, false), ...bttv(data?.sharedEmotes, false)]),
  },
  {
    global: 'https://7tv.io/v3/emote-sets/global', channel: (id) => `https://7tv.io/v3/users/twitch/${id}`,
    parse: (data, global) => seventv(global ? data : data?.emote_set, global),
  },
];

const emoteSets = cache<EmoteList>(30 * 60_000, 60);

async function emoteSet(provider: Provider, global: boolean, url: string): Promise<EmoteList> {
  return emoteSets.get(url, async () => {
    try {
      return provider.parse(await fetchJson(url), global);
    } catch {
      // One provider being down should not cost the others; try it again next time.
      emoteSets.forget(url);
      return [];
    }
  });
}

/** Name → emote for the channel: global sets first, then the channel's own, so a channel's emote wins. */
export async function emotesFor(channel: string): Promise<Map<string, Emote>> {
  const id = (await userInfo(channel))?.id;
  const sets = await Promise.all([
    ...PROVIDERS.map((provider) => emoteSet(provider, true, provider.global)),
    ...(id ? PROVIDERS.map((provider) => emoteSet(provider, false, provider.channel(id))) : []),
  ]);
  return new Map(sets.flat());
}

export type LiveState = 'connecting' | 'live' | 'disconnected';

interface Watcher { login: string; onMessage: (message: ChatMessage) => void; onState: (state: LiveState) => void }

interface Feed { socket: WebSocket | null; watchers: Set<Watcher>; state: LiveState; failures: number; timer?: ReturnType<typeof setTimeout> }

const feeds = new Map<string, Feed>();

/**
 * Calls `onMessage` for each live line from `login` in `channel`'s chat. Panels on the same channel share one
 * anonymous connection, which reconnects when Twitch drops it and closes when the last panel stops watching.
 */
export function watchChat(channel: string, login: string, onMessage: Watcher['onMessage'], onState: Watcher['onState']): () => void {
  let feed = feeds.get(channel);
  if (!feed) {
    feed = { socket: null, watchers: new Set(), state: 'connecting', failures: 0 };
    feeds.set(channel, feed);
    connect(channel, feed);
  }
  const watcher: Watcher = { login, onMessage, onState };
  feed.watchers.add(watcher);
  onState(feed.state);
  const own = feed;
  return () => {
    own.watchers.delete(watcher);
    if (own.watchers.size) return;
    clearTimeout(own.timer);
    // Cleared first, so the close event below does not reconnect.
    const socket = own.socket;
    own.socket = null;
    socket?.close();
    if (feeds.get(channel) === own) feeds.delete(channel);
  };
}

function setState(feed: Feed, state: LiveState) {
  feed.state = state;
  for (const watcher of feed.watchers) watcher.onState(state);
}

function connect(channel: string, feed: Feed) {
  const socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  feed.socket = socket;
  setState(feed, 'connecting');
  socket.addEventListener('open', () => {
    socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    socket.send('PASS SCHMOOPIIE');
    socket.send(`NICK justinfan${Math.floor(Math.random() * 100_000)}`);
    socket.send(`JOIN #${channel}`);
  });
  socket.addEventListener('message', (event) => {
    for (const line of String(event.data).split('\r\n')) {
      if (!line) continue;
      // Server commands, matched at the start so a chat message quoting them does not count.
      const command = line.startsWith('@') ? line.slice(line.indexOf(' ') + 1) : line;
      if (command.startsWith('PING')) socket.send(command.replace('PING', 'PONG'));
      else if (command.startsWith(':tmi.twitch.tv RECONNECT')) socket.close();
      else if (command.startsWith(':tmi.twitch.tv ROOMSTATE')) {
        feed.failures = 0;
        setState(feed, 'live');
      } else {
        for (const watcher of feed.watchers) {
          if (!concernsUser(line, watcher.login)) continue;
          const message = parseIrcLine(line);
          if (message) watcher.onMessage(message);
        }
      }
    }
  });
  socket.addEventListener('close', () => {
    if (feed.socket !== socket) return;
    feed.socket = null;
    feed.failures++;
    setState(feed, feed.failures > 5 ? 'disconnected' : 'connecting');
    feed.timer = setTimeout(() => { if (feed.watchers.size) connect(channel, feed); }, Math.min(30_000, 1000 * 2 ** feed.failures));
  });
}
