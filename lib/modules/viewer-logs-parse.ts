// Pure helpers for viewer logs (lib/modules/viewer-logs.ts): chat lines, emote and link splitting, the channel in a
// URL. No DOM or network here, so the unit tests can run them directly.

export interface ChatMessage {
  /** Twitch's message id; archived and live copies of a line share it. */
  id: string;
  login: string;
  name: string;
  text: string;
  /** Milliseconds since the epoch. */
  time: number;
  color: string;
  /** IRC badges tag: "set/version,set/version". */
  badges: string;
  badgeInfo: string;
  /** IRC emotes tag: "id:start-end,start-end/id:start-end", positions in code points. */
  emotes: string;
  action: boolean;
  firstMessage: boolean;
  reply?: { name: string; text: string };
  /** A timeout or ban notice; `text` is the rest of the sentence after the name. */
  moderation?: boolean;
}

export type Tags = Record<string, string>;

const LOGIN = /^[a-z0-9_]{1,25}$/;
// First path segments that are Twitch pages, not channels.
const NOT_CHANNELS = new Set([
  'directory', 'settings', 'subscriptions', 'inventory', 'wallet', 'drops', 'search', 'videos', 'clips', 'schedule',
  'downloads', 'jobs', 'p', 'turbo', 'prime', 'store', 'friends', 'messages', 'payments', 'team', 'u', 'login',
  'signup', 'logout', 'broadcast', 'activate', 'bits', 'products', 'following', 'collections', 'event', 'annual-recap',
]);

/** The channel whose chat a page shows, from its path: /name, /name/videos, /popout/name/chat, /moderator/name. */
export function channelFromPath(path: string): string | null {
  const parts = path.split('/').filter(Boolean).map((part) => part.toLowerCase());
  const name = parts[0] === 'popout' || parts[0] === 'embed' || parts[0] === 'moderator' ? parts[1] : parts[0];
  if (!name || NOT_CHANNELS.has(parts[0]!) || !LOGIN.test(name)) return null;
  return name;
}

/** IRC tag values escape space, semicolon, backslash and line breaks. */
export function unescapeTag(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) => ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' })[c] ?? c);
}

/**
 * Cheap check before parsing: is this line a message from `login`, or a timeout or ban of them? A busy channel
 * sends many lines a second and almost none are about the viewer on the card.
 */
export function concernsUser(line: string, login: string): boolean {
  if (line.includes(` :${login}!`) && line.includes(' PRIVMSG #')) return true;
  return line.endsWith(` :${login}`) && line.includes(' CLEARCHAT #');
}

/** A PRIVMSG as a message, or a CLEARCHAT aimed at one user as a moderation notice; anything else is null. */
export function parseIrcLine(line: string): ChatMessage | null {
  let rest = line.trimEnd();
  const tags: Tags = {};
  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ');
    if (end < 0) return null;
    for (const pair of rest.slice(1, end).split(';')) {
      const eq = pair.indexOf('=');
      if (eq < 0) tags[pair] = '';
      else tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
    }
    rest = rest.slice(end + 1);
  }
  // ":prefix COMMAND #channel :trailing"
  const match = /^:(\S+) (PRIVMSG|CLEARCHAT) #\S+(?: :(.*))?$/.exec(rest);
  if (!match) return null;
  const [, prefix = '', command, trailing = ''] = match;
  const time = Number(tags['tmi-sent-ts']) || Date.now();
  if (command === 'CLEARCHAT') {
    const login = trailing.trim().toLowerCase();
    if (!login) return null;
    const seconds = Number(tags['ban-duration']);
    return {
      ...messageFromTags({}, login, '', time),
      id: `clearchat-${login}-${time}`,
      text: seconds > 0 ? `was timed out for ${formatDuration(seconds)}.` : 'was banned.',
      moderation: true,
    };
  }
  return messageFromTags(tags, prefix.split('!')[0] ?? '', trailing, time);
}

/** Builds a message from IRC tags; the archive's JSON carries the same tags. */
export function messageFromTags(tags: Tags, login: string, text: string, time: number): ChatMessage {
  let action = false;
  if (text.startsWith('\x01ACTION ') && text.endsWith('\x01')) {
    text = text.slice(8, -1);
    action = true;
  }
  const replyName = tags['reply-parent-display-name'];
  const replyText = tags['reply-parent-msg-body'];
  return {
    id: tags.id || `${login}-${time}-${text}`,
    login: login.toLowerCase(),
    name: tags['display-name'] || login,
    text: text.trim(),
    time,
    color: tags.color || '',
    badges: tags.badges || '',
    badgeInfo: tags['badge-info'] || '',
    emotes: tags.emotes || '',
    action,
    firstMessage: tags['first-msg'] === '1',
    reply: replyName && replyText ? { name: replyName, text: replyText } : undefined,
  };
}

