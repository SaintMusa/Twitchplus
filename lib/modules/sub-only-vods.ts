// @ts-nocheck
/*
 * Based on TwitchNoSub 0.9.3, https://github.com/besuper/TwitchNoSub
 * Copyright besuper and contributors. Licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Changed: the worker patch is bundled instead of loaded from a CDN,
 * and this extension's setting switches it.
 */
// Sub-only VODs: Twitch's player worker is wrapped so a failed VOD playlist request (usher) is answered with a
// playlist built from the VOD's storyboard URL. The worker code comes from the patch function's source text
// (toString), hence the unminified build (wxt.config.ts).
import { whenRoot } from '../page-observer';
import type { Module } from '../modules';

// Runs inside Twitch's player worker, ahead of Twitch's own worker code.
function workerPatch() {
  async function fetchTwitchDataGQL(vodID) {
      const resp = await fetch("https://gql.twitch.tv/gql", {
          method: 'POST',
          body: JSON.stringify({
              "query": "query { video(id: \"" + vodID + "\") { broadcastType, createdAt, seekPreviewsURL, owner { login } }}"
          }),
          headers: {
              'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
              'Accept': 'application/json',
              'Content-Type': 'application/json'
          }
      });

      return resp.json();
  }

  function createServingID() {
      const w = "0123456789abcdefghijklmnopqrstuvwxyz".split("");
      let id = "";

      for (let i = 0; i < 32; i++) {
          id += w[Math.floor(Math.random() * w.length)];
      }

      return id;
  }

  const defaultResolutions = (() => {
      const _defaultResolutions = {
          "160p30": {
              "name": "160p",
              "resolution": "284x160",
              "frameRate": 30
          },
          "360p30": {
              "name": "360p",
              "resolution": "640x360",
              "frameRate": 30
          },
          "480p30": {
              "name": "480p",
              "resolution": "854x480",
              "frameRate": 30
          },
          "720p60": {
              "name": "720p60",
              "resolution": "1280x720",
              "frameRate": 60
          },
          "1080p60": {
              "name": "1080p60",
              "resolution": "1920x1080",
              "frameRate": 60
          },
          "1440p60": {
              "name": "1440p60",
              "resolution": "2560x1440",
              "frameRate": 60
          },
          "chunked": {
              "name": "chunked",
              "resolution": "chunked",
              "frameRate": 60
          }
      };

      let sorted_dict = Object.keys(_defaultResolutions);
      sorted_dict = sorted_dict.reverse();

      let ordered_resolutions = {};

      for (const key in sorted_dict) {
          ordered_resolutions[sorted_dict[key]] = _defaultResolutions[sorted_dict[key]];
      }

      return ordered_resolutions;
  })();

  async function isValidQuality(url) {
      const response = await fetch(url, {
          cache: "force-cache"
      });

      if (response.ok) {
          const data = await response.text();

          if (data.includes(".ts")) {
              // ts files should still use the h264
              return { codec: "avc1.4D001E" };
          }

          if (data.includes(".mp4")) {
              // mp4 file use h265, but sometimes h264
              const mp4Request = await fetch(url.replace("index-dvr.m3u8", "init-0.mp4"), { cache: "force-cache" });

              if (mp4Request.ok) {
                  const content = await mp4Request.text();

                  return { codec: content.includes("hev1") ? "hev1.1.6.L93.B0" : "avc1.4D001E" };
              }

              return { codec: "hev1.1.6.L93.B0" };
          }
      }

      return null;
  }

  const oldFetch = self.fetch;

  self.fetch = async function (input, opt) {
      let url = input instanceof Request ? input.url : input.toString();
      let response = await oldFetch(input, opt);

      // Patch playlist from unmuted to muted segments
      if (url.includes("cloudfront") && url.includes(".m3u8")) {
          const body = await response.text();

          return new Response(body.replace(/-unmuted/g, "-muted"), { status: 200 });
      }

      if (url.startsWith("https://usher.ttvnw.net/vod/")) {
          console.log(`[TNS] Usher request intercepted (status ${response.status}): ${url}`);

          if (response.status != 200) {
              const isUsherV2 = url.includes("/vod/v2");

              console.log(`[TNS] Detected usher ${isUsherV2 ? 'v2' : 'v1'}`);

              const splitUsher = url.split(".m3u8")[0].split("/");

              const vodId = splitUsher.at(-1);

              const data = await fetchTwitchDataGQL(vodId);

              if (!data || !data?.data?.video) {
                  console.log("[TNS] Unable to fetch twitch data API", data);
                  return new Response("Unable to fetch twitch data API", { status: 403 });
              }

              console.log(`[TNS] Found data for VOD ${vodId}`);

              const vodData = data.data.video;
              const channelData = vodData.owner;

              // Twitch sometimes returns a null seekPreviewsURL (e.g. storyboards disabled),
              // which previously crashed the whole patch. Log clearly so the failure is diagnosable.
              if (!vodData.seekPreviewsURL) {
                  console.log("[TNS] seekPreviewsURL is missing, cannot build playlist", vodData);
                  return new Response("Missing seekPreviewsURL", { status: 403 });
              }

              const currentURL = new URL(vodData.seekPreviewsURL);

              const domain = currentURL.host;
              const paths = currentURL.pathname.split("/");
              const vodSpecialID = paths[paths.findIndex(element => element.includes("storyboards")) - 1];

              console.log(`[TNS] Channel: ${channelData?.login}, broadcastType: ${vodData.broadcastType}, domain: ${domain}, vodSpecialID: ${vodSpecialID}`);

              let fakePlaylist = `#EXTM3U
#EXT-X-TWITCH-INFO:ORIGIN="s3",B="false",REGION="EU",USER-IP="127.0.0.1",SERVING-ID="${createServingID()}",CLUSTER="cloudfront_vod",USER-COUNTRY="BE",MANIFEST-CLUSTER="cloudfront_vod"`;

              const now = new Date("2023-02-10");
              const created = new Date(vodData.createdAt);

              const time_difference = now.getTime() - created.getTime();
              const days_difference = time_difference / (1000 * 3600 * 24);

              const broadcastType = vodData.broadcastType.toLowerCase();

              let startQuality = 8534030;

              for (const [resKey, resValue] of Object.entries(defaultResolutions)) {
                  let playlistUrl = undefined;

                  if (broadcastType === "highlight") {
                      playlistUrl = `https://${domain}/${vodSpecialID}/${resKey}/highlight-${vodId}.m3u8`;
                  } else if (broadcastType === "upload" && days_difference > 7) {
                      // Only old uploaded VOD works with this method now

                      playlistUrl = `https://${domain}/${channelData.login}/${vodId}/${vodSpecialID}/${resKey}/index-dvr.m3u8`;
                  } else {
                      playlistUrl = `https://${domain}/${vodSpecialID}/${resKey}/index-dvr.m3u8`;
                  }

                  if (!playlistUrl) continue;

                  const result = await isValidQuality(playlistUrl);

                  if (result) {
                      console.log(`[TNS] Found quality ${resKey}`);

                      if (isUsherV2) {
                          const variantSource = resKey == "chunked" ? "source" : "transcode";

                          fakePlaylist += `
#EXT-X-STREAM-INF:BANDWIDTH=${startQuality},CODECS="${result.codec},mp4a.40.2",RESOLUTION=${resValue.resolution},FRAME-RATE=${resValue.frameRate},STABLE-VARIANT-ID="${resKey}",IVS-NAME="${resValue.name}",IVS-VARIANT-SOURCE="${variantSource}"
${playlistUrl}`;
                      } else {
                          const enabled = resKey == "chunked" ? "YES" : "NO";

                          fakePlaylist += `
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${resKey}",NAME="${resKey}",AUTOSELECT=${enabled},DEFAULT=${enabled}
#EXT-X-STREAM-INF:BANDWIDTH=${startQuality},CODECS="${result.codec},mp4a.40.2",RESOLUTION=${resValue.resolution},VIDEO="${resValue.name}",FRAME-RATE=${resValue.frameRate}
${playlistUrl}`;
                      }

                      startQuality -= 100;
                  }
              }

              if (!fakePlaylist.includes("#EXT-X-STREAM-INF")) {
                  console.log("[TNS] No valid quality found, the VOD CDN structure may have changed", { domain, vodSpecialID, broadcastType, login: channelData?.login });
                  return new Response("No valid quality found", { status: 403 });
              }

              const header = new Headers();
              header.append('Content-Type', 'application/vnd.apple.mpegurl');

              console.log("[TNS] Serving generated playlist");
              try { new BroadcastChannel('twitch-plus-sub-only-vod').postMessage({ vodId }); } catch (e) {}

              return new Response(fakePlaylist, { status: 200, headers: header });
          }
      }

      return response;
  }
}

