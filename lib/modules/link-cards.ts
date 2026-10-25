// @ts-nocheck
// Verbatim port of twitch-chat-link-cards.user.js 1.5.0, lines 27-726 (the body of its IIFE), with one change:
// the 'Also for chat history on join' option comes from the popup instead of localStorage.
// GM_xmlhttpRequest is replaced by gmRequest (lib/relay.ts), which has the background worker do the fetch.
// Its duplicate guard (window.__twitchChatLinkCards) is unchanged, so a still-installed userscript and this never both run.
import type { Module } from '../modules';
import { gmRequest } from '../relay';

const linkCards: Module = (options) => {
  const GM_xmlhttpRequest = gmRequest;
  'use strict';
  // Native flow (chat line renderer, module 355585 on 2026-10-24, minified names vary):
  //   switch (part.type) {
  //     case X.Link:     parts.push(link(...)); break;
  //     case X.ClipLink: card || opts.disableChatCard || (card = <ClipCard/>), parts.push(link(...)); break;
  //   }
  //   return card ? parts.concat(card) : parts;   // one card per message, after the text
  // The Link case gets the same card line as ClipLink. The card is Twitch's own presentational
  // ChatCard ({data, header, buttonSlot}), which draws its own skeleton while data is missing.
  // Source is rewritten only when every anchor matches; otherwise the module runs unchanged.
  // With any @grant other than none, the script's `window` is the manager's wrapper, not the page:
  // Twitch's chunk queue and the status object must go on the real page window.
  /* global unsafeWindow */
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (page.__twitchChatLinkCards) return;
  const status = page.__twitchChatLinkCards = {
    version: '1.5.0', state: 'starting', moduleId: null, requests: 0, resolved: 0, failed: 0, dropped: 0, lastError: null,
  };
  let disabled = false, includeHistory = false;
  try {
    disabled = localStorage.getItem('twitchChatLinkCards.disabled') === '1';
    includeHistory = options.history === true; // Twitch Plus: from the popup instead of localStorage
  } catch (_) {}
  if (disabled) { status.state = 'disabled'; return; }

  const KNOWN_ID = '355585';
  const MARKERS = ['"chat-card-title"', '.ClipLink:', '.Link:', 'disableChatCard', 'buttonSlot'];
  const RESOLVER = 'https://braize.pajlada.com/chatterino/link_resolver/';
  const CACHE_SIZE = 400, MAX_ACTIVE = 4, MAX_QUEUED = 20, TIMEOUT = 8000, PAGE_TIMEOUT = 6000, IMAGE_TIMEOUT = 1500;
  // Finished lookups survive reloads (bots repeat the same social links all stream).
  const STORE_KEY = 'twitchChatLinkCards.cache', STORE_SIZE = 300, CARD_TTL = 12 * 3600e3, MISS_TTL = 30 * 60e3;
  const ID = '[\\w$]+', REF = '[\\w$]+\\.[\\w$]+', ESC = s => s.replace(/[$.]/g, '\\$&');

  // ---- Source patch -------------------------------------------------------------------------

  // Returns the patched factory source, or null when any anchor is missing.
  function patchSource(source) {
    if (!MARKERS.every(marker => source.includes(marker))) return null;
    const card = new RegExp(`(?:let|const|var|,)\\s*(${ID})=\\(\\{data:${ID},error:${ID},header:${ID},buttonSlot:${ID}\\}\\)=>`).exec(source);
    const link = new RegExp(`case (${REF})\\.Link:(${ID})\\.push\\((${ID})\\((${ID}),(${ID}),(${ID})\\)\\);break;`).exec(source);
    if (!card || !link) return null;
    const [, enumRef, , , , part, opts] = link;
    const clip = new RegExp(`case ${ESC(enumRef)}\\.ClipLink:(${ID})\\|\\|${ESC(opts)}\\.disableChatCard\\|\\|\\(\\1=\\(0,(${ID})\\.jsx\\)`).exec(source);
    const react = new RegExp(`[^\\w$.](${ID})\\.useCallback\\(`).exec(source);
    if (!clip || !react) return null;
    const [, cardVar, jsx] = clip;
    // The clip card's "View" button: Layout > Button > text wrapper, with Twitch's own translation.
    const button = new RegExp(`\\(0,${ID}\\.jsx\\)\\((${REF}),\\{display:(${REF}\\.Flex),alignItems:(${REF}\\.Center),padding:1,children:\\(0,${ID}\\.jsx\\)\\((${REF}),\\{variant:"primary",size:"small",linkTo:${ID},targetBlank:!0,children:\\(0,${ID}\\.jsx\\)\\((${REF}),\\{children:(\\(0,${REF}\\)\\("View","ClipsChatCard"\\))\\}\\)\\}\\)\\}\\)`).exec(source);
    const deps = [`React:${react[1]}`, `jsx:${jsx}.jsx`, `Card:${card[1]}`];
    // The card's style switch (newer style: header row and View button). Optional: without it the
    // site name always goes in the description line.
    const style = new RegExp(`background:\\(0,(${REF})\\)\\(\\)\\?`).exec(source.slice(card.index, card.index + 4000));
    if (style) deps.push(`newStyle:()=>(0,${style[1]})()`);
    if (button) {
      const [, layout, flex, center, btn, text, view] = button;
      deps.push(`Layout:${layout}`, `flex:${flex}`, `center:${center}`, `Button:${btn}`, `ButtonText:${text}`, `view:()=>${view}`);
    }
    // Only names local to the renderer (card variable, part, options) are used inside it; module
    // names are handed over once at the end of the factory, where nothing shadows them.
    const caseStart = link.index + `case ${enumRef}.Link:`.length;
    const inserted = `${cardVar}||${opts}.disableChatCard||(${cardVar}=__linkCards.card(${part}.content.url,${opts})),`;
    let patched = source.slice(0, caseStart) + inserted + source.slice(caseStart);
    // The older card style links to contentURL plus Twitch's tt_ tracking parameters; link cards
    // (data.external) keep the posted URL. Optional: without the anchor the parameters stay.
    patched = patched.replace(
      new RegExp(`let (${ID})=\\(0,(${REF})\\)\\((${ID})\\.contentURL,(\\{tt_medium:"twitch_chat",tt_content:"chat_card"\\})\\)`),
      (_, url, track, data, params) => `let ${url}=${data}.external?${data}.contentURL:(0,${track})(${data}.contentURL,${params})`);
    const close = patched.lastIndexOf('}');
    patched = `${patched.slice(0, close)};__linkCards.bind({${deps.join(',')}});${patched.slice(close)}`;
    return patched;
  }

  function compile(source) {
    // Factories are `function(e,t,n){…}` or `(e,t,n)=>{…}`; a method shorthand needs a keyword.
    const text = /^\s*(?:function\b|\(|async\b)/.test(source) ? source : source.replace(/^\s*[\w$]+\s*(?=\()/, 'function');
    return new Function('__linkCards', `return (${text});`)(api);
  }

  function replaceFactory(factory, id) {
    if (typeof factory !== 'function' || wrapped.has(factory)) return factory;
    let source;
    try { source = Function.prototype.toString.call(factory); } catch (_) { return factory; }
    if (!source.includes('chat-card-title')) return factory;
    try {
      const patched = patchSource(source);
      if (!patched) { status.state = 'unsupported-build'; console.warn('[Twitch Chat Link Cards]', 'Chat renderer changed; left unchanged:', id); return factory; }
      const replacement = compile(patched);
      wrapped.add(replacement);
      Object.assign(status, { state: 'patched-awaiting-execution', moduleId: id });
      return replacement;
    } catch (error) {
      status.state = 'patch-failed';
      status.lastError = String(error);
      return factory;
    }
  }

  // ---- Card ---------------------------------------------------------------------------------

  let deps = null, LinkCard = null;
  const api = {
    bind(found) {
      if (typeof found?.React?.useState !== 'function' || typeof found.jsx !== 'function' || typeof found.Card !== 'function') {
        status.state = 'unsupported-runtime';
        return;
      }
      deps = found;
      LinkCard = createLinkCard();
      addStyles();
      status.state = 'active';
    },
    card(url, opts) {
      try {
        if (!deps || (opts?.isHistorical && !includeHistory) || !eligible(url)) return null;
        if ((cache.get(url) || fromStore(url))?.state === 'failed') return null;
        return deps.jsx(LinkCard, { url }, 'link-card');
      } catch (error) {
        status.lastError = String(error);
        return null;
      }
    },
  };

  function eligible(url) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return false; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    // Twitch links keep Twitch's own cards (clips, VODs) or none.
    const host = parsed.hostname.toLowerCase();
    return host !== 'twitch.tv' && !host.endsWith('.twitch.tv');
  }

  // Nothing is drawn until the data and its image are ready, so a link without a preview never
  // flashes a skeleton, and the card appears once at its final size.
  function createLinkCard() {
    const { React, jsx, Card } = deps;
    return function LinkCard({ url }) {
      // The cache entry is mutated in place, so a counter (not the entry) triggers the re-render.
      const [, setSettled] = React.useState(0);
      const entry = lookup(url);
      React.useEffect(() => {
        if (entry.state !== 'pending') return undefined;
        let live = true;
        entry.promise.then(() => { if (live) setSettled(n => n + 1); });
        return () => { live = false; };
      }, [entry]);
      if (entry.state !== 'done') return null;
      const { title, description, thumbnail, shape } = entry.preview;
      const site = siteName(url);
      const newStyle = deps.newStyle?.() ?? false;
      return jsx('div', {
        'data-link-card-shape': thumbnail ? shape : 'square',
        children: jsx(Card, {
          data: {
            title,
            description: newStyle ? description : [site, description].filter(Boolean).join(' · '),
            previewImageURL: thumbnail || PLACEHOLDER,
            previewImageAspectRatio: thumbnail ? SHAPES[shape] : 1,
            contentURL: url,
            external: true,
          },
          header: headerFor(site),
          buttonSlot: buttonFor(url),
        }),
      });
    };
  }

  function headerFor(site) {
    const { jsx, Layout, flex } = deps;
    return Layout ? jsx(Layout, { display: flex, flexDirection: 'row', gap: 1, children: site }) : site;
  }

  // Twitch's card has two fixed preview slots: 8 × 4.5rem (16:9) and 3.6 × 6.5rem (portrait), and
  // crops every image to fill them. Square images (album art, avatars, icons) get a 4.5rem square
  // slot instead; very wide ones (banners) are letterboxed rather than cut.
  const SHAPES = { landscape: 16 / 9, wide: 16 / 9, square: 1, portrait: 9 / 16 };
  function shapeOf(ratio) {
    if (ratio < 0.8) return 'portrait';
    if (ratio <= 1.25) return 'square';
    // Photos (OG's usual 1.91:1) fill the 16:9 slot; 2:1 and wider are usually text graphics.
    return ratio >= 1.95 ? 'wide' : 'landscape';
  }

  function addStyles() {
    const style = document.createElement('style');
    style.textContent = [
      '[data-link-card-shape="square"] [data-test-selector="chat-card-preview-container"] { width: 4.5rem !important; height: 4.5rem !important; }',
      '[data-link-card-shape="wide"] [data-test-selector="chat-card-preview-container"] img { object-fit: contain !important; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  const SITES = [
    [/(^|\.)youtube\.com$|^youtu\.be$/, 'YouTube'], [/^(x|twitter|fxtwitter|vxtwitter|fixupx|fixvx|twittpr)\.com$/, 'X'], [/(^|\.)spotify\.com$/, 'Spotify'],
    [/(^|\.)tiktok\.com$/, 'TikTok'], [/^github\.com$/, 'GitHub'], [/^discord\.(com|gg)$/, 'Discord'],
    [/(^|\.)reddit\.com$/, 'Reddit'], [/^soundcloud\.com$/, 'SoundCloud'], [/^kick\.com$/, 'Kick'],
    [/(^|\.)wikipedia\.org$/, 'Wikipedia'], [/^instagram\.com$/, 'Instagram'], [/^bsky\.app$/, 'Bluesky'],
  ];
  function siteName(url) {
    const host = bareHost(new URL(url).hostname);
    return (SITES.find(([pattern]) => pattern.test(host)) || [, host])[1];
  }
  const bareHost = host => host.toLowerCase().replace(/^(www|m|mobile)\./, '');

  function buttonFor(url) {
    const { jsx, Layout, flex, center, Button, ButtonText, view } = deps;
    if (Button) {
      return jsx(Layout, {
        display: flex, alignItems: center, padding: 1,
        children: jsx(Button, { variant: 'primary', size: 'small', linkTo: url, targetBlank: true, children: jsx(ButtonText, { children: view() }) }),
      });
    }
    return jsx('a', { href: url, target: '_blank', rel: 'noopener noreferrer', style: { display: 'block', padding: '1rem' }, children: 'View' });
  }

  // Square, for the square slot that image-less cards use.
  const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 90"><rect width="90" height="90" fill="#808080" fill-opacity=".18"/>'
    + '<g fill="none" stroke="#808080" stroke-width="5" stroke-linecap="round" transform="translate(27 27)">'
    + '<path d="M15 21a9 9 0 0 0 13 0l7-7a9 9 0 0 0-13-13l-2 2"/><path d="M21 15a9 9 0 0 0-13 0l-7 7a9 9 0 0 0 13 13l2-2"/></g></svg>');

  // ---- Resolver -----------------------------------------------------------------------------

  // url -> { state: 'pending' | 'done' | 'failed', promise, preview }; Map order doubles as LRU.
  const cache = new Map();
  const queue = [];
  let active = 0;

  function lookup(url) {
    let entry = cache.get(url);
    if (!entry && (entry = fromStore(url))) status.storeHits = (status.storeHits || 0) + 1;
    if (entry) { cache.delete(url); cache.set(url, entry); return entry; }
    entry = { state: 'pending', preview: null };
    entry.promise = new Promise(resolve => queue.push({ url, entry, resolve }));
    cache.set(url, entry);
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    // A burst keeps only the newest lookups; dropped ones are forgotten and retried if shown again.
    while (queue.length > MAX_QUEUED) {
      const old = queue.shift();
      old.entry.state = 'failed';
      cache.delete(old.url);
      status.dropped++;
      old.resolve();
    }
    pump();
    return entry;
  }

  function pump() {
    while (active < MAX_ACTIVE && queue.length) {
      const job = queue.pop();
      active++;
      status.requests++;
      const started = performance.now();
      resolve(job.url).then(preview => withShape(preview, job.url)).then(preview => {
        job.entry.preview = preview;
        job.entry.state = job.entry.preview ? 'done' : 'failed';
        status[job.entry.preview ? 'resolved' : 'failed']++;
        status.lastMs = Math.round(performance.now() - started);
        toStore(job.url, preview);
      }, () => {
        job.entry.state = 'failed';
        status.failed++;
      }).finally(() => {
        active--;
        job.resolve();
        pump();
      });
    }
  }

  // Saved lookups: url -> [savedAt, preview or 0 for "no card"]. Read once, written 2 s after the
  // last change. Network errors are not saved, so they are retried on the next load.
  let stored = null, storeTimer = 0;
  function loadStore() {
    if (stored) return stored;
    stored = new Map();
    try { for (const [url, value] of Object.entries(JSON.parse(localStorage.getItem(STORE_KEY) || '{}'))) stored.set(url, value); } catch (_) {}
    return stored;
  }
  function fromStore(url) {
    const saved = loadStore().get(url);
    if (!saved || Date.now() - saved[0] > (saved[1] ? CARD_TTL : MISS_TTL)) return null;
    return { state: saved[1] ? 'done' : 'failed', preview: saved[1] || null, promise: Promise.resolve() };
  }
  function toStore(url, preview) {
    const store = loadStore();
    store.delete(url);
    store.set(url, [Date.now(), preview ? { title: preview.title, description: preview.description, thumbnail: preview.thumbnail, shape: preview.shape } : 0]);
    clearTimeout(storeTimer);
    storeTimer = setTimeout(() => {
      const now = Date.now();
      const fresh = [...store].filter(([, [at, p]]) => now - at <= (p ? CARD_TTL : MISS_TTL)).slice(-STORE_SIZE);
      stored = new Map(fresh);
      try { localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(fresh))); } catch (_) {}
    }, 2000);
  }

  // The card is shown once the image's size is known (from its first bytes), not after the whole
  // download: the size picks the slot, the rest of the image fills in. A broken image falls back to
  // the placeholder instead of Twitch's own; a slow one keeps the provider's hint (or 16:9).
  // Where the shape never varies (fixedShape), there is nothing to wait for: the card shows as soon as
  // the lookup returns and the image loads inside it.
  async function withShape(preview, url) {
    if (!preview) return null;
    const thumbnail = preview.thumbnail && smaller(preview.thumbnail);
    const fixed = thumbnail && (preview.shape || fixedShape(url));
    if (fixed) return { ...preview, thumbnail, shape: fixed };
    const ratio = thumbnail ? await measure(thumbnail) : 0;
    if (ratio === 0) return { ...preview, thumbnail: null, shape: 'square' };
    return { ...preview, thumbnail, shape: shapeOf(ratio ?? 16 / 9) };
  }

  // Resolves width / height, 0 when the image fails, or null on timeout. Shared per image, so a
  // measurement started early (see predictThumbnail) is reused.
  const measuring = new Map();
  function measure(src) {
    if (measuring.has(src)) return measuring.get(src);
    const promise = new Promise(resolve => {
      const img = new Image();
      const done = value => { clearTimeout(timer); clearInterval(poll); img.onload = img.onerror = null; resolve(value); };
      const size = () => img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 0;
      const timer = setTimeout(() => done(null), IMAGE_TIMEOUT);
      const poll = setInterval(() => { if (size()) done(size()); }, 25);
      img.onload = () => done(size());
      img.onerror = () => done(0);
      img.src = src;
    });
    measuring.set(src, promise);
    if (measuring.size > 100) measuring.delete(measuring.keys().next().value);
    return promise;
  }

  // Direct images far larger than the 4.5–8rem slot get the site's own smaller size. Images via the
  // resolver's thumbnail proxy are already resized there (asking it for another size made them larger).
  const SMALLER = [
    [/^(https:\/\/yt3\.(?:googleusercontent|ggpht)\.com\/[^?#]*?=)s\d{3,4}(?=-)/, '$1s176'],   // channel avatar: 89 -> 12 KB
    [/^(https:\/\/i\d?\.sndcdn\.com\/artworks-[^?#]*?)-t500x500\./, '$1-t300x300.'],            // SoundCloud art: 36 -> 13 KB
  ];
  const smaller = src => SMALLER.reduce((url, [pattern, replacement]) => url.replace(pattern, replacement), src);

  // Sites whose preview image always has the same shape. Providers set `shape` themselves
  // (profile avatars and SoundCloud art are square; TikTok gives the video's size).
  function fixedShape(url) {
    const parsed = new URL(url);
    const host = bareHost(parsed.hostname);
    if (predictThumbnail(parsed, host)) return 'landscape';                         // YouTube video: 16:9 thumbnail
    if (host === 'open.spotify.com' || /^discord\.(com|gg)$/.test(host)) return 'square'; // album art, server icon
    return null;
  }

  // YouTube's thumbnail follows from the video ID, so it starts loading with the lookup instead of after it.
  function predictThumbnail(parsed, host) {
    let id = null;
    if (host === 'youtu.be') id = parsed.pathname.slice(1);
    else if (host === 'youtube.com') id = parsed.pathname === '/watch' ? parsed.searchParams.get('v') : (/^\/(?:shorts|live)\/([\w-]{11})/.exec(parsed.pathname) || [])[1];
    return id && /^[\w-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
  }

  // Sites the resolver handles poorly get their own lookup. When a lookup finds nothing, a provider
  // with `fallback` hands the link to the resolver; one without it means no card.
  // Hosts are compared without www./m./mobile. prefixes.
  const X_RESERVED = new Set(['home', 'explore', 'i', 'search', 'settings', 'notifications', 'messages', 'intent', 'share', 'hashtag', 'compose', 'login', 'signup', 'tos', 'privacy']);
  const PROVIDERS = [
    { match: (host, path) => (host === 'tiktok.com' || host.endsWith('.tiktok.com')) && /^\/@[\w.-]+\/?$/.test(path), resolve: tikTokProfile },
    { match: host => host === 'tiktok.com' || host.endsWith('.tiktok.com'), resolve: url => request(url).then(parseTikTok) },
    { match: (host, path) => (host === 'x.com' || host === 'twitter.com') && profileHandle(path) !== null, resolve: xProfile, fallback: true },
    { match: (host, path) => host === 'youtube.com' && /^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)(\/(featured|videos|streams|shorts))?\/?$/.test(path), resolve: youTubeChannel, fallback: true },
    { match: (host, path) => host === 'soundcloud.com' && /^\/[\w-]+\/[\w-]+\/?$/.test(path), resolve: soundCloud, fallback: true },
  ];

  // fxtwitter, vxtwitter & co. are X embed mirrors; the resolver knows some of them, X links all.
  const X_MIRRORS = /^(fxtwitter|vxtwitter|fixupx|fixvx|twittpr)\.com$/;

  async function resolve(url) {
    let parsed = new URL(url);
    if (X_MIRRORS.test(bareHost(parsed.hostname))) parsed = new URL(`https://x.com${parsed.pathname}${parsed.search}`);
    url = parsed.href;
    const host = bareHost(parsed.hostname);
    const guess = predictThumbnail(parsed, host);
    if (guess) measure(guess);
    const provider = PROVIDERS.find(p => p.match(host, parsed.pathname));
    if (provider) {
      const preview = await provider.resolve(url, parsed).catch(() => null);
      if (preview || !provider.fallback) return preview;
    }
    const preview = await request(RESOLVER + encodeURIComponent(url)).then(text => parse(text, url), () => null);
    return preview || readPage(url);
  }

  // When the resolver has nothing (it answers 404 or 500 for IMDb-, Genius- or Medium-style pages),
  // the page itself is fetched, without cookies, and its preview tags are read from <head> in an inert
  // document. This contacts the linked site directly; pages behind a script check or login give nothing.
  async function readPage(url) {
    if (fileOf(url)) return null;
    const response = await requestPage(url).catch(() => null);
    if (!response) return null;
    const head = response.text.slice(0, Math.max(response.text.search(/<\/head>/i), 0) || 400000);
    const doc = new DOMParser().parseFromString(head, 'text/html');
    const tag = (...keys) => {
      for (const key of keys) {
        const value = doc.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute('content');
        if (value && oneLine(value)) return oneLine(value);
      }
      return '';
    };
    const title = cleanTitle(tag('og:title', 'twitter:title') || oneLine(doc.querySelector('title')?.textContent), url);
    if (!title || BLOCKED_TITLE.test(title)) return null;
    let thumbnail = null;
    const image = tag('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src');
    try { thumbnail = image ? httpsOrNull(new URL(image, response.finalUrl || url).href) : null; } catch (_) {}
    return { title, description: tag('og:description', 'twitter:description', 'description').slice(0, 300), thumbnail };
  }

  // Like request(), but HTML only, and with the final URL after redirects.
  function requestPage(url) {
    const gm = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
      : typeof GM !== 'undefined' && typeof GM?.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null;
    if (!gm) return Promise.reject(new Error('GM_xmlhttpRequest unavailable'));
    return new Promise((resolve, reject) => {
      gm({
        method: 'GET', url, timeout: PAGE_TIMEOUT, anonymous: true,
        headers: { 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
        onload: response => {
          const html = /content-type:\s*[^\r\n]*(text\/html|xhtml)/i.test(response.responseHeaders || '');
          if (response.status === 200 && html) resolve({ text: response.responseText || '', finalUrl: response.finalUrl });
          else reject(new Error(`HTTP ${response.status}`));
        },
        onerror: () => reject(new Error('network')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  const compact = n => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  const counted = (n, label) => Number.isFinite(Number(n)) && Number(n) > 0 ? `${compact(Number(n))} ${label}` : null;
  const named = (name, handle) => name && name.toLowerCase() !== handle.toLowerCase() ? `${name} (@${handle})` : `@${handle}`;
  const httpsOrNull = url => typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
  const oneLine = text => typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  const profile = (title, facts, bio, thumbnail) => ({
    title: title.slice(0, 200),
    description: [...facts.filter(Boolean), oneLine(bio)].filter(Boolean).join(' · ').slice(0, 300),
    thumbnail,
    shape: 'square',
  });

  function profileHandle(path) {
    const match = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(path);
    return match && !X_RESERVED.has(match[1].toLowerCase()) ? match[1] : null;
  }

  // The resolver has no counts for X profiles. fxtwitter's public API does; it sometimes answers
  // "User not found" for a real account, which falls back to the resolver card (name and bio).
  async function xProfile(url, parsed) {
    const json = JSON.parse(await request(`https://api.fxtwitter.com/${profileHandle(parsed.pathname)}`));
    const user = json?.code === 200 ? json.user : null;
    if (typeof user?.screen_name !== 'string') return null;
    return profile(named(user.name, user.screen_name), [counted(user.followers, 'followers')], user.description, httpsOrNull(user.avatar_url)?.replace(/_normal(\.\w+)$/, '_200x200$1') || null);
  }

  // The channel page in English carries its header counts ("11K subscribers", "548 videos") and
  // og: tags; a consent or changed page falls back to the resolver card.
  async function youTubeChannel(url) {
    const html = await request(url, { 'Accept-Language': 'en-US,en;q=0.9' });
    const meta = name => {
      const match = new RegExp(`<meta property="og:${name}" content="([^"]*)"`).exec(html);
      return match ? decodeEntities(match[1]) : '';
    };
    const title = meta('title');
    if (!title) return null;
    const count = word => (new RegExp(`"content":"([^"]{1,30} ${word})"`).exec(html) || [])[1] || null;
    return profile(title, [count('subscribers')], meta('description'), httpsOrNull(meta('image')));
  }

  // Profile pages sit behind a script challenge, so the page JSON usually is missing; oEmbed still
  // gives the display name (no avatar or counts).
  async function tikTokProfile(url, parsed) {
    const handle = parsed.pathname.replace(/^\/@|\/$/g, '');
    const html = await request(url).catch(() => '');
    const match = /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    let info = null;
    try { info = match && JSON.parse(match[1]).__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo; } catch (_) {}
    if (typeof info?.user?.uniqueId === 'string') {
      const { user, stats } = info;
      return profile(named(user.nickname, user.uniqueId),
        [counted(stats?.followerCount, 'followers')], user.signature, httpsOrNull(user.avatarLarger || user.avatarMedium));
    }
    const json = JSON.parse(await request(`https://www.tiktok.com/oembed?url=${encodeURIComponent(`https://www.tiktok.com/@${handle}`)}`));
    if (typeof json?.author_name !== 'string') return null;
    return profile(named(json.author_name, handle), ['Profile'], '', null);
  }

  function decodeEntities(text) {
    return new DOMParser().parseFromString(`<!doctype html><body>${text}`, 'text/html').body.textContent || '';
  }

  function request(url, headers = {}) {
    /* global GM_xmlhttpRequest, GM */
    const gm = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
      : typeof GM !== 'undefined' && typeof GM?.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null;
    if (!gm) {
      status.lastError = 'GM_xmlhttpRequest unavailable';
      return Promise.reject(new Error(status.lastError));
    }
    return new Promise((resolve, reject) => {
      gm({
        method: 'GET', url, headers, timeout: TIMEOUT, anonymous: true,
        onload: response => (response.status === 200 ? resolve(response.responseText) : reject(new Error(`HTTP ${response.status}`))),
        onerror: () => reject(new Error('network')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  // The resolver returns Chatterino tooltip HTML, URL-encoded. It is parsed in an inert document
  // and only its text is used: the first segment is the title, the others the description.
  // A direct file link has no title there (only "URL: …"), so the file name and kind stand in.
  function parse(text, url) {
    let json;
    try { json = JSON.parse(text); } catch (_) { return null; }
    if (json?.status !== 200 || typeof json.tooltip !== 'string') return null;
    let html;
    try { html = decodeURIComponent(json.tooltip); } catch (_) { return null; }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const segments = [''];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) segments[segments.length - 1] += node.data;
      else if (node.nodeName === 'BR' || node.nodeName === 'HR') segments.push('');
    }
    // Some sources escape twice ("&#34;in real life&#34;").
    const clean = segments.map(s => oneLine(/&(#\d+|#x[\da-f]+|[a-z]+);/i.test(s) ? decodeEntities(s) : s))
      .filter(s => s && !/^URL:/i.test(s));
    const thumbnail = typeof json.thumbnail === 'string' && /^https:\/\//.test(json.thumbnail) ? json.thumbnail : null;
    const title = cleanTitle(clean.shift() || '', url);
    if (!title) {
      const file = fileOf(url);
      return file ? { title: file.name, description: file.kind, thumbnail } : null;
    }
    if (BLOCKED_TITLE.test(title)) return null;
    const description = clean.map(tidySegment).filter(Boolean).join(' · ').slice(0, 300);
    return { title: title.slice(0, 200), description, thumbnail };
  }

  // Challenge, login and error pages are not previews.
  const BLOCKED_TITLE = /^(just a moment\.*|attention required!?.*|access denied|security check|are you a robot\??|page not found|404( not found)?|not found|error|log ?in.*|sign ?in.*|instagram|reddit)$/i;

  const FILE_KINDS = [[/\.(png|jpe?g|gif|webp|avif|bmp)$/i, 'Image'], [/\.(mp4|webm|mov|mkv)$/i, 'Video'],
    [/\.(mp3|wav|ogg|flac|m4a)$/i, 'Audio'], [/\.pdf$/i, 'PDF'], [/\.(zip|rar|7z|exe|msi|dmg|apk)$/i, 'Download']];
  function fileOf(url) {
    const path = new URL(url).pathname;
    const kind = FILE_KINDS.find(([pattern]) => pattern.test(path));
    if (!kind) return null;
    let name = path.slice(path.lastIndexOf('/') + 1);
    try { name = decodeURIComponent(name); } catch (_) {}
    return { name: name.slice(0, 200), kind: kind[1] };
  }

  // A trailing title part that only names the site ("Creeper – Minecraft Wiki", "Hades on Steam",
  // "PJ Hyett – Medium") is dropped when one of its words (5+ letters) is part of the link's
  // domain. Leading parts are kept: on home pages they are the name ("The New York Times - …").
  // Sites in SITES are skipped: their titles are written by users ("Shortest Video on Youtube")
  // and have exact rules in TITLE_AFFIXES.
  const SEPARATOR = / [|–—•·-] /g;
  function trimSiteName(title, url) {
    const host = bareHost(new URL(url).hostname);
    if (SITES.some(([pattern]) => pattern.test(host))) return title;
    const labels = host.split(/[.-]/);
    const namesSite = part => {
      const words = part.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      return words.length <= 4 && words.some(word => word.length >= 5 && labels.some(label => label.includes(word)));
    };
    const cuts = [...title.matchAll(SEPARATOR)];
    let trimmed = title;
    const last = cuts[cuts.length - 1];
    if (last && namesSite(title.slice(last.index + last[0].length))) trimmed = title.slice(0, last.index);
    const on = / on ([^ ].{1,24})$/.exec(trimmed);
    if (on && namesSite(on[1])) trimmed = trimmed.slice(0, on.index);
    const watch = /^Watch "(.+)"$/.exec(trimmed);                                   // Streamable
    return watch ? watch[1] : trimmed;
  }

  // The site name is shown separately (description or header), so site affixes are dropped.
  const TITLE_AFFIXES = [
    / on X$/,                                                        // "Name (@handle) on X"
    / - YouTube$/,
    /^GitHub - /,
    / Live Stream - Watch Live on KICK$/i,
    / \| Spo(tify|…)$/,
  ];
  function cleanTitle(title, url) {
    // Spotify albums: "Listen to Random Access Memories - Album by Daft Punk | Spotify".
    const listen = /^Listen to (.+?) - (?:Album|Single|EP|Compilation|Playlist|Song) by /.exec(title);
    if (listen) return listen[1].slice(0, 200);
    const known = TITLE_AFFIXES.reduce((text, affix) => text.replace(affix, ''), title).trim();
    return (known && url ? trimSiteName(known, url) : known).trim().slice(0, 200);
  }

  // Resolver detail lines, rewritten for one line in chat. Known labels are shortened; dates,
  // perks and links are dropped. Anything unrecognised stays as it is.
  function tidySegment(segment) {
    let match;
    if (/^(URL|Server Perks|Server Created|Published|Created):/i.test(segment)) return null;
    if (/^Channel: #/.test(segment)) return null;                                   // Discord invite channel
    if (/likes? • .*comments?$/i.test(segment)) return null;                        // YouTube likes • comments
    if ((match = /^Members: ([\d,.]+) online • ([\d,.]+) total$/i.exec(segment))) return `${match[1]} online · ${match[2]} members`;
    if ((match = /^(?:Channel|Uploader|Author): (.+)$/i.exec(segment))) return match[1];
    if ((match = /^Duration: (\d+):(\d+):(\d+)$/i.exec(segment))) {
      const [h, m, s] = match.slice(1).map(Number);
      return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
    }
    if ((match = /^Views: ([\d.]+)([KMB]?)$/i.exec(segment))) {
      return counted(Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2].toUpperCase()] || 1), 'views');
    }
    if (/^Contribute to .+ development by creating an account on GitHub\.$/.test(segment)) return null;
    if (/^Watch .+ on [\w.]+\.?$/i.test(segment)) return null;                     // "Watch "…" on Streamable."
    if ((match = /^Watch .+? live on KICK, plus VODs, clips and highlights from every stream\. (?:([\d.,]+[KMB]? followers)\. )?(.*)$/i.exec(segment))) {
      return [match[1], match[2]].filter(Boolean).join(' · ');
    }
    // Spotify lists the content type ("Rick Astley · Album · Song · 1987"); the type adds nothing.
    return segment.split(' · ').filter(part => !/^(song|album|single|ep|playlist|compilation|artist)$/i.test(part)).join(' · ');
  }

  // SoundCloud's resolver result is only "SoundCloud - Hear the world's sounds"; its oEmbed has the
  // track, artist and square artwork.
  async function soundCloud(url) {
    const json = JSON.parse(await request(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`));
    if (typeof json?.title !== 'string') return null;
    const author = oneLine(json.author_name);
    const title = author ? json.title.replace(new RegExp(` by ${author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '') : json.title;
    return { title: oneLine(title).slice(0, 200), description: author, thumbnail: httpsOrNull(json.thumbnail_url), shape: 'square' };
  }

  // TikTok's resolver result is only "TikTok - Make Your Day" and its oEmbed has no title or image,
  // but the video page (fetched without cookies; short links redirect to it) embeds the post as JSON.
  // Only video pages qualify; profiles and anything unparsable get no card.
  function parseTikTok(html) {
    const match = /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!match) return null;
    let item;
    try { item = JSON.parse(match[1]).__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct; } catch (_) { return null; }
    const handle = item?.author?.uniqueId;
    if (typeof handle !== 'string' || !handle) return null;
    const name = item.author.nickname && item.author.nickname !== handle ? `${item.author.nickname} (@${handle})` : `@${handle}`;
    const plays = Number(item.stats?.playCount);
    const description = Number.isFinite(plays) && plays > 0
      ? `${name} · ${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(plays)} plays` : name;
    const cover = [item.video?.cover, item.video?.originCover].find(u => typeof u === 'string' && /^https:\/\//.test(u)) || null;
    const width = Number(item.video?.width), height = Number(item.video?.height);
    return {
      title: (typeof item.desc === 'string' && item.desc.trim() || `TikTok by @${handle}`).replace(/\s+/g, ' ').slice(0, 200),
      description,
      thumbnail: cover,
      shape: shapeOf(width > 0 && height > 0 ? width / height : 9 / 16),
    };
  }

  // ---- Module hook ----------------------------------------------------------------------------

  // Capture the native runtime through a harmless empty chunk, as Preferred Quality does, so
  // Rewind's push hook is left alone. The renderer is caught by its known module ID, or by
  // fingerprint in chunks loaded later (in case the ID changes).
  const wrapped = new WeakSet();
  const chunks = page.webpackChunktwitch_twilight = page.webpackChunktwitch_twilight || [];
  if (!Array.isArray(chunks)) { status.state = 'unsupported-runtime'; return; }
  chunks.push([['userscript:chat-link-cards:1.5.0'], {}, require => {
    if (!require.m || typeof require.e !== 'function') { status.state = 'unsupported-runtime'; return; }
    const descriptor = Object.getOwnPropertyDescriptor(require.m, KNOWN_ID);
    if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) status.state = 'module-hook-conflict';
    else {
      let factory = descriptor ? replaceFactory(descriptor.value, KNOWN_ID) : undefined;
      Object.defineProperty(require.m, KNOWN_ID, {
        enumerable: true, configurable: true,
        get: () => factory,
        set: value => { factory = replaceFactory(value, KNOWN_ID); },
      });
    }
    const seen = new Set(Object.keys(require.m));
    const scan = () => {
      if (status.moduleId) return;
      for (const id of Object.keys(require.m)) {
        if (seen.has(id)) continue;
        seen.add(id);
        const descriptor = Object.getOwnPropertyDescriptor(require.m, id);
        if (!descriptor || !('value' in descriptor) || !descriptor.writable) continue;
        const replacement = replaceFactory(descriptor.value, id);
        if (replacement !== descriptor.value) require.m[id] = replacement;
      }
    };
    // Runs before the importer's own .then(), so a fingerprinted module is replaced before it executes.
    const ensure = require.e;
    require.e = function (...args) {
      return Reflect.apply(ensure, this, args).then(value => {
        try { scan(); } catch (error) { status.lastError = String(error); }
        return value;
      });
    };
    if (status.state === 'starting') status.state = 'waiting-for-module';
  }]);
};

export default linkCards;
