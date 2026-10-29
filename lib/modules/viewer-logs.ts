// Chat logs on viewer cards: a "Chat Logs" button on Twitch's viewer card opens the viewer's archived and live
// messages in this channel, and the card's header gains the account's creation date.
// Data comes from viewer-logs-sources.ts; parsing is in viewer-logs-parse.ts.
import type { Module } from '../modules';
import { listen, whenRoot } from '../page-observer';
import { badgeTitle, channelFromPath, monthsOf, splitMessage, type ChatMessage, type Emote } from './viewer-logs-parse';
import { badgesFor, emotesFor, loggedDays, loggedMonth, userInfo, watchChat, type Badges, type LiveState } from './viewer-logs-sources';

const PAGE = 10;
const MAX_LIVE_ROWS = 400;
const LOGIN = /^[a-z0-9_]{1,25}$/;
const CALENDAR_PATH = 'M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1ZM5 6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H5Zm2 5a1 1 0 0 1 1-1h8a1 1 0 1 1 0 2H8a1 1 0 0 1-1-1Zm1 3a1 1 0 1 0 0 2h5a1 1 0 1 0 0-2H8Z';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Panel { root: HTMLElement; pause(): void; resume(): void; close(): void }

interface Card {
  login: string;
  channel: string;
  /** The Chat Logs button's slot; copied from one of Twitch's buttons when the card has one. */
  slot: HTMLElement;
  copied: boolean;
  wrapper: HTMLElement;
  ageRow?: HTMLElement;
  createdAt?: Date | null;
  panel?: Panel;
  look: Look;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

const pad = (n: number) => String(n).padStart(2, '0');

function image(className: string, url: string, alt: string, title: string, fallback?: string) {
  const img = el('img', className);
  img.src = url;
  img.alt = alt;
  if (title) img.title = title;
  img.onerror = () => (fallback === undefined ? img.remove() : img.replaceWith(fallback));
  return img;
}

/**
 * An emote image. The data attributes are the ones 7TV writes on emotes in its own chat; with 7TV installed, its
 * emote tooltip reads them on either card.
 */
function emoteImage(name: string, emote: Emote, className: string, title: string) {
  const img = image(className, emote.url, name, title, name);
  if (emote.srcset) img.srcset = emote.srcset;
  Object.assign(img.dataset, {
    tooltipType: 'emote', provider: emote.provider, emoteName: name, fallbackName: name, fallbackImageUrl: emote.url,
    ...(emote.id && { emoteId: emote.id }),
    ...(emote.set && {
      setName: emote.set.name, fallbackSetName: emote.set.name, emoteScope: emote.set.global ? 'GLOBAL' : 'CHANNEL',
      ...(emote.set.id && { setId: emote.set.id }),
    }),
  });
  return img;
}

/** Message text with emotes and links; `emote` draws each emote in the card's own style. */
function messageText(target: HTMLElement, message: ChatMessage, emotes: Map<string, Emote> | undefined, emote: (name: string, emote: Emote) => Node) {
  for (const part of splitMessage(message.text, message.emotes, (word) => emotes?.get(word))) {
    if (part.kind === 'text') target.append(part.text);
    else if (part.kind === 'emote') target.append(emote(part.name, part.emote));
    else {
      const link = el('a', 'chatlogs-linkified', part.text);
      link.href = part.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      target.append(link);
    }
  }
}

/** How the panel draws its lines: like Twitch's moderator message log, or like the lines on 7TV's card. */
interface Look {
  row(message: ChatMessage, emotes?: Map<string, Emote>, badges?: Badges): HTMLElement;
  /** The heading text for a message's day; headings are compared by it. */
  day(time: number): string;
  heading(text: string, live?: boolean): HTMLElement;
  /** Classes for the boxes that hold archived and live lines. */
  group: string;
}

const TWITCH_LOOK: Look = {
  // One chat line in the layout of Twitch's own moderator message log (VCML).
  row(message, emotes, badges) {
    const row = el('div', 'vcml-message chatlogs-message');
    const time = new Date(message.time);
    const stamp = el('span', 'vcml-message__timestamp', `${pad(time.getHours())}:${pad(time.getMinutes())}`);
    if (message.moderation) {
      row.append(stamp, el('span', 'text-fragment chatlogs-notice', `${message.name} ${message.text}`));
      return row;
    }
    if (message.reply) row.append(el('div', 'chatlogs-reply-context', `↩ ${message.reply.name}: ${message.reply.text}`));
    const badgeBox = el('span', 'chatlogs-badges-container');
    for (const tag of message.badges ? message.badges.split(',') : []) {
      const badge = badges?.get(tag);
      if (badge) badgeBox.append(image('chatlogs-badge', badge.url, badge.setID, badgeTitle(badge.setID, badge.title, message.badgeInfo)));
    }
    const color = message.color || '#bf94ff';
    const name = el('span', 'message-author__display-name', message.name);
    name.style.color = color;
    const author = el('span', 'message-author__username');
    author.append(name);
    if (message.firstMessage) {
      const pill = el('span', 'chatlogs-first-msg', 'First');
      pill.title = 'First message in this channel';
      author.append(pill);
    }
    const text = el('span', 'text-fragment');
    text.dataset.aTarget = 'chat-message-text';
    if (message.action) {
      text.classList.add('chatlogs-action');
      text.style.color = color;
    }
    messageText(text, message, emotes, (name, emote) =>
      emoteImage(name, emote, 'chatlogs-emote', emote.provider === 'PLATFORM' ? name : `${name} (${emote.provider})`));
    row.append(stamp, badgeBox, author, message.action ? ' ' : ': ', text);
    return row;
  },
  day(time) {
    const date = new Date(time);
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
  },
  heading: (text, live) => el('div', live ? 'chatlogs-day chatlogs-date-separator chatlogs-live-separator' : 'chatlogs-day chatlogs-date-separator', text),
  group: '',
};

/**
 * Lines as 7TV draws them on its card: the same element classes, plus the card's Svelte scope class (Svelte adds
 * one per component to every element it styles), so 7TV's own stylesheet lays them out. Days and the live part
 * are labelled like the card's "LIVE" section.
 */
function sevenTvLook(scope: string): Look {
  const cls = (name: string) => `${name} ${scope}`.trim();
  const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return {
    row(message, emotes) {
      const row = el('div', `${cls('seventv-usercard-item')} seventv-usercard-item--message chatlogs-message`);
      const line = el('div', cls('seventv-usercard-item-line'));
      // 7TV's template leaves a space between the parts ("tokaschs : hi"); so do these.
      line.append(el('span', cls('seventv-usercard-item-time'), clock(message.time)), ' ');
      const clip = el('span', cls('seventv-usercard-item-message-clip'));
      const text = el('span', `${cls('seventv-usercard-item-text')} seventv-usercard-item-text--single-line`);
      clip.append(text);
      if (message.moderation) {
        text.classList.add('chatlogs-notice');
        text.textContent = `${message.name} ${message.text}`;
        line.append(clip);
      } else {
        const author = el('span', cls('seventv-usercard-item-author'), message.name);
        author.style.color = message.color || '#bf94ff';
        if (message.action) {
          text.classList.add('chatlogs-action');
          text.style.color = author.style.color;
        }
        messageText(text, message, emotes, (name, emote) => {
          const anchor = el('span', 'seventv-emote-anchor');
          const box = el('span', 'seventv-emote-container');
          // No title: 7TV's tooltip shows the emote instead.
          box.append(emoteImage(name, emote, 'chat-image chat-line__message--emote seventv-emote seventv-emote--base', ''));
          anchor.append(box);
          return anchor;
        });
        line.append(author, ' ', el('span', cls('seventv-usercard-item-separator'), message.action ? '' : ':'), ' ', clip);
      }
      row.append(line);
      return row;
    },
    day: (time) => new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase(),
    heading: (text, live) => el('div', `${cls('seventv-usercard-bucket-label')} chatlogs-day${live ? ' chatlogs-live-label' : ''}`, live ? 'LIVE' : text),
    group: cls('seventv-usercard-bucket'),
  };
}

function actionButton(label: string, action: string) {
  const button = el('button', 'chatlogs-action-button', label);
  button.type = 'button';
  button.dataset.chatlogsAction = action;
  return button;
}

/** The logs panel: archived lines a page at a time (older ones load on scrolling up), then live lines. */
function createPanel(channel: string, login: string, look: Look): Panel {
  const root = el('div', 'enhancer-chatlogs');
  const header = el('div', 'chatlogs-header');
  const meta = el('div', 'chatlogs-meta');
  const status = el('span', 'chatlogs-status');
  const dot = el('span', 'chatlogs-status-dot');
  const statusText = document.createTextNode('');
  status.append(dot, statusText);
  const count = el('span', '', '0 messages');
  meta.append(status, el('span', 'chatlogs-meta-sep', '·'), count);
  const full = el('a', 'chatlogs-link', 'Open Full History ');
  full.href = `https://tv.supa.sh/logs?c=${encodeURIComponent(channel)}&u=${encodeURIComponent(login)}`;
  full.target = '_blank';
  full.rel = 'noopener noreferrer';
  full.insertAdjacentHTML('beforeend', '<svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>');
  header.append(meta, full);

  const toolbar = el('div', 'chatlogs-toolbar');
  const refresh = actionButton('Refresh', 'refresh');
  toolbar.append(refresh, actionButton('Newest', 'newest'), actionButton('Oldest', 'oldest'));

  const list = el('div', 'chatlogs-messages');
  const history = el('div', look.group);
  const live = el('div', look.group);
  const footer = el('p', 'chatlogs-count');
  list.append(history, live, footer);
  // Viewer cards are draggable; let text selection and scrolling work inside the list.
  for (const type of ['mousedown', 'touchstart', 'dragstart']) list.addEventListener(type, (event) => event.stopPropagation(), { capture: true, passive: true });
  root.append(header, toolbar, list);

  let messages: ChatMessage[] = []; // archived lines fetched so far, oldest first
  let shown = 0; // of those, how many are rendered (counting from the newest)
  let months: { year: number; month: number }[] = [];
  let nextMonth = 0;
  let loading = false;
  let freshNewest = false;
  let liveCount = 0;
  let liveRows = 0;
  let lastDate = '';
  let generation = 0;
  let stopChat: (() => void) | undefined;
  let pausedAt = 0;
  const ids = new Set<string>();
  const rowMessages = new WeakMap<Element, ChatMessage>();

  let emotes: Map<string, Emote> | undefined;
  let badges: Badges | undefined;
  // Usually both are cached before the first row is drawn; rows drawn without them are redrawn once they come.
  let drawnWithout = false;
  const row = (message: ChatMessage) => {
    if (!emotes || !badges) drawnWithout = true;
    const element = look.row(message, emotes, badges);
    rowMessages.set(element, message);
    return element;
  };
  const redraw = () => {
    if (!drawnWithout) return;
    drawnWithout = !emotes || !badges;
    for (const old of list.querySelectorAll('.chatlogs-message')) {
      const message = rowMessages.get(old);
      if (message) old.replaceWith(row(message));
    }
  };
  emotesFor(channel).then((value) => { emotes = value; redraw(); }, () => { emotes = new Map(); });
  badgesFor(channel).then((value) => { badges = value; redraw(); }, () => { badges = new Map(); });

  const hasMore = () => shown < messages.length || nextMonth < months.length;

  function setLive(state: LiveState | 'stopped') {
    dot.className = `chatlogs-status-dot chatlogs-status-dot--${state}`;
    statusText.data = { connecting: 'Connecting', live: 'Live', disconnected: 'Live disconnected', stopped: 'Stopped' }[state];
  }

  function updateCounts() {
    const total = messages.length + liveCount;
    count.textContent = `${shown + liveRows} of ${total} messages`;
    footer.hidden = total === 0;
    footer.textContent = `Showing ${shown + liveRows} · ${hasMore() ? 'more available' : 'all loaded'}`;
  }

  function note(text: string, className: string) {
    history.replaceChildren(el('p', className, text));
  }

  /** Renders the next page of fetched lines above the ones shown. */
  function showOlder() {
    const end = messages.length - shown;
    const page = messages.slice(Math.max(0, end - PAGE), end);
    if (!page.length) return;
    const fragment = document.createDocumentFragment();
    let date = '';
    for (const message of page) {
      const day = look.day(message.time);
      if (day !== date) fragment.append(look.heading(date = day));
      fragment.append(row(message));
    }
    // The page ends where the shown lines begin: one heading for that day is enough.
    const first = history.firstElementChild;
    if (first?.classList.contains('chatlogs-day') && first.textContent === date) first.remove();
    const before = list.scrollHeight;
    history.prepend(fragment);
    // Keep the lines the viewer is reading in place; the first page starts at the bottom.
    list.scrollTop = shown ? list.scrollTop + list.scrollHeight - before : list.scrollHeight;
    shown += page.length;
  }

  /** Shows older lines, fetching the next month that has any when everything fetched is shown. */
  async function loadOlder() {
    if (loading) return;
    if (shown < messages.length || nextMonth >= months.length) {
      showOlder();
      updateCounts();
      return;
    }
    loading = true;
    const run = generation;
    const spinner = el('div', 'chatlogs-loading chatlogs-loading-spinner');
    spinner.append(el('span', 'chatlogs-spinner'), el('span', 'chatlogs-spinner-label', 'Loading older messages…'));
    list.prepend(spinner);
    let found: ChatMessage[] = [];
    // A month can come back empty (or fail); skip ahead a few before giving up on this scroll.
    for (let empty = 0; !found.length && empty < 10 && nextMonth < months.length; ) {
      const { year, month } = months[nextMonth]!;
      let lines: ChatMessage[] = [];
      try {
        lines = await loggedMonth(channel, login, year, month, freshNewest && nextMonth === 0);
      } catch (error) {
        console.warn('[Twitch Plus] viewer logs: month failed', year, month, error);
      }
      if (run !== generation) return;
      nextMonth++;
      found = lines.filter((line) => !ids.has(line.id));
      for (const line of found) ids.add(line.id);
      if (!found.length) empty++;
    }
    spinner.remove();
    loading = false;
    messages = [...found, ...messages];
    showOlder();
    updateCounts();
  }

  /** Until the list overflows its box there is nothing to scroll, so scrolling up cannot ask for more. */
  async function fill() {
    const run = generation;
    for (let i = 0; i < 30 && run === generation && hasMore(); i++) {
      if (!list.clientHeight || list.scrollHeight > list.clientHeight + 8) return;
      const before = shown;
      await loadOlder();
      if (shown === before) return;
    }
  }

  function onLive(message: ChatMessage) {
    if (ids.has(message.id)) return;
    ids.add(message.id);
    history.querySelector('.chatlogs-empty')?.remove();
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
    if (!live.firstChild) live.append(look.heading('Live', true));
    const day = look.day(message.time);
    if (day !== lastDate) live.append(look.heading(lastDate = day));
    live.append(row(message));
    liveCount++;
    liveRows++;
    // Past the cap, the oldest live rows go, with any date heading above them.
    while (live.childElementCount > MAX_LIVE_ROWS) {
      const oldest = live.children[1]!;
      if (oldest.classList.contains('chatlogs-message')) liveRows--;
      oldest.remove();
    }
    if (atBottom) list.scrollTop = list.scrollHeight;
    updateCounts();
  }

  async function load(fresh = false) {
    const run = ++generation;
    messages = [];
    shown = nextMonth = liveCount = liveRows = 0;
    months = [];
    loading = false;
    freshNewest = fresh;
    ids.clear();
    lastDate = '';
    live.replaceChildren();
    note('Loading chat logs...', 'chatlogs-loading');
    updateCounts();
    stopChat ??= watchChat(channel, login, onLive, setLive);
    let days;
    try {
      days = await loggedDays(channel, login, fresh);
    } catch (error) {
      if (run === generation) note(`Failed to load logs: ${(error as Error).message}`, 'chatlogs-error');
      return;
    }
    if (run !== generation) return;
    history.replaceChildren();
    months = monthsOf(days ?? []);
    await loadOlder();
    if (run !== generation) return;
    if (!messages.length && !liveCount) note('No chat messages found for this user.', 'chatlogs-empty');
    if (messages.length && !live.firstChild) lastDate = look.day(messages[messages.length - 1]!.time);
    await fill();
  }

  list.addEventListener('scroll', () => {
    if (list.scrollTop < 50 && hasMore()) loadOlder();
  }, { passive: true });

  toolbar.addEventListener('click', async (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-chatlogs-action]');
    const action = button?.dataset.chatlogsAction;
    if (action === 'newest') list.scrollTop = list.scrollHeight;
    else if (action === 'oldest') list.scrollTop = 0;
    else if (action === 'refresh' && !refresh.disabled) {
      refresh.disabled = true;
      refresh.textContent = 'Refreshing...';
      await load(true);
      refresh.disabled = false;
      refresh.textContent = 'Refresh';
    }
  });

