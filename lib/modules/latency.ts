// @ts-nocheck
// Adds a stream latency badge and a button to jump to the live edge.
import type { Module } from '../modules';
import { listen, whenRoot } from '../page-observer';
import { isHidden, onVisibilityChange } from '../visibility';

// Starts once <html> exists.
const latency: Module = () => whenRoot(() => {
    if (typeof window.__twitchNativeLatencyReport === 'function') return;
    const PLAYER = '[data-a-target="video-player"], .video-player';
    // Top-bar badge normally; with the DVR seekbar Twitch moves it beside the seekbar.
    const BADGE = '.video-player__overlay .tw-channel-status-text-indicator';
    const BUTTON = '[data-a-target="musa-player-latency-button"]';
    const TOOLTIP = 'Stream delay. Click to refresh player.';
    const mounts = new Map();
    const status = { refreshes: 0, lastLatency: null, lastError: null };
    let scheduled = false;
    let refreshing = false;

    window.__twitchNativeLatencyReport = () => ({
      mountedButtons: [...mounts.values()].filter(ui => ui.host.isConnected).length,
      refreshing, refreshes: status.refreshes, lastLatency: status.lastLatency, lastError: status.lastError,
    });

    const style = document.createElement('style');
    style.id = 'musa-twitch-native-latency-style';
    style.textContent = `
      .musa-twitch-latency-control{position:relative;display:inline-flex;vertical-align:top;align-self:center;flex:none}
      .musa-twitch-latency-control[hidden]{display:none}
      /* Square off the touching corners so LIVE and the delay read as one chip. The auto margin keeps
         both at the right edge of the seekbar's space-between row instead of pushing LIVE to the middle. */
      .tw-channel-status-text-indicator:has(+ .musa-twitch-latency-control:not([hidden])){
        vertical-align:top;margin-left:auto;border-top-right-radius:0!important;border-bottom-right-radius:0!important}
      ${BUTTON}{display:inline-flex;align-items:center;gap:.4rem;box-sizing:border-box;
        padding:.1rem .6rem;border:0;border-radius:0 .4rem .4rem 0;
        background:rgba(0,0,0,.6);color:#fff;cursor:pointer;flex:none;appearance:none;
        font-family:inherit;font-size:1.2rem;font-weight:600;line-height:1.68rem;white-space:nowrap;
        font-variant-numeric:tabular-nums}
      ${BUTTON}:hover:not(:disabled){background:rgba(0,0,0,.8)}
      ${BUTTON}:focus-visible{outline:2px solid var(--color-border-interactable-focus,#a970ff);outline-offset:2px}
      ${BUTTON}:disabled{opacity:.7;cursor:default}
      .musa-twitch-latency-rate{opacity:.65}
      .musa-twitch-latency-rate:empty{display:none}
      .musa-twitch-latency-tooltip{position:absolute;right:0;top:calc(100% + .6rem);
        z-index:1000;padding:.3rem .6rem;border-radius:.3rem;white-space:nowrap;
        font-family:inherit;font-size:1.2rem;font-weight:600;line-height:1.5;
        background:var(--color-background-tooltip,#fff);color:var(--color-text-tooltip,#0e0e10);
        box-shadow:0 2px 4px rgba(0,0,0,.3);pointer-events:none;visibility:hidden;opacity:0}
      .musa-twitch-latency-control:hover .musa-twitch-latency-tooltip,
      .musa-twitch-latency-control:focus-within .musa-twitch-latency-tooltip{visibility:visible;opacity:1}
      .musa-twitch-latency-notice{position:absolute;right:1rem;top:5rem;z-index:1000;
        max-width:calc(100% - 2rem);padding:.8rem 1.2rem;border-radius:.4rem;
        background:var(--color-background-alt,#18181b);color:var(--color-text-base,#efeff1);
        font-family:inherit;font-size:1.3rem;line-height:1.5;box-shadow:0 2px 8px rgba(0,0,0,.4);
        pointer-events:none}
      .musa-twitch-latency-notice[hidden]{display:none}
    `;

    function fiberOf(element) {
      if (!element) return null;
      for (const key in element) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return element[key];
      }
      return null;
    }

    function findChild(fiber, test, depth = 0) {
      if (!fiber || depth > 200) return null;
      try { if (test(fiber)) return fiber; } catch {}
      return findChild(fiber.child, test, depth + 1) || findChild(fiber.sibling, test, depth + 1);
    }

    function findParent(fiber, test, depth = 0) {
      for (; fiber && depth <= 200; fiber = fiber.return, depth++) {
        try { if (test(fiber)) return fiber; } catch {}
      }
      return null;
    }

    // Twitch keeps its media player on a React component above the video.
    function playerProps() {
      const hasPlayer = fiber => !!fiber?.stateNode?.props?.mediaPlayerInstance;
      const node = findChild(fiberOf(document.querySelector('.persistent-player')), hasPlayer) ||
        findParent(fiberOf(document.querySelector('[data-a-target="player-overlay-click-handler"]')), hasPlayer);
      return node?.stateNode?.props || null;
    }

    function mediaPlayer(props) {
      const instance = props?.mediaPlayerInstance;
      return instance && 'playerInstance' in instance ? instance.playerInstance : instance || null;
    }

    function readLatency(player) {
      let latency;
      try { latency = player.getLiveLatency?.() ?? player.core?.state?.liveLatency; } catch {}
      if (typeof latency === 'number' && Number.isFinite(latency) && latency > 0) return latency;
      const video = player.getHTMLVideoElement?.();
      if (!video || video.paused || !video.buffered.length) return null;
      const behind = video.buffered.end(video.buffered.length - 1) - video.currentTime;
      return Number.isFinite(behind) && behind > 0 ? behind : null;
    }

    function snapshot() {
      const props = playerProps();
      const player = mediaPlayer(props);
      const live = !!player && props.content?.type === 'live' && props.isOffline !== true;
      let rate = 1;
      try { rate = player?.getPlaybackRate?.() ?? 1; } catch {}
      return { player, live, latency: live ? readLatency(player) : null, rate };
    }

    function render(ui, state) {
      if (!ui.host.isConnected) return;
      ui.host.hidden = !state.live;
      ui.button.disabled = refreshing;
      const text = refreshing ? 'Refreshing…' : state.latency == null ? '—' : `${state.latency.toFixed(2)}s`;
      if (ui.value.textContent !== text) ui.value.textContent = text;
      const rate = !refreshing && Math.abs(state.rate - 1) > 0.005 ? `(${state.rate.toFixed(2)}x)` : '';
      if (ui.rate.textContent !== rate) ui.rate.textContent = rate;
      const label = refreshing ? 'Refreshing player…'
        : `Stream delay ${state.latency == null ? 'unknown' : `${state.latency.toFixed(2)} seconds`}. Click to refresh player.`;
      if (ui.button.getAttribute('aria-label') !== label) ui.button.setAttribute('aria-label', label);
    }

    function update() {
      const state = snapshot();
      status.lastLatency = state.latency;
      for (const ui of mounts.values()) render(ui, state);
    }

    function notify(ui, message) {
      if (!ui.root.isConnected) return;
      clearTimeout(ui.noticeTimer);
      ui.notice.textContent = message;
      ui.notice.hidden = false;
      ui.noticeTimer = setTimeout(() => { ui.notice.hidden = true; }, 3500);
    }

    async function refresh(ui) {
      if (refreshing) return;
      const { player, live } = snapshot();
      let path;
      try { path = player?.getPath?.(); } catch {}
      if (!live || !path) { status.lastError = 'player-unavailable'; notify(ui, 'Couldn’t find the player. Reload the page.'); return; }
      refreshing = true;
      status.lastError = null;
      update();
      try {
        // Reloading the current source rebuilds the stream buffer and rejoins at the live edge.
        player.load(path);
        player.play();
        const started = performance.now();
        while (performance.now() - started < 10000) {
          await new Promise(resolve => setTimeout(resolve, 250));
          const current = mediaPlayer(playerProps());
          if (current?.getState?.() === 'Playing' && !current.isPaused?.()) {
            status.refreshes++;
            return;
          }
        }
        throw new Error('refresh-timeout');
      } catch (error) {
        status.lastError = error?.message === 'refresh-timeout' ? 'refresh-timeout' : 'refresh-failed';
        notify(ui, 'Couldn’t refresh the player. Reload the page.');
      } finally {
        refreshing = false;
        update();
      }
    }

    function mount(badge, root) {
      const host = document.createElement('div');
      host.className = 'musa-twitch-latency-control';
      host.hidden = true;
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-a-target', 'musa-player-latency-button');
      const value = document.createElement('span');
      const rate = document.createElement('span');
      rate.className = 'musa-twitch-latency-rate';
      button.append(value, rate);
      const tooltip = document.createElement('div');
      tooltip.className = 'musa-twitch-latency-tooltip';
      tooltip.setAttribute('aria-hidden', 'true');
      tooltip.textContent = TOOLTIP;
      host.append(button, tooltip);
      const notice = document.createElement('div');
      notice.className = 'musa-twitch-latency-notice';
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      notice.hidden = true;
      const ui = { badge, root, host, button, value, rate, notice, noticeTimer: null };
      button.addEventListener('pointerdown', event => event.stopPropagation());
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        void refresh(ui);
      });
      badge.after(host);
      root.appendChild(notice);
      return ui;
    }

    function scan() {
      scheduled = false;
      if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
      for (const [badge, ui] of mounts) {
        if (!badge.isConnected || !ui.root.isConnected || !ui.host.isConnected ||
            ui.host.previousElementSibling !== badge || badge.closest(PLAYER) !== ui.root) {
          clearTimeout(ui.noticeTimer);
          ui.host.remove();
          ui.notice.remove();
          mounts.delete(badge);
        }
      }
      for (const badge of document.querySelectorAll(BADGE)) {
        const root = badge.closest(PLAYER);
        if (root && !mounts.has(badge)) mounts.set(badge, mount(badge, root));
      }
      // Chat keeps changing the page in a background tab too; the readout is redrawn once the tab is shown.
      if (!isHidden()) update();
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      setTimeout(scan, 50);
    }
    listen(batch => { if (batch.childList) schedule(); });
    // A background tab shows nothing, so the readout only ticks while the tab is visible.
    setInterval(() => { if (mounts.size && !isHidden()) update(); }, 1000);
    onVisibilityChange(() => { if (!isHidden() && mounts.size) update(); });
    scan();
});

export default latency;
