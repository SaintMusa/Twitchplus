import type { Module } from '../modules';

// Ported from twitch-chat-hover-pause.user.js 1.0.1.
// Native flow (chat scroller class component, minified name varies):
//   onMouseEnter -> hoverPause -> setHoverResumeInterval: setInterval(onHoverResumeInterval, 1000)
//   onHoverResumeInterval counts hoverResumeSecondsRemaining 5 -> 1, then resume()
//   onMouseLeave -> hoverResume, which only resumes while hoverResumeInterval !== null
// So the interval must keep existing; only its tick is neutralised.
// Only applies when the chat pause setting is Mouseover or Mouse/Alt.

declare global {
  interface Window {
    // Same global as the userscript, so a still-installed userscript sees it and stays out.
    __twitchChatHoverPause?: { version: string; state: string; patchedInstances: number; prototypePatched: boolean };
  }
}

// Twitch's React component instances; their shape is checked at runtime by isScroller.
type Scroller = any;

const hoverPause: Module = () => {
  if (window.__twitchChatHoverPause) return;
  const status: NonNullable<Window['__twitchChatHoverPause']> = (window.__twitchChatHoverPause = {
    version: 'twitch-plus', state: 'starting', patchedInstances: 0, prototypePatched: false,
  });

  const patched = new WeakSet<object>();
  const patchedPrototypes = new WeakSet<object>();
  const noop = () => {};

  const isScroller = (node: Scroller) => node && typeof node.hoverPause === 'function'
    && typeof node.onHoverResumeInterval === 'function' && typeof node.setHoverResumeInterval === 'function';

  function patchInstance(inst: Scroller) {
    if (patched.has(inst)) return;
    patched.add(inst);
    inst.onHoverResumeInterval = noop;
    // A countdown already running holds the old tick; restart it with the no-op.
    const running = inst.state?.hoverResumeInterval;
    if (running) {
      clearInterval(running);
      inst.setState({ hoverResumeInterval: setInterval(inst.onHoverResumeInterval, 1e3) });
    }
    status.patchedInstances++;
    status.state = 'active';
  }

  // Class fields live on each instance, but componentDidMount is on the prototype,
  // so wrapping it covers every later mount (channel switch, popout, remount).
  function patchPrototype(proto: Scroller) {
    if (!proto || patchedPrototypes.has(proto) || typeof proto.componentDidMount !== 'function') return;
    patchedPrototypes.add(proto);
    const original = proto.componentDidMount;
    proto.componentDidMount = function (this: Scroller, ...args: unknown[]) {
      try { if (isScroller(this)) patchInstance(this); } catch {}
      return original.apply(this, args);
    };
    status.prototypePatched = true;
  }

  function getFiber(element: Element): Scroller {
    for (const key in element) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return (element as Scroller)[key];
    }
    return null;
  }

  function scan() {
    for (const container of document.querySelectorAll('.chat-scrollable-area__message-container')) {
      let fiber = getFiber(container);
      for (let i = 0; fiber && i < 30; i++, fiber = fiber.return) {
        if (!isScroller(fiber.stateNode)) continue;
        patchPrototype(Object.getPrototypeOf(fiber.stateNode));
        patchInstance(fiber.stateNode);
        break;
      }
    }
  }

  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  });

  function start() {
    // The countdown ring would sit frozen at "5"; the footer text and click-to-resume stay.
    // The button is a `20px auto` grid, so collapse it to one column or the text lands in the 20px slot.
    const style = document.createElement('style');
    style.textContent = `
      .chat-paused-footer--button:has(> * > .circle-countdown--svg-container) { grid-template-columns: auto !important; }
      .chat-paused-footer--button > :has(> .circle-countdown--svg-container) { display: none !important; }`;
    document.head.appendChild(style);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scan();
  }

  if (document.head) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
};

export default hoverPause;
