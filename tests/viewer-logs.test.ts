import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  badgeTitle, channelFromPath, concernsUser, formatDuration, monthsOf, parseIrcLine, splitMessage,
} from '../lib/modules/viewer-logs-parse';
import { cache, emotesFor, watchChat } from '../lib/modules/viewer-logs-sources';

const LINE = '@badge-info=subscriber/14;badges=subscriber/12,premium/1;color=#1E90FF;display-name=Some_One;' +
  'emotes=25:6-10;first-msg=0;id=abc-123;reply-parent-display-name=Other;reply-parent-msg-body=hi\\sthere;' +
  'tmi-sent-ts=1793134171840 :some_one!some_one@some_one.tmi.twitch.tv PRIVMSG #chan :hello Kappa :)';

describe('channel from the page path', () => {
  it('reads channel pages, popout and moderator chat', () => {
    expect(channelFromPath('/xQc')).toBe('xqc');
    expect(channelFromPath('/xqc/videos')).toBe('xqc');
    expect(channelFromPath('/popout/xqc/chat')).toBe('xqc');
    expect(channelFromPath('/moderator/xqc')).toBe('xqc');
  });

  it('refuses Twitch pages and names that cannot be logins', () => {
    for (const path of ['/', '/directory/all', '/videos/123', '/settings/profile', '/robots.txt', '/popout']) {
      expect(channelFromPath(path)).toBeNull();
    }
  });
});

describe('IRC lines', () => {
  it('parses a message with its tags', () => {
    const message = parseIrcLine(LINE)!;
    expect(message).toMatchObject({
      id: 'abc-123', login: 'some_one', name: 'Some_One', text: 'hello Kappa :)', time: 1793134171840,
      color: '#1E90FF', badges: 'subscriber/12,premium/1', badgeInfo: 'subscriber/14', emotes: '25:6-10',
      action: false, firstMessage: false, reply: { name: 'Other', text: 'hi there' },
    });
  });

  it('unwraps /me actions', () => {
    const message = parseIrcLine(':a!a@a.tmi.twitch.tv PRIVMSG #chan :\x01ACTION waves\x01')!;
    expect(message.text).toBe('waves');
    expect(message.action).toBe(true);
  });

  it('turns timeouts and bans of one user into notices, and ignores other commands', () => {
    expect(parseIrcLine('@ban-duration=600;tmi-sent-ts=5 :tmi.twitch.tv CLEARCHAT #chan :bad_guy')).toMatchObject({
      login: 'bad_guy', text: 'was timed out for 10m.', moderation: true, time: 5,
    });
    expect(parseIrcLine('@tmi-sent-ts=5 :tmi.twitch.tv CLEARCHAT #chan :bad_guy')?.text).toBe('was banned.');
    expect(parseIrcLine('@tmi-sent-ts=5 :tmi.twitch.tv CLEARCHAT #chan')).toBeNull();
    expect(parseIrcLine('@emote-only=0 :tmi.twitch.tv ROOMSTATE #chan')).toBeNull();
    expect(parseIrcLine('PING :tmi.twitch.tv')).toBeNull();
  });

  it('picks out lines about one user before parsing', () => {
    expect(concernsUser(LINE, 'some_one')).toBe(true);
    expect(concernsUser(LINE, 'some')).toBe(false);
    expect(concernsUser('@x=1 :tmi.twitch.tv CLEARCHAT #chan :some_one', 'some_one')).toBe(true);
    // Named in someone else's message: not theirs.
    expect(concernsUser(':other!other@other.tmi.twitch.tv PRIVMSG #chan :ask some_one', 'some_one')).toBe(false);
  });
});

describe('message parts', () => {
  const lookup = (name: string) => (name === 'OMEGALUL' ? { url: 'https://cdn/omega', provider: '7TV' } : undefined);

  it('places Twitch emotes by code point, matches third-party emotes by name and links links', () => {
    // The emoji is two UTF-16 units but one code point; Twitch counts code points.
    const parts = splitMessage('😀 Kappa OMEGALUL see (example.com).', '25:2-6', lookup);
    const kappa = 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/';
    expect(parts).toEqual([
      { kind: 'text', text: '😀 ' },
      { kind: 'emote', name: 'Kappa', emote: { url: `${kappa}1.0`, srcset: `${kappa}1.0 1x, ${kappa}2.0 2x, ${kappa}3.0 4x`, provider: 'PLATFORM', id: '25' } },
      { kind: 'text', text: ' ' },
      { kind: 'emote', name: 'OMEGALUL', emote: { url: 'https://cdn/omega', provider: '7TV' } },
      { kind: 'text', text: ' see (' },
      { kind: 'link', text: 'example.com', href: 'https://example.com' },
      { kind: 'text', text: ').' },
    ]);
  });

  it('sees an emote through the invisible character used to repeat messages', () => {
    expect(splitMessage('OMEGALUL \u{E0000}', '', lookup)[0]).toMatchObject({ kind: 'emote', name: 'OMEGALUL' });
    expect(splitMessage('OMEGALUL​', '', lookup)[0]).toMatchObject({ kind: 'emote', name: 'OMEGALUL' });
  });

  it('leaves emails and plain words as text', () => {
    expect(splitMessage('mail me@x.com ok', '', () => undefined)).toEqual([{ kind: 'text', text: 'mail me@x.com ok' }]);
  });
});