  load();
  return {
    root,
    // Hidden panels let go of the chat connection.
    pause() {
      stopChat?.();
      stopChat = undefined;
      pausedAt = Date.now();
      setLive('stopped');
    },
    // Back after more than a few seconds: lines were missed, so start over with the newest month fetched again.
    resume() {
      if (Date.now() - pausedAt > 5000) load(true);
      else stopChat ??= watchChat(channel, login, onLive, setLive);
    },
    close() {
      generation++;
      stopChat?.();
      stopChat = undefined;
    },
  };
}

// Copy the slot around one of Twitch's own text buttons (Whisper, Follow, or on your own card Edit Profile) and
// give it our label. Twitch's style classes are generated and change with every Twitch build, so a copy is the way
// to match the current look. Copies carry no React handlers, so the button does nothing until we add ours.
function copyTextButton(template: Element, label: string) {
  const templateSlot = template.closest('.viewer-card-drag-cancel')?.parentElement;
  const slot = templateSlot?.cloneNode(true) as HTMLElement | undefined;
  const button = slot?.querySelector('button');
  if (!slot || !button) return null;
  for (const element of [slot, ...slot.querySelectorAll('*')]) {
    for (const name of element.getAttributeNames()) {
      // Drop Twitch's identifiers so nothing mistakes the copy for the real button; keep the label marker
      // Twitch's own CSS styles.
      if (name === 'id' || name === 'disabled' || name.startsWith('aria-') || name === 'data-test-selector' ||
        (name === 'data-a-target' && element.getAttribute(name) !== 'tw-core-button-label-text')) element.removeAttribute(name);
    }
  }
  // Text only: drop icons such as Follow's heart.
  for (const icon of button.querySelectorAll('svg, [data-a-selector="tw-core-button-icon"], [class*="ButtonIconFigure"]')) {
    (icon.closest('[data-a-selector="tw-core-button-icon"]') ?? icon).remove();
  }
  const text = button.querySelector('[data-a-target="tw-core-button-label-text"]') ??
    [...button.querySelectorAll('*')].reverse().find((element) => element.textContent?.trim()) ?? button;
  text.textContent = label;
  text.setAttribute('data-chatlogs-button-label', '');
  button.type = 'button';
  return { slot, button };
}