/** "1d 2h", "10m", "45s": the two largest units. */
export function formatDuration(seconds: number): string {
  const parts: string[] = [];
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]] as const) {
    if (seconds < size) continue;
    parts.push(`${Math.floor(seconds / size)}${unit}`);
    seconds %= size;
    if (parts.length === 2) break;
  }
  return parts.join(' ') || `${seconds}s`;
}

/** "Subscriber (14 months)" from the badge-info tag; otherwise Twitch's own badge title. */
export function badgeTitle(setID: string, title: string, badgeInfo: string): string {
  const months = setID === 'subscriber' || setID === 'founder' ? /(?:^|,)(?:subscriber|founder)\/(\d+)/.exec(badgeInfo)?.[1] : null;
  return months ? `${title} (${months} month${months === '1' ? '' : 's'})` : title;
}

export interface Day { year: string | number; month: string | number }

/** The archive lists days newest first; logs are fetched a month at a time. */
export function monthsOf(days: Day[]): { year: number; month: number }[] {
  const seen = new Set<string>();
  const months: { year: number; month: number }[] = [];
  for (const day of days) {
    const key = `${day.year}-${day.month}`;
    if (seen.has(key)) continue;
    seen.add(key);
    months.push({ year: Number(day.year), month: Number(day.month) });
  }
  return months;
}

export interface Emote {
  url: string;
  /** Sharper images for high-density screens: "url 1x, url 2x, …". */
  srcset?: string;
  /** Named as 7TV names them: 7TV, BTTV, FFZ, or PLATFORM for Twitch's own. */
  provider: string;
  id?: string;
  /** The set it came from; 7TV's emote tooltip shows it. */
  set?: { name: string; id?: string; global: boolean };
}

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'emote'; name: string; emote: Emote }
  | { kind: 'link'; text: string; href: string };

// Zero-width and other invisible characters some chatters append to repeat a message past Twitch's duplicate check.
const INVISIBLE = /[​-‍︀-️­᠎⁠⁣͏\u{E0000}]/gu;
const LEADING_PUNCTUATION = /^[([{<"']+/;
const TRAILING_PUNCTUATION = /[)\]}>",.!?;:]+$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:[/?#]\S*)?$/i;

export function twitchEmote(id: string): Emote {
  const url = (size: string) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/${size}`;
  return { url: url('1.0'), srcset: `${url('1.0')} 1x, ${url('2.0')} 2x, ${url('3.0')} 4x`, provider: 'PLATFORM', id };
}

/**
 * Splits a message into text, emotes and links. Twitch emotes come from the emotes tag's exact positions; the
 * words between them are matched by name against 7TV/BTTV/FFZ emotes, and anything shaped like a link is linked.
 */
export function splitMessage(text: string, emotesTag: string, lookup: (name: string) => Emote | undefined): Part[] {
  const parts: Part[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last?.kind === 'text') last.text += value;
    else parts.push({ kind: 'text', text: value });
  };
  const words = (chunk: string) => {
    for (const word of chunk.split(/(\s+)/)) {
      if (!word) continue;
      const name = word.replace(INVISIBLE, '');
      const emote = name && !/^\s+$/.test(word) ? lookup(name) : undefined;
      if (emote) {
        parts.push({ kind: 'emote', name, emote });
        continue;
      }
      const leading = LEADING_PUNCTUATION.exec(word)?.[0] ?? '';
      const trailing = TRAILING_PUNCTUATION.exec(word.slice(leading.length))?.[0] ?? '';
      const core = word.slice(leading.length, word.length - trailing.length);
      if (!isLink(core)) {
        pushText(word);
        continue;
      }
      pushText(leading);
      parts.push({ kind: 'link', text: core, href: /^https?:\/\//i.test(core) ? core : `https://${core}` });
      pushText(trailing);
    }
  };

  const chars = [...text];
  let cursor = 0;
  for (const { id, start, end } of emotePositions(emotesTag)) {
    if (start < cursor || end >= chars.length) continue;
    words(chars.slice(cursor, start).join(''));
    const name = chars.slice(start, end + 1).join('');
    parts.push({ kind: 'emote', name, emote: twitchEmote(id) });
    cursor = end + 1;
  }
  words(chars.slice(cursor).join(''));
  return parts;
}

function emotePositions(tag: string): { id: string; start: number; end: number }[] {
  const positions: { id: string; start: number; end: number }[] = [];
  for (const entry of tag ? tag.split('/') : []) {
    const [id = '', ranges = ''] = entry.split(':');
    for (const range of ranges.split(',')) {
      const [start = NaN, end = NaN] = range.split('-').map(Number);
      if (id && Number.isInteger(start) && Number.isInteger(end)) positions.push({ id, start, end });
    }
  }
  return positions.sort((a, b) => a.start - b.start);
}

function isLink(text: string): boolean {
  if (/^(https?:\/\/|www\.)\S/i.test(text)) return true;
  return !text.includes('@') && DOMAIN.test(text);
}
