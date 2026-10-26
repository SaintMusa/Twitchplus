import type { Module } from '../modules';

// Focuses the chat box (or search) with a hotkey.
// The chat box is a Slate editor: <div role="textbox" contenteditable data-a-target="chat-input">.
// Same selector in the channel page, popout chat and mod view. The search box is the top-nav
// <input type="search" autocomplete="twitch-nav-search"> (aria-label is translated, this is not).
// A target that is absent or hidden (chat collapsed, search folded into an icon on narrow windows)
// leaves the key alone, so it types as normal.

const CHAT_INPUT = '[data-a-target="chat-input"]';
const SEARCH_INPUT = 'input[autocomplete="twitch-nav-search"]';
const SEARCH_RESULTS = '[data-a-target="nav-search-tray"]';

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

// Only fields that take typing; a focused slider or checkbox (e.g. the player volume) still lets the keys through.
const isTyping = (el: Element | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)));

const isVisible = (el: Element) => el.getClientRects().length > 0;

interface Target {
  selector: string;
  focus(el: HTMLElement): void;
}

declare global {
  interface Window {
    // Guard against starting twice.
    __twitchChatFocusHotkey?: Record<string, never>;
  }
}

const chatHotkeys: Module = (options) => {
  if (window.__twitchChatFocusHotkey) return;
  window.__twitchChatFocusHotkey = {};
  // Matched on e.key, so ? works on layouts where it is not Shift+/.
  const targets: Record<string, Target> = {};
  if (options.chatKey !== false) {
    targets['/'] = {
      selector: CHAT_INPUT,
      // Slate syncs its selection from the DOM on selectionchange; without this the caret can land
      // at the start of a half-typed message.
      focus(el) {
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      },
    };
  }
  if (options.searchKey !== false) {
    targets['?'] = {
      selector: SEARCH_INPUT,
      // Select the old query so typing replaces it.
      focus(el) {
        el.focus();
        (el as HTMLInputElement).select();
      },
    };
  }

  // Capture phase on window: runs before Twitch's own handlers, so the key never reaches the page.
  window.addEventListener(
    'keydown',
    (e) => {
      // Search swallows every Escape (stopPropagation) and only closes its results, keeping focus.
      // So leave it here, before Twitch sees the key, but only once the results are already closed.
      if (e.key === 'Escape') {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.matches(SEARCH_INPUT) &&
          ![...document.querySelectorAll(SEARCH_RESULTS)].some(isVisible)) active.blur();
        return;
      }
      const target = targets[e.key];
      if (!target || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.repeat) return;
      if (isTyping(document.activeElement)) return;
      const el = [...document.querySelectorAll<HTMLElement>(target.selector)].find(isVisible);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      target.focus(el);
    },
    true,
  );

  // Bubble phase: Twitch closes its emote/mention autocomplete on Escape and marks the event handled;
  // only a plain Escape that nothing else used leaves the chat box (so player keys like F and M work again).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches(CHAT_INPUT)) active.blur();
  });
};

export default chatHotkeys;
