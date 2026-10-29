// The tab's real visibility, shared by preferred quality, latency and viewer logs.
// Ad blocking (lib/modules/vaft-*.ts) makes document.hidden and visibilityState always say visible, and stops
// visibilitychange at document, so Twitch keeps playing through ads in a background tab. Both fakes sit on the
// document object itself: Chrome's own getter on Document.prototype still answers truthfully, and a capturing
// listener on window hears the event before it reaches document.

let realState: (() => unknown) | undefined;

/** True while the tab is really hidden (another tab in front, minimized, or fully covered). */
export function isHidden(): boolean {
  // Looked up on first use, not at import: the unit tests import modules where Document does not exist.
  realState ??= Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')?.get ?? (() => document.visibilityState);
  return realState.call(document) === 'hidden';
}

/** Calls `listener` whenever the tab is really hidden or shown; read the state with isHidden(). */
export function onVisibilityChange(listener: () => void) {
  window.addEventListener('visibilitychange', listener, true);
}