const subOnlyVods: Module = () => {
  const ready = whenRoot;
  const OldWorker = window.Worker;
  const patch = `(${workerPatch.toString()})();`;

  // vaft (lib/modules/vaft-*.ts) recognises this wrapper by the "besuper/" text in its source and keeps it on top of
  // its own, so the two work together in either start order.
  window.Worker = class Worker extends OldWorker {
    constructor(twitchBlobUrl, options) {
      let isTwitchWorker = false;
      try {
        isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith('.twitch.tv');
      } catch {}
      if (!isTwitchWorker) {
        super(twitchBlobUrl, options);
        return;
      }
      const patchSource = 'https://github.com/besuper/TwitchNoSub';
      const req = new XMLHttpRequest();
      req.open('GET', String(twitchBlobUrl), false);
      req.overrideMimeType('text/javascript');
      req.send();
      super(URL.createObjectURL(new Blob([`// sub-only VOD patch from ${patchSource}
${patch}
${req.responseText}`])), options);
    }
  };

  // Sub-only marks. On cards, Twitch's own restriction overlay (it only exists on restricted videos) becomes a small
  // pill instead of covering the thumbnail. In the player, a notice shows briefly once the patch has served the playlist.
  const TOAST = 'twitch-plus-sub-only-toast';
  const css = `
    .video-preview-card-restriction {
      position: absolute !important; inset: 6px 6px auto auto !important; width: auto !important; height: auto !important;
      padding: 0 6px !important; display: inline-flex !important; flex-flow: row nowrap !important;
      align-items: center !important; justify-content: flex-start !important; gap: 4px;
      background: rgba(0, 0, 0, 0.6) !important; border-radius: 4px; pointer-events: none !important;
      color: #fff; font-size: 12px; font-weight: 600; line-height: 20px; white-space: nowrap; z-index: 1;
    }
    .video-preview-card-restriction > * { display: none !important; }
    .video-preview-card-restriction::before, #${TOAST}::before {
      content: ''; flex: none; width: 12px; height: 12px; background: currentColor;
      -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath d='M14 8V6a4 4 0 1 0-8 0v2H4v10h12V8h-2zM8 6a2 2 0 1 1 4 0v2H8V6z'/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath d='M14 8V6a4 4 0 1 0-8 0v2H4v10h12V8h-2zM8 6a2 2 0 1 1 4 0v2H8V6z'/%3E%3C/svg%3E") center / contain no-repeat;
    }
    .video-preview-card-restriction::after { content: 'Sub-only'; }
    #${TOAST} {
      position: absolute; top: 10px; left: 10px; z-index: 10; display: flex; align-items: center; gap: 8px;
      max-width: 28rem; padding: 6px 4px 6px 10px; background: rgba(0, 0, 0, 0.8); color: var(--color-text-overlay, #fff);
      border: 1px solid var(--color-border-overlay, rgba(255, 255, 255, 0.22)); border-radius: var(--border-radius-medium, 0.4rem);
      font-family: var(--font-base, inherit); font-size: 13px; line-height: 1.4; transition: opacity 0.3s ease, transform 0.3s ease;
    }
    #${TOAST}.hiding { opacity: 0; transform: translateY(-4px); }
    #${TOAST} button {
      flex: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px; background: none; color: inherit;
      font-size: 18px; line-height: 24px; cursor: pointer;
    }
    #${TOAST} button:hover { background: var(--color-opac-w-4, rgba(255, 255, 255, 0.16)); }`;

  // The patch (inside the player's worker) announces each VOD it serves; only same-origin pages hear this channel.
  // The notice shows once per VOD, a few seconds after playback starts, then fades (or is dismissed).
  const pendingVodIds = new Set();
  const vodIdOnPage = () => location.pathname.match(/^\/videos\/(\d+)/)?.[1];
  const hideToast = (toast) => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  };
  const syncToast = () => {
    const id = vodIdOnPage();
    const existing = document.getElementById(TOAST);
    if (existing && existing.dataset.vod !== id) existing.remove();
    if (!id || !pendingVodIds.has(id)) return;
    const host = document.querySelector('.video-player__container');
    if (!host) return;
    pendingVodIds.delete(id);
    const toast = document.createElement('div');
    toast.id = TOAST;
    toast.dataset.vod = id;
    toast.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = 'This is a subscriber-only VOD, played without a subscription.';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = '×';
    dismiss.setAttribute('aria-label', 'Dismiss sub-only notice');
    dismiss.onclick = () => hideToast(toast);
    toast.append(text, dismiss);
    host.appendChild(toast);
    setTimeout(() => toast.isConnected && hideToast(toast), 8000);
  };
  try {
    new BroadcastChannel('twitch-plus-sub-only-vod').onmessage = (event) => {
      pendingVodIds.add(String(event.data?.vodId));
      syncToast();
    };
  } catch {}
  // Twitch is a single-page app: the player is rebuilt and the address changes without a reload.
  setInterval(syncToast, 1000);

  ready(() => {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  });
};

export default subOnlyVods;
