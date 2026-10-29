// One page observer shared by pins, latency, screenshot and viewer logs.
// Each batch of changes is sorted once into the areas the features care about; a feature is only called for
// the areas it listens to.

export interface Batch {
  childList: boolean;
  sideNav: boolean;
  dialog: boolean;
  /**
   * Something changed where user cards live: Twitch's viewer card layer, or 7TV's root, which holds its own card.
   * A card opened, closed or rendered more of itself.
   */
  viewerCard: boolean;
  styled: Element[];
}

type Listener = (batch: Batch) => void;

const listeners: Listener[] = [];
let started = false;

function dispatch(records: MutationRecord[]) {
  const batch: Batch = { childList: false, sideNav: false, dialog: false, viewerCard: false, styled: [] };
  for (const record of records) {
    const target = record.target as Element;
    if (record.type === 'childList') {
      batch.childList = true;
      const added = [...record.addedNodes] as Element[];
      if (!batch.sideNav) batch.sideNav = !!target.closest?.('#side-nav') ||
        added.some((node) => node.id === 'side-nav' || node.querySelector?.('#side-nav'));
      if (!batch.dialog) batch.dialog = !!target.closest?.('.tw-dialog-layer') ||
        added.some((node) => node.classList?.contains('tw-dialog-layer'));
      // Both containers sit empty on the page from the start; cards are mounted inside them.
      if (!batch.viewerCard) batch.viewerCard = !!target.closest?.('.viewer-card-layer, #seventv-root');
    } else if (record.attributeName === 'href') {
      if (!batch.sideNav) batch.sideNav = !!target.closest?.('#side-nav');
    } else {
      batch.styled.push(target);
    }
  }
  for (const listener of listeners) {
    try { listener(batch); } catch (error) { console.error('[Twitch Plus]', error); }
  }
}

function observe() {
  new MutationObserver(dispatch).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'class', 'style', 'hidden'],
  });
}

/** Calls `listener` for every batch of page changes. The observer starts with the first listener. */
export function listen(listener: Listener) {
  listeners.push(listener);
  if (started) return;
  started = true;
  // At document-start some injectors run before <html> exists; observing null throws.
  if (document.documentElement) observe();
  else new MutationObserver((_, waiting) => {
    if (!document.documentElement) return;
    waiting.disconnect();
    observe();
  }).observe(document, { childList: true });
}

/**
 * Runs `start` once <html> exists: right away at a normal document start, later if the page script ran even
 * earlier. A failure after waiting is logged, since the loader has moved on.
 */
export function whenRoot(start: () => void) {
  if (document.documentElement) return start();
  new MutationObserver((_, waiting) => {
    if (!document.documentElement) return;
    waiting.disconnect();
    try { start(); } catch (error) { console.error('[Twitch Plus]', error); }
  }).observe(document, { childList: true });
}