function textButtonOf(card: Element) {
  return card.querySelector('[data-test-selector="whisper-button"]') ??
    card.querySelector('[data-a-target="follow-button"]') ??
    [...card.querySelectorAll('button')].find((button) =>
      !button.closest('.enhancer-chatlogs-toggle-wrap, .enhancer-chatlogs-slot') &&
      button.querySelector('[data-a-target="tw-core-button-label-text"]'));
}

function setLabel(button: HTMLElement, label: string) {
  (button.querySelector('[data-chatlogs-button-label]') ?? button).textContent = label;
}

function loginOf(card: Element) {
  // Twitch's card links the name to the profile; 7TV's card has a profile button. Display names can differ from
  // logins (other scripts, capitals), so the link is the reliable part.
  const href = card.querySelector('.viewer-card-header__display-name a, .seventv-usercard-actions a[href*="twitch.tv/"]')?.getAttribute('href');
  const login = href?.replace(/^(https:\/\/(www\.)?twitch\.tv)?\//, '').split(/[/?#]/)[0]?.toLowerCase();
  return login && LOGIN.test(login) ? login : null;
}

function attach(element: Element, login: string, channel: string): Card {
  const wrapper = el('div', 'viewer-card-drag-cancel enhancer-chatlogs-toggle-wrap');
  const host = el('div', 'enhancer-chatlogs-host');
  host.hidden = true;
  wrapper.append(host);
  (element.querySelector('.viewer-card') ?? element).append(wrapper);

  const template = textButtonOf(element);
  const copy = template && copyTextButton(template, 'Chat Logs');
  let slot: HTMLElement;
  let button: HTMLElement;
  if (copy) {
    ({ slot, button } = copy);
    // Next to Whisper (or Follow). On your own card neither exists; join the row of whichever button was copied.
    const anchor = (element.querySelector('[data-test-selector="whisper-button"], [data-a-target="follow-button"]') ?? template)
      .closest('.viewer-card-drag-cancel')!.parentElement!;
    const row = anchor.parentElement!;
    row.insertBefore(slot, anchor.nextSibling);
    row.style.flexWrap = 'wrap';
    // Twitch puts empty flex-grow spacer slots after its buttons; when ours wraps to a new line they would leave a
    // gap beside it.
    for (let sibling = slot.nextElementSibling as HTMLElement | null; sibling; sibling = sibling.nextElementSibling as HTMLElement | null) {
      if (sibling.querySelector('.viewer-card-drag-cancel')?.childElementCount === 0) sibling.style.display = 'none';
    }
  } else {
    // Signed out the card has only icon buttons, nothing to copy: our own button heads the panel area instead.
    slot = el('div', 'enhancer-chatlogs-slot');
    button = el('button', 'chatlogs-toggle-fallback');
    (button as HTMLButtonElement).type = 'button';
    const label = el('span', '', 'Chat Logs');
    label.setAttribute('data-chatlogs-button-label', '');
    button.append(label);
    slot.append(button);
    wrapper.prepend(slot);
  }
  slot.classList.add('enhancer-chatlogs-slot');
  button.classList.add('enhancer-chatlogs-toggle-button');

  const card: Card = { login, channel, slot, copied: !!copy, wrapper, look: TWITCH_LOOK };
  bindToggle(card, button, host, (shown) => setLabel(button, shown ? 'Hide Logs' : 'Chat Logs'));
  userInfo(login).then((info) => {
    card.createdAt = info?.createdAt ?? null;
    if (cards.get(element) === card) showAccountAge(element, card);
  }, () => {});
  return card;
}

/** Opens the panel on the first click and shows or hides it after that. */
function bindToggle(card: Card, button: HTMLElement, host: HTMLElement, onChange: (shown: boolean) => void) {
  button.addEventListener('pointerenter', () => { loggedDays(card.channel, card.login).catch(() => {}); });
  button.addEventListener('click', () => {
    const show = host.hidden;
    host.hidden = !show;
    onChange(show);
    if (!card.panel) {
      card.panel = createPanel(card.channel, card.login, card.look);
      host.append(card.panel.root);
      panels.add(card.panel);
    } else if (show) card.panel.resume();
    else card.panel.pause();
  });
  // Ready by the time Chat Logs is clicked; each is fetched once per channel.
  emotesFor(card.channel).catch(() => {});
  badgesFor(card.channel).catch(() => {});
}

const HISTORY_ICON = '<svg width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>';

/**
 * 7TV replaces Twitch's chat and opens its own user card. That card already shows the account's age; it gets an
 * icon button (a copy of 7TV's own, so it takes 7TV's look) and the panel as one more section of the card's body.
 */
function attachSevenTv(element: Element, login: string, channel: string): Card | null {
  const actions = element.querySelector('.seventv-usercard-actions');
  const template = actions?.querySelector('button');
  if (!actions || !template) return null;
  const button = template.cloneNode(false) as HTMLButtonElement;
  button.type = 'button';
  button.title = 'Chat Logs';
  button.setAttribute('aria-label', 'Chat Logs');
  button.setAttribute('aria-pressed', 'false');
  button.classList.add('enhancer-chatlogs-toggle-button');
  button.innerHTML = HISTORY_ICON;
  // Before Close, which 7TV keeps last.
  actions.insertBefore(button, actions.lastElementChild);

  const wrapper = el('section', 'enhancer-chatlogs-toggle-wrap enhancer-chatlogs-7tv');
  // 7TV drags its card from anywhere but marked elements; text in the panel should be selectable.
  wrapper.dataset.usercardNoDrag = 'true';
  const host = el('div', 'enhancer-chatlogs-host');
  host.hidden = true;
  wrapper.append(host);
  (element.querySelector('.seventv-usercard-body') ?? element).append(wrapper);

  const scope = [...element.classList].find((name) => name.startsWith('svelte-')) ?? '';
  const card: Card = { login, channel, slot: button, copied: true, wrapper, look: sevenTvLook(scope) };
  bindToggle(card, button, host, (shown) => {
    button.title = shown ? 'Hide Logs' : 'Chat Logs';
    button.setAttribute('aria-pressed', String(shown));
    if (!shown || !(element instanceof HTMLElement)) return;
    // The card stays where it opened while it grows to its maximum height; lift it so its bottom stays on screen.
    const tallest = parseFloat(getComputedStyle(element).maxHeight) || element.offsetHeight;
    const top = element.getBoundingClientRect().top;
    if (top + tallest > innerHeight - 8) element.style.top = `${Math.max(8, innerHeight - 8 - tallest)}px`;
  });
  return card;
}

function detach(card: Card) {
  card.slot.remove();
  card.wrapper.remove();
  card.ageRow?.remove();
  if (card.panel) {
    card.panel.close();
    panels.delete(card.panel);
  }
}

// Copy one of the card's own info rows ("Previously Subbed for 14 Months", "Following since …") and swap in a
// calendar icon and our text, so the row matches Twitch's current size and spacing.
function copyInfoRow(template: Element, label: string) {
  const row = template.cloneNode(true) as HTMLElement;
  const icon = row.querySelector('svg');
  const text = [...row.querySelectorAll('*')].reverse().find((element) => !element.children.length && element.textContent?.trim());
  if (!icon || !text) return null;
  for (const element of [row, ...row.querySelectorAll('*')]) {
    for (const name of element.getAttributeNames()) {
      if (name === 'id' || name === 'data-a-target' || name === 'data-test-selector' || name.startsWith('aria-')) element.removeAttribute(name);
    }
  }
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `<path fill="currentColor" d="${CALENDAR_PATH}"/>`;
  text.textContent = label;
  return row;
}

function showAccountAge(element: Element, card: Card) {
  if (!card.createdAt || card.ageRow?.isConnected) return;
  const banner = element.querySelector('.viewer-card-header__banner');
  if (!banner) return;
  const date = card.createdAt;
  const label = `Account Created ${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  // The marked element may be only the row's text; the row is the smallest ancestor holding exactly one icon.
  let template: Element | null = banner.querySelector('[data-a-target="viewer-card-tier"], [data-a-target="viewer-card-followed-since"]');
  while (template && template !== banner && template.querySelectorAll('svg').length !== 1) {
    template = template.querySelectorAll('svg').length > 1 ? null : template.parentElement;
  }
  let row = template && template !== banner && template.parentElement ? copyInfoRow(template, label) : null;
  if (row) {
    template!.parentElement!.insertBefore(row, template);
  } else {
    // No info row to copy (not following, never subscribed): our own row under the name.
    const place = banner.querySelector('.viewer-card-header__display-name');
    if (!place) return;
    row = el('div', 'enhancer-account-created--fallback');
    row.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${CALENDAR_PATH}"/></svg>`;
    row.append(el('p', '', label));
    place.append(row);
  }
  row.classList.add('enhancer-account-created');
  card.ageRow = row;
}