describe('small formats', () => {
  it('formats durations, badge titles and archive months', () => {
    expect(formatDuration(600)).toBe('10m');
    expect(formatDuration(90061)).toBe('1d 1h');
    expect(badgeTitle('subscriber', '1-Year Subscriber', 'subscriber/14')).toBe('1-Year Subscriber (14 months)');
    expect(badgeTitle('subscriber', 'Subscriber', 'subscriber/1')).toBe('Subscriber (1 month)');
    expect(badgeTitle('vip', 'VIP', 'subscriber/14')).toBe('VIP');
    expect(monthsOf([{ year: '2026', month: '10' }, { year: '2026', month: '10' }, { year: '2026', month: '9' }]))
      .toEqual([{ year: 2026, month: 10 }, { year: 2026, month: 9 }]);
  });
});

describe('cache', () => {
  it('shares one request between callers and forgets failures', async () => {
    const store = cache<number>(60_000);
    const load = vi.fn(async () => 1);
    await Promise.all([store.get('a', load), store.get('a', load)]);
    expect(load).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => { throw new Error('down'); });
    await expect(store.get('b', failing)).rejects.toThrow('down');
    await expect(store.get('b', failing)).rejects.toThrow('down');
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('drops the oldest key past its size', async () => {
    const store = cache<string>(60_000, 2);
    const load = vi.fn(async () => 'x');
    for (const key of ['a', 'b', 'c', 'a']) await store.get(key, load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});

describe('emotes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads every provider with ids, sets and image sizes, the channel's own winning a clash", async () => {
    const answers: Record<string, unknown> = {
      'https://gql.twitch.tv/gql': { data: { user: { id: '42', createdAt: null } } },
      'https://api.frankerfacez.com/v1/set/global': { default_sets: [3], sets: { 3: { id: 3, title: 'Global Emotes', emoticons: [{ id: 9, name: 'ZreknarF', urls: { 1: '//cdn.ffz/9/1', 2: '//cdn.ffz/9/2' } }] }, 4: { id: 4, emoticons: [{ id: 1, name: 'NotDefault', urls: { 1: '//x' } }] } } },
      'https://api.frankerfacez.com/v1/room/id/42': { sets: {} },
      'https://api.betterttv.net/3/cached/emotes/global': [{ id: 'b1', code: 'Clap' }],
      'https://api.betterttv.net/3/cached/users/twitch/42': { channelEmotes: [], sharedEmotes: [{ id: 'b2', code: 'Wave' }] },
      'https://7tv.io/v3/emote-sets/global': { id: 'g', name: 'Global Emotes', emotes: [{ id: 's1', name: 'Clap' }] },
      'https://7tv.io/v3/users/twitch/42': { emote_set: { id: 'c', name: "chan's Emotes", emotes: [{ id: 's2', name: 'Wave' }] } },
    };
    vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(answers[url] ?? null), { status: url in answers ? 200 : 404 }));
    const emotes = await emotesFor('emotetest');
    expect([...emotes.keys()].sort()).toEqual(['Clap', 'Wave', 'ZreknarF']);
    expect(emotes.get('ZreknarF')).toEqual({
      url: 'https://cdn.ffz/9/1', srcset: 'https://cdn.ffz/9/1 1x, https://cdn.ffz/9/2 2x', provider: 'FFZ', id: '9',
      set: { name: 'Global Emotes', id: '3', global: true },
    });
    // 7TV's global Clap beats BTTV's; 7TV's channel Wave beats BTTV's shared one.
    expect(emotes.get('Clap')).toMatchObject({ provider: '7TV', id: 's1', set: { name: 'Global Emotes', id: 'g', global: true } });
    expect(emotes.get('Wave')).toMatchObject({ provider: '7TV', id: 's2', set: { name: "chan's Emotes", global: false } });
    expect(emotes.get('Wave')?.srcset).toBe(['1x', '2x', '3x', '4x'].map((d) => `https://cdn.7tv.app/emote/s2/${d}.webp ${d}`).join(', '));
  });
});

describe('live chat connection', () => {
  afterEach(() => vi.unstubAllGlobals());

  class FakeSocket extends EventTarget {
    static all: FakeSocket[] = [];
    sent: string[] = [];
    constructor(readonly url: string) { super(); FakeSocket.all.push(this); }
    send(line: string) { this.sent.push(line); }
    close() { setTimeout(() => this.dispatchEvent(new Event('close')), 0); }
    receive(data: string) { this.dispatchEvent(Object.assign(new Event('message'), { data })); }
  }

  it('hands each watcher only its viewer\'s lines and answers PING', () => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    const got: string[] = [];
    const states: string[] = [];
    const stop = watchChat('chan', 'some_one', (m) => got.push(m.text), (s) => states.push(s));
    const socket = FakeSocket.all[0]!;
    socket.receive(`PING :tmi.twitch.tv\r\n@x=1 :tmi.twitch.tv ROOMSTATE #chan\r\n${LINE}\r\n:other!other@other.tmi.twitch.tv PRIVMSG #chan :no\r\n`);
    expect(socket.sent).toContain('PONG :tmi.twitch.tv');
    expect(states).toEqual(['connecting', 'live']);
    expect(got).toEqual(['hello Kappa :)']);
    stop();
  });

  it('keeps a new connection when the old one finishes closing late', async () => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    const noop = () => {};
    watchChat('race', 'a', noop, noop)();
    // A panel reopens on the same channel before the first socket's close event arrives.
    const stop = watchChat('race', 'a', noop, noop);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A third watcher joins the open connection instead of opening another.
    const stopThird = watchChat('race', 'b', noop, noop);
    expect(FakeSocket.all.length).toBe(2);
    stop();
    stopThird();
  });
});
