// @ts-nocheck
// Verbatim port of the screenshot feature of Twitch Native UI 1.3.0 (was Twitch Native Screenshot 1.0.0), lines 1670-1910 of the userscript.
// Kept unchanged so fixes can be compared line by line with the userscript; adding types is a later refactor.
// Its own duplicate guard and storage keys are unchanged, so a still-installed userscript and this never both run.
import type { Module } from '../modules';
import { listen, whenRoot } from '../page-observer';

// Native UI started its features only once <html> existed (its startAll); whenRoot keeps that.
const screenshot: Module = () => whenRoot(() => {
    if (typeof window.__twitchNativeScreenshotReport === 'function') return;
    const VERSION = '1.0.0';
    const PLAYER = '[data-a-target="video-player"], .video-player';
    const GROUP = '.player-controls__right-control-group';
    const REFERENCE = '[data-a-target="player-settings-button"], [data-a-target="player-fullscreen-button"]';
    const BUTTON = '[data-a-target="musa-player-screenshot-button"]';
    const mounts = new Map();
    const watchedVideos = new WeakSet();
    const status = { captures: 0, downloadsRequested: 0, lastFrame: null, lastError: null };
    let sequence = 0;
    let scheduled = false;
    let busy = false;

    window.__twitchNativeScreenshotReport = () => ({
      version: VERSION, mountedButtons: [...mounts.values()].filter(ui => ui.host.isConnected).length,
      busy, captures: status.captures, downloadsRequested: status.downloadsRequested,
      lastFrame: status.lastFrame ? { ...status.lastFrame } : null, lastError: status.lastError,
    });

    const style = document.createElement('style');
    style.id = 'musa-twitch-native-screenshot-style';
    style.textContent = `
      .musa-twitch-screenshot-control{position:relative;display:inline-flex;align-items:center;flex:none}
      ${BUTTON}{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;
        width:3rem;height:3rem;padding:.5rem;border:0;border-radius:.4rem;background:transparent;
        color:var(--color-text-base,#efeff1);cursor:pointer;flex:none;line-height:1;appearance:none}
      ${BUTTON}:hover:not(:disabled){background:var(--color-background-interactable-hover,rgba(255,255,255,.2))}
      ${BUTTON}:active:not(:disabled){background:var(--color-background-interactable-active,rgba(255,255,255,.3))}
      ${BUTTON}:focus-visible{outline:2px solid var(--color-border-interactable-focus,#a970ff);outline-offset:2px}
      ${BUTTON}:disabled{opacity:.45;cursor:default}
      ${BUTTON} svg{display:block;width:2rem;height:2rem;fill:currentColor;pointer-events:none}
      .musa-twitch-screenshot-tooltip{position:absolute;right:0;bottom:calc(100% + .6rem);
        z-index:1000;padding:.3rem .6rem;border-radius:.3rem;white-space:nowrap;
        font-family:inherit;font-size:1.2rem;font-weight:600;line-height:1.5;
        background:var(--color-background-tooltip,#fff);color:var(--color-text-tooltip,#0e0e10);
        box-shadow:0 2px 4px rgba(0,0,0,.3);pointer-events:none;visibility:hidden;opacity:0}
      .musa-twitch-screenshot-control:hover .musa-twitch-screenshot-tooltip,
      .musa-twitch-screenshot-control:focus-within .musa-twitch-screenshot-tooltip{visibility:visible;opacity:1}
      .musa-twitch-screenshot-notice{position:absolute;right:1rem;bottom:6rem;z-index:1000;
        max-width:calc(100% - 2rem);padding:.8rem 1.2rem;border-radius:.4rem;
        background:var(--color-background-alt,#18181b);color:var(--color-text-base,#efeff1);
        font-family:inherit;font-size:1.3rem;line-height:1.5;box-shadow:0 2px 8px rgba(0,0,0,.4);
        pointer-events:none}
      .musa-twitch-screenshot-notice[hidden]{display:none}
    `;

    function findVideo(root) {
      let best = null;
      let bestArea = -1;
      for (const video of root.querySelectorAll('video')) {
        const rect = video.getBoundingClientRect();
        const computed = getComputedStyle(video);
        if (typeof video.checkVisibility === 'function' &&
            !video.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        if (rect.width <= 0 || rect.height <= 0 || computed.display === 'none' ||
            computed.visibility === 'hidden' || Number(computed.opacity) === 0) continue;
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) continue;
        const area = rect.width * rect.height;
        if (area > bestArea) { best = video; bestArea = area; }
      }
      return best;
    }

    function updateReady(ui) {
      if (!ui.host.isConnected) return;
      ui.button.disabled = busy || !findVideo(ui.root);
      const label = busy ? 'Saving screenshot…' : ui.button.disabled ? 'Screenshot (video not ready)' : 'Screenshot';
      if (ui.button.getAttribute('aria-label') !== label) ui.button.setAttribute('aria-label', label);
      if (ui.tooltip.textContent !== label) ui.tooltip.textContent = label;
    }

    function notify(ui, message) {
      if (!ui.root.isConnected) return;
      clearTimeout(ui.noticeTimer);
      ui.notice.textContent = message;
      ui.notice.hidden = false;
      ui.noticeTimer = setTimeout(() => { ui.notice.hidden = true; }, 3500);
    }

    function filename() {
      const parts = location.pathname.split('/').filter(Boolean);
      const name = parts[0] === 'videos' ? `vod-${parts[1] || 'video'}` : parts[0] || 'stream';
      const safe = name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'stream';
      return `twitch-${safe}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    }

    function png(canvas) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('encode-timeout')), 10000);
        try {
          canvas.toBlob(blob => {
            clearTimeout(timeout);
            blob ? resolve(blob) : reject(new Error('encode-failed'));
          }, 'image/png');
        } catch (error) { clearTimeout(timeout); reject(error); }
      });
    }

    async function capture(ui) {
      if (busy) return;
      // A navigation may move controls before the coalesced observer runs.
      if (!ui.host.isConnected || ui.group.closest(PLAYER) !== ui.root) {
        scan();
        const current = mounts.get(ui.group);
        if (current && current !== ui) return capture(current);
        return;
      }
      const video = findVideo(ui.root);
      if (!video) { status.lastError = 'video-not-ready'; notify(ui, 'Wait for the video to load.'); return; }
      const width = video.videoWidth, height = video.videoHeight;
      if (width > 16384 || height > 16384 || width * height > 67108864) {
        status.lastError = 'frame-too-large'; notify(ui, 'This video frame is too large to capture.'); return;
      }
      busy = true;
      status.lastError = null;
      for (const mounted of mounts.values()) updateReady(mounted);
      const canvas = document.createElement('canvas');
      try {
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('canvas-unavailable');
        // Draw immediately on click, before async encoding; retain the clicked frame.
        context.drawImage(video, 0, 0, width, height);
        const blob = await png(canvas);
        status.captures++;
        status.lastFrame = { width, height };
        const address = URL.createObjectURL(blob);
        let anchor;
        try {
          anchor = document.createElement('a');
          anchor.href = address;
          anchor.download = filename();
          anchor.hidden = true;
          (document.body || document.documentElement).appendChild(anchor);
          anchor.click();
          status.downloadsRequested++;
        } finally {
          anchor?.remove();
          // Allow the browser download to consume the blob before freeing it.
          setTimeout(() => URL.revokeObjectURL(address), 60000);
        }
        notify(ui, 'Screenshot captured');
      } catch (error) {
        status.lastError = error?.name === 'SecurityError' ? 'capture-blocked' : 'capture-failed';
        notify(ui, status.lastError === 'capture-blocked'
          ? 'Screenshot unavailable for this video.' : 'Couldn’t capture the screenshot. Try again.');
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        busy = false;
        for (const mounted of mounts.values()) updateReady(mounted);
      }
    }

    function mount(group, root) {
      const reference = group.querySelector('[data-a-target="player-settings-button"]') ||
        group.querySelector(REFERENCE) || group.querySelector('button');
      const host = document.createElement('div');
      host.className = 'musa-twitch-screenshot-control';
      const button = document.createElement('button');
      // Keep Twitch's shared icon-button classes without copying native event/action attributes.
      if (reference) button.className = reference.className;
      button.type = 'button';
      button.setAttribute('data-a-target', 'musa-player-screenshot-button');
      button.setAttribute('aria-label', 'Screenshot');
      const tooltip = document.createElement('div');
      tooltip.className = 'musa-twitch-screenshot-tooltip';
      tooltip.id = `musa-twitch-screenshot-tooltip-${++sequence}`;
      tooltip.setAttribute('role', 'tooltip');
      tooltip.textContent = 'Screenshot';
      button.setAttribute('aria-describedby', tooltip.id);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 20 20');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('d', 'M6.5 3 5 5H2v12h16V5h-3l-1.5-2h-7Zm1 2h5L14 7h2v8H4V7h2l1.5-2ZM10 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z');
      svg.appendChild(path);
      button.appendChild(svg);
      host.append(button, tooltip);
      const notice = document.createElement('div');
      notice.className = 'musa-twitch-screenshot-notice';
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      notice.hidden = true;
      const ui = { group, root, host, button, tooltip, notice, noticeTimer: null };
      button.addEventListener('pointerdown', event => event.stopPropagation());
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        void capture(ui);
      });
      let anchor = reference;
      while (anchor && anchor.parentElement !== group) anchor = anchor.parentElement;
      group.insertBefore(host, anchor || group.firstChild);
      root.appendChild(notice);
      return ui;
    }

    function scan() {
      scheduled = false;
      if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
      for (const [group, ui] of mounts) {
        if (!group.isConnected || !ui.root.isConnected || !ui.host.isConnected ||
            ui.host.parentElement !== group || group.closest(PLAYER) !== ui.root) {
          clearTimeout(ui.noticeTimer);
          ui.host.remove();
          ui.notice.remove();
          mounts.delete(group);
        }
      }
      for (const group of document.querySelectorAll(GROUP)) {
        const root = group.closest(PLAYER);
        if (!root) continue;
        if (!mounts.has(group)) mounts.set(group, mount(group, root));
        const ui = mounts.get(group);
        for (const video of root.querySelectorAll('video')) {
          if (watchedVideos.has(video)) continue;
          watchedVideos.add(video);
          for (const event of ['loadeddata', 'loadedmetadata', 'resize', 'emptied', 'error']) {
            video.addEventListener(event, schedule);
          }
        }
        updateReady(ui);
      }
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      setTimeout(scan, 50);
    }
    // class/style/hidden changes in or above a player can show or hide its video.
    listen(batch => {
      if (batch.childList || batch.styled.some(target => target.closest?.(PLAYER) ||
          [...mounts.values()].some(ui => target.contains(ui.root)))) schedule();
    });
    document.addEventListener('fullscreenchange', schedule);
    scan();
});

export default screenshot;