function syncCard(element: Element) {
  const login = loginOf(element);
  const channel = channelFromPath(location.pathname);
  if (!login || !channel) return;
  let card = cards.get(element);
  const sevenTv = element.classList.contains('seventv-usercard');
  // Twitch and 7TV reuse their card for the next viewer, and can re-render away what we added.
  if (card && (card.login !== login || card.channel !== channel || !card.wrapper.isConnected || !card.slot.isConnected ||
    (!card.copied && textButtonOf(element)))) {
    detach(card);
    card = undefined;
  }
  if (!card) {
    const attached = sevenTv ? attachSevenTv(element, login, channel) : attach(element, login, channel);
    if (!attached) return;
    cards.set(element, card = attached);
  }
  if (sevenTv) return;
  showAccountAge(element, card);
}

const cards = new WeakMap<Element, Card>();
const panels = new Set<Panel>();

const STYLE = `
  .enhancer-chatlogs-toggle-wrap, .enhancer-chatlogs-host { width: 100%; box-sizing: border-box; }
  /* The panel styles itself from Twitch's theme variables, which follow light and dark mode. */
  .enhancer-chatlogs {
    display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.8rem;
    padding: 0 1rem 1rem; box-sizing: border-box;
    color: var(--color-text-base, #efeff1); font-size: 1.3rem; line-height: 1.5;
  }
  .enhancer-chatlogs .chatlogs-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.4rem 0.8rem; }
  .enhancer-chatlogs .chatlogs-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; color: var(--color-text-alt-2, #adadb8); font-size: 1.2rem; }
  .enhancer-chatlogs .chatlogs-meta-sep { opacity: 0.4; margin: 0 2px; }
  .enhancer-chatlogs .chatlogs-status { display: inline-flex; align-items: center; gap: 0.5rem; font-weight: 600; color: var(--color-text-base, #efeff1); }
  .chatlogs-status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .chatlogs-status-dot--live { background: #00b26b; box-shadow: 0 0 0 2px rgba(0, 178, 107, 0.25); }
  .chatlogs-status-dot--connecting { background: #f0a500; }
  .chatlogs-status-dot--disconnected, .chatlogs-status-dot--stopped { background: #6b7280; }
  .enhancer-chatlogs .chatlogs-link {
    display: inline-flex; align-items: center; gap: 0.2rem; font-size: 1.2rem; font-weight: 600; white-space: nowrap;
    color: var(--color-text-link, #bf94ff); text-decoration: none;
  }
  .enhancer-chatlogs .chatlogs-link svg { opacity: 0.7; }
  .enhancer-chatlogs .chatlogs-link:hover { color: var(--color-text-link-hover, #a970ff); text-decoration: underline; }
  .enhancer-chatlogs .chatlogs-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; }
  /* Twitch's secondary (grey) pill buttons, one step below the purple Follow/Whisper/Chat Logs row. */
  .enhancer-chatlogs .chatlogs-action-button, .chatlogs-toggle-fallback {
    display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
    height: 3rem; padding: 0 1.2rem; border: 0; border-radius: 9000px;
    background: var(--color-background-button-secondary-default, rgba(83, 83, 95, 0.38));
    color: var(--color-text-button-secondary, #efeff1);
    font-family: inherit; font-size: 1.3rem; font-weight: 600; line-height: 1; white-space: nowrap;
    cursor: pointer; appearance: none;
  }
  .enhancer-chatlogs .chatlogs-action-button:hover:not(:disabled) { background: var(--color-background-button-secondary-hover, rgba(83, 83, 95, 0.48)); }
  .enhancer-chatlogs .chatlogs-action-button:active:not(:disabled) { background: var(--color-background-button-secondary-active, rgba(83, 83, 95, 0.55)); }
  .enhancer-chatlogs .chatlogs-action-button:focus-visible, .chatlogs-toggle-fallback:focus-visible {
    outline: 2px solid var(--color-border-interactable-focus, #a970ff); outline-offset: 2px;
  }
  .enhancer-chatlogs .chatlogs-action-button:disabled { opacity: 0.5; cursor: default; }
  /* Signed out there is no Twitch text button to copy; this one takes Twitch's primary (purple) look. */
  .enhancer-chatlogs-slot:has(> .chatlogs-toggle-fallback) { padding: 0.5rem 1rem 0; }
  .chatlogs-toggle-fallback {
    background: var(--color-background-button-primary-default, #9147ff); color: var(--color-text-button-primary, #fff);
  }
  .chatlogs-toggle-fallback:hover { background: var(--color-background-button-primary-hover, #772ce8); }
  .enhancer-chatlogs .chatlogs-messages {
    max-height: 250px; overflow: hidden auto; margin: 0 -0.4rem; padding: 0.4rem 0.4rem 0;
    border-top: 1px solid var(--color-border-base, rgba(83, 83, 95, 0.48));
    scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.25) transparent;
  }
  .vcml-message.chatlogs-message {
    display: block; padding: 0.3rem 0.4rem; line-height: 2rem; border-radius: 2px; transition: background 0.1s;
    overflow-wrap: break-word; word-break: break-word; min-width: 0;
  }
  .vcml-message.chatlogs-message:hover { background: rgba(255, 255, 255, 0.04); }
  .enhancer-chatlogs .vcml-message__timestamp { margin-right: 6px; color: var(--color-text-alt-2, #adadb8); font-variant-numeric: tabular-nums; }
  .chatlogs-notice { font-style: italic; opacity: 0.85; }
  .chatlogs-action { font-style: italic; }
  .chatlogs-emote { display: inline-block; height: 1.2em; width: auto; vertical-align: middle; margin: 0 2px; }
  .chatlogs-linkified { color: #a970ff; text-decoration: none; overflow-wrap: break-word; word-break: break-all; }
  .chatlogs-linkified:hover { text-decoration: underline; }
  .chatlogs-badges-container { display: inline; vertical-align: middle; margin-right: 2px; }
  .chatlogs-badge { display: inline-block; height: 1.8rem; width: auto; vertical-align: middle; margin-right: 3px; border-radius: 2px; }
  .chatlogs-first-msg {
    display: inline-block; margin-left: 5px; padding: 0 4px; vertical-align: middle; line-height: 1.5; cursor: default;
    font-size: 0.75em; font-weight: 600; color: #7dd3fc;
    background: rgba(100, 200, 255, 0.12); border: 1px solid rgba(100, 200, 255, 0.25); border-radius: 3px;
  }
  .chatlogs-reply-context {
    display: block; margin-bottom: 2px; padding-left: 6px; font-size: 1.1rem; opacity: 0.55;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-left: 2px solid rgba(255, 255, 255, 0.22);
  }
  .chatlogs-date-separator {
    display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; white-space: nowrap;
    font-size: 1.1rem; font-weight: 600; color: var(--color-text-alt-2, #adadb8);
  }
  .chatlogs-date-separator::before, .chatlogs-date-separator::after {
    content: ''; flex: 1; height: 1px; background: var(--color-border-base, rgba(255, 255, 255, 0.15));
  }
  .chatlogs-live-separator { color: #00b26b; }
  .chatlogs-live-separator::before, .chatlogs-live-separator::after { background: rgba(0, 178, 107, 0.35); }
  .chatlogs-count { margin: 8px 0 0; opacity: 0.65; text-align: center; }
  .chatlogs-count[hidden] { display: none; }
  .chatlogs-loading-spinner { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 0; opacity: 0.75; }
  .chatlogs-spinner {
    display: inline-block; width: 16px; height: 16px; flex-shrink: 0; border-radius: 50%;
    border: 2px solid rgba(169, 112, 255, 0.25); border-top-color: #a970ff; animation: chatlogs-spin 0.7s linear infinite;
  }
  .chatlogs-spinner-label { font-size: 1.1rem; color: var(--color-text-alt-2, #adadb8); }
  @keyframes chatlogs-spin { to { transform: rotate(360deg); } }
  /* Account Created row when the card has no Twitch info row to copy: one line, icon at Twitch's 2rem size. */
  .enhancer-account-created--fallback { display: flex; align-items: center; gap: 0.5rem; }
  .enhancer-account-created--fallback svg { width: 2rem; height: 2rem; flex: none; }
  .enhancer-account-created--fallback p { margin: 0; }
  /* A copied info row keeps Twitch's classes; pin its icon to Twitch's info icon size in case they size by content. */
  .enhancer-account-created svg { max-width: 2rem; max-height: 2rem; }
  /* On 7TV's card: a section of its scrolling body, which has its own padding, and a shorter list. */
  /* On 7TV's card: a section of its scrolling body, in 7TV's colours and sizes; the lines themselves take 7TV's
     own styles (see sevenTvLook). */
  .enhancer-chatlogs-7tv .enhancer-chatlogs { gap: 6px; margin-top: 8px; padding: 0; font-size: 12px; color: var(--seventv-text, inherit); }
  .enhancer-chatlogs-7tv .chatlogs-meta, .enhancer-chatlogs-7tv .chatlogs-count { font-size: 11px; color: var(--seventv-text-dim, #adadb8); opacity: 1; }
  .enhancer-chatlogs-7tv .chatlogs-status { color: var(--seventv-text, inherit); }
  .enhancer-chatlogs-7tv .chatlogs-link { font-size: 11px; color: var(--seventv-primary, #a970ff); }
  .enhancer-chatlogs-7tv .chatlogs-action-button {
    height: 24px; padding: 0 8px; font-size: 11px; color: var(--seventv-text, #efeff1);
    background: var(--seventv-surface, rgba(83, 83, 95, 0.38)); border: 1px solid var(--seventv-border-subtle, transparent);
    border-radius: var(--seventv-radius-lg, 6px);
  }
  .enhancer-chatlogs-7tv .chatlogs-action-button:hover:not(:disabled) { background: var(--seventv-hover, rgba(83, 83, 95, 0.48)); }
  .enhancer-chatlogs-7tv .chatlogs-messages {
    max-height: 200px; margin: 0; padding: 6px 0 0; border-top-color: var(--seventv-border-subtle, rgba(83, 83, 95, 0.48));
  }
  .enhancer-chatlogs-7tv .chatlogs-messages > .seventv-usercard-bucket:empty { display: none; }
  .enhancer-chatlogs-7tv .chatlogs-messages > .seventv-usercard-bucket + .seventv-usercard-bucket { margin-top: 4px; }
  .enhancer-chatlogs-7tv .chatlogs-notice { color: var(--seventv-text-muted, #adadb8); }
  .enhancer-chatlogs-toggle-button[aria-pressed="true"] { color: var(--seventv-primary, #a970ff); }
`;

// Starts once <html> exists.
const viewerLogs: Module = () => whenRoot(() => {
  const style = el('style');
  style.id = 'enhancer-chatlogs-styles';
  style.textContent = STYLE;
  listen((batch) => {
    if (batch.viewerCard) {
      for (const element of document.querySelectorAll('.viewer-card-layer [data-a-target="viewer-card"], #seventv-root .seventv-usercard')) {
        if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
        syncCard(element);
      }
    }
    // A closed card takes its panel with it; let go of the chat connection.
    for (const panel of panels) {
      if (panel.root.isConnected) continue;
      panel.close();
      panels.delete(panel);
    }
  });
});

export default viewerLogs;
