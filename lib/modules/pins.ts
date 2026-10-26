// @ts-nocheck
// Verbatim port of the pins feature of Twitch Native UI 1.3.0 (was Twitch Native Pins 2.5.1), lines 691-1438 of the userscript.
// Kept unchanged so fixes can be compared line by line with the userscript; adding types is a later refactor.
// Its own duplicate guard and storage keys are unchanged, so a still-installed userscript and this never both run.
import type { Module } from '../modules';
import { listen, whenRoot } from '../page-observer';

// Native UI started its features only once <html> existed (its startAll); whenRoot keeps that.
const pins: Module = () => whenRoot(() => {
    if (typeof window.__twitchNativePinsReport === 'function') return;
    const VERSION = '2.5.1';
    const STORE = 'twitchNativePins.channels';
    const FOLDERS = 'twitchNativePins.folders';
    const OPTIONS = 'twitchNativePins.options';
    const IMPORTED = 'twitchNativePins.enhancerImported';
    const SECTION = '#side-nav .side-nav-section';
    const BUTTON = 'musa-twitch-pin-button';
    const FOLDER_BUTTON = 'musa-twitch-folder-button';
    // A game needs this many live channels to get its own folder; the rest stay in the main list.
    const MIN_CATEGORY_SIZE = 2;
    // A category folder with more live channels than this shows only this many, with Twitch's Show More.
    const CATEGORY_SHOWN = 5;
    const PENDING = 'musa-twitch-pins-pending';
    const hooked = new WeakSet();
    // The groups each hooked Followed component last drew, by React key; DOM sections are matched to them
    // through their fiber's key, so a section Twitch fails to draw cannot shift the others.
    const layouts = new WeakMap();
    // Folder headers are not sort menus: Twitch disables the sort button when the type is "unknown".
    const NO_SORT = 'unknown';
    const Nothing = () => null;
    let pins, folders, options;
    load();
    let scheduled = false;
    let menu = null;
    let drawn = false;
    // Hide the plain list until our first render; never longer than a moment if something goes wrong.
    document.documentElement.classList.add(PENDING);
    let reveal = null;

    window.__twitchNativePinsReport = () => ({
      version: VERSION, pinned: pins.length, folders: folders.map(folder => `${folder.name} (${folder.members.length})`),
      byCategory: options.byCategory, hookedSections: sections().filter(({ node }) => hooked.has(node)).length,
    });

    const ICONS = {
      folder: 'M2 4h6l2 2h8v10H2V4Zm2 2v8h12V8H9.2l-2-2H4Z',
      chevron: 'M5.5 7.5 10 12l4.5-4.5L16 9l-6 6-6-6 1.5-1.5Z',
      more: 'M4 10a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Zm4.5 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Zm4.5 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z',
      category: 'M3 3h6v6H3V3Zm2 2v2h2V5H5Zm6-2h6v6h-6V3Zm2 2v2h2V5h-2ZM3 11h6v6H3v-6Zm2 2v2h2v-2H5Zm6-2h6v6h-6v-6Zm2 2v2h2v-2h-2Z',
      check: 'M8 13.2 4.8 10l-1.4 1.4L8 16l9-9-1.4-1.4L8 13.2Z',
    };

    const style = document.createElement('style');
    style.id = 'musa-twitch-native-pins-style';
    style.textContent = `
      .${BUTTON},.${FOLDER_BUTTON}{position:absolute;bottom:-.6rem;z-index:2;display:none;align-items:center;
        justify-content:center;width:1.6rem;height:1.6rem;padding:0;border:0;border-radius:.3rem;
        background:rgba(0,0,0,.6);color:#fff;font-size:1.2rem;line-height:1;cursor:pointer;appearance:none}
      .${BUTTON}{left:-.4rem}
      .${FOLDER_BUTTON}{right:-.4rem}
      .${FOLDER_BUTTON} svg{width:1.2rem;height:1.2rem;fill:currentColor}
      .${BUTTON}:hover,.${FOLDER_BUTTON}:hover{background:rgba(0,0,0,.8)}
      .${BUTTON}[aria-pressed="true"]{display:inline-flex;background:var(--color-background-button-primary-default,#9147ff)}
      .${BUTTON}[aria-pressed="true"]:hover{background:var(--color-background-button-primary-hover,#772ce8)}
      .${BUTTON}:focus-visible,.${FOLDER_BUTTON}:focus-visible{display:inline-flex;
        outline:2px solid var(--color-border-interactable-focus,#a970ff)}
      .side-nav-card:hover .${BUTTON},.side-nav-card:hover .${FOLDER_BUTTON}{display:inline-flex}
      .musa-twitch-pin-avatar{position:relative}
      /* The Enhancer extension draws its own pin star in the same spot, above ours, so clicks pinned channels in
         Enhancer instead of here. Hide it in the sidebar; the one-time import still reads its text. */
      #side-nav .pin-streamer-button{display:none!important}
      .musa-twitch-section-tools{position:absolute;right:.5rem;top:50%;transform:translateY(-50%);
        display:inline-flex;gap:.2rem;align-items:center}
      .musa-twitch-section-header{position:relative}
      /* Until the first grouped render lands, keep Twitch's plain Followed list hidden so it never jumps. */
      html.${PENDING} #side-nav .side-nav-section:has(.followed-side-nav-header,a[data-test-selector="followed-channel"]){visibility:hidden}
      /* The rest of the list under the pins has a blank title; hide its header so it reads as one list. */
      #side-nav .side-nav-section[aria-label=""] .followed-side-nav-header,
      #side-nav .side-nav-section[aria-label=""] [data-a-target="side-nav-header-collapsed"]{display:none!important}
      /* Folder headers keep Twitch's sort button, disabled by the "unknown" sort type; hide its icon. */
      .followed-side-nav-header button:disabled .followed-side-nav-header__dropdown-trigger > :last-child{display:none!important}
      .musa-twitch-tool{display:inline-flex;align-items:center;justify-content:center;width:2.4rem;height:2.4rem;
        padding:0;border:0;border-radius:.4rem;background:transparent;color:var(--color-text-alt-2,#adadb8);
        cursor:pointer;appearance:none}
      .musa-twitch-tool:hover{background:var(--color-background-interactable-hover,rgba(83,83,95,.48));
        color:var(--color-text-base,#efeff1)}
      .musa-twitch-tool:focus-visible{outline:2px solid var(--color-border-interactable-focus,#a970ff)}
      .musa-twitch-tool[aria-pressed="true"]{color:var(--color-text-link,#bf94ff)}
      .musa-twitch-tool svg{width:1.6rem;height:1.6rem;fill:currentColor;pointer-events:none}
      .musa-twitch-tool--chevron svg{transition:transform .15s ease}
      .musa-twitch-tool--chevron[aria-expanded="false"] svg{transform:rotate(-90deg)}
      .musa-twitch-tool--hover{visibility:hidden}
      .musa-twitch-live-count{display:inline-flex;align-items:center;gap:.4rem;padding:0 .4rem;
        color:var(--color-text-alt-2,#adadb8);font-size:1.2rem;font-weight:600;font-variant-numeric:tabular-nums}
      .musa-twitch-live-count[hidden]{display:none}
      .musa-twitch-live-count__dot{width:.8rem;height:.8rem;border-radius:50%;background:var(--color-fill-live,#eb0400)}
      .musa-twitch-section-header:hover .musa-twitch-tool--hover,
      .musa-twitch-section-header:focus-within .musa-twitch-tool--hover{visibility:visible}
      .musa-twitch-menu{position:fixed;z-index:5000;min-width:20rem;max-width:28rem;padding:.5rem;
        border-radius:.6rem;background:var(--color-background-base,#18181b);color:var(--color-text-base,#efeff1);
        box-shadow:0 4px 12px rgba(0,0,0,.5),0 0 0 1px var(--color-border-base,rgba(83,83,95,.48));
        font-family:inherit;font-size:1.3rem}
      .musa-twitch-menu__item{display:flex;align-items:center;gap:.8rem;width:100%;padding:.5rem .8rem;
        border:0;border-radius:.4rem;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
      .musa-twitch-menu__item:hover,.musa-twitch-menu__item:focus-visible{outline:none;
        background:var(--color-background-interactable-hover,rgba(83,83,95,.48))}
      .musa-twitch-menu__item--danger{color:var(--color-text-error,#ff8280)}
      .musa-twitch-menu__item svg{width:1.6rem;height:1.6rem;fill:currentColor;flex:none}
      .musa-twitch-menu__spacer{width:1.6rem;flex:none}
      .musa-twitch-menu__label{padding:.5rem .8rem .3rem;color:var(--color-text-alt-2,#adadb8);font-size:1.2rem;font-weight:600}
      .musa-twitch-menu__divider{height:1px;margin:.5rem 0;background:var(--color-border-base,rgba(83,83,95,.48))}
      .musa-twitch-menu__input{box-sizing:border-box;width:100%;margin:.3rem 0;padding:.5rem .8rem;border-radius:.4rem;
        border:2px solid var(--color-border-input,rgba(83,83,95,.48));background:var(--color-background-input,#18181b);
        color:inherit;font:inherit}
      .musa-twitch-menu__input:focus{outline:none;border-color:var(--color-border-input-focus,#a970ff)}
    `;

    function read(key, fallback) {
      try {
        const value = JSON.parse(localStorage.getItem(key) || 'null');
        return value && typeof value === 'object' ? value : fallback;
      } catch { return fallback; }
    }

    function write(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    }

    const isPinned = id => pins.some(pin => pin.id === id);
    const folderOf = id => folders.find(folder => folder.members.includes(id)) || null;

    function svg(name) {
      const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      element.setAttribute('viewBox', '0 0 20 20');
      element.setAttribute('aria-hidden', 'true');
      element.setAttribute('focusable', 'false');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('d', ICONS[name]);
      element.appendChild(path);
      return element;
    }

    function fiberOf(element) {
      if (!element) return null;
      for (const key in element) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return element[key];
      }
      return null;
    }

    function findChild(fiber, test, depth = 0) {
      if (!fiber || depth > 25) return null;
      try { if (test(fiber)) return fiber; } catch {}
      return findChild(fiber.child, test, depth + 1) || findChild(fiber.sibling, test, depth + 1);
    }

    function findParent(fiber, test, depth = 0) {
      for (; fiber && depth <= 100; fiber = fiber.return, depth++) {
        try { if (test(fiber)) return fiber; } catch {}
      }
      return null;
    }

    // Each sidebar section is a class component whose props.section holds the channel lists it renders.
    // The folder sections we add are rendered by the Followed component, so they resolve to it too.
    function sections() {
      const found = [];
      for (const element of document.querySelectorAll(SECTION)) {
        const node = findParent(fiberOf(element), fiber => !!fiber?.stateNode?.props?.section)?.stateNode;
        if (node) found.push({ element, node });
      }
      return found;
    }

    function isFollowed({ element, node }) {
      return /followed/i.test(node.props.section.sectionId || '') ||
        !!element.querySelector('a[data-test-selector="followed-channel"]');
    }

    // Split Twitch's Followed lists into Pinned, your folders, categories and the rest, keeping Twitch's order.
    function arrange(section) {
      const live = Array.isArray(section.streams) ? section.streams : [];
      const offline = Array.isArray(section.offlineChannels) ? section.offlineChannels : [];
      const used = new Set();
      const take = (list, test) => list.filter(item => {
        const id = item?.user?.id;
        if (!id || used.has(id) || !test(id, item)) return false;
        used.add(id);
        return true;
      });
      const groups = [];
      // Pinned channels are not a folder: they go straight under the Followed Channels header, live first,
      // each in the order you pinned it.
      const rank = new Map(pins.map((pin, index) => [pin.id, index]));
      const byRank = (a, b) => rank.get(a.user.id) - rank.get(b.user.id);
      const pinned = { streams: take(live, id => rank.has(id)).sort(byRank), offline: take(offline, id => rank.has(id)).sort(byRank) };
      for (const folder of folders) {
        const members = new Set(folder.members);
        groups.push({
          key: `folder:${folder.id}`, kind: 'folder', folder, title: folder.name,
          streams: take(live, id => members.has(id)), offline: take(offline, id => members.has(id)),
        });
      }
      if (options.byCategory) {
        const byGame = new Map();
        for (const item of live) {
          const game = item?.content?.game;
          const id = item?.user?.id;
          if (!game?.displayName || !id || used.has(id)) continue;
          const key = `category:${game.id || game.displayName}`;
          if (!byGame.has(key)) byGame.set(key, { key, kind: 'category', title: game.displayName, streams: [], offline: [] });
          byGame.get(key).streams.push(item);
        }
        for (const group of byGame.values()) {
          if (group.streams.length < MIN_CATEGORY_SIZE) continue;
          for (const item of group.streams) used.add(item.user.id);
          groups.push(group);
        }
      }
      const rest = { streams: live.filter(item => !used.has(item?.user?.id)), offline: offline.filter(item => !used.has(item?.user?.id)) };
      // Your folders always show, even when none of their channels are in Twitch's list (Twitch sends about 100
      // followed channels, so offline ones can be missing); other empty groups are hidden.
      return { pinned, groups: groups.filter(group => group.kind === 'folder' || group.streams.length || group.offline.length), rest };
    }

    // Offline channels sort by when they last went live: one batched anonymous query (the start time, not the end).
    // Render only reads the cache; unknown ids sort last, in Twitch's order.
    const LAST_LIVE_TTL = 30 * 60 * 1000;
    const LAST_LIVE_RETRY = 60 * 1000;
    const lastLive = new Map();
    let lastLiveRequest = null;

    function byLastLive(list) {
      const time = item => lastLive.get(item?.user?.id)?.time ?? -1;
      return [...list].sort((a, b) => time(b) - time(a));
    }

    function wantLastLive(list) {
      if (lastLiveRequest) return;
      const fresh = Date.now() - LAST_LIVE_TTL;
      const ids = list.map(item => item?.user?.id).filter(id => id && !(lastLive.get(id)?.at > fresh)).slice(0, 100);
      if (!ids.length) return;
      lastLiveRequest = fetchLastLive(ids).finally(() => { lastLiveRequest = null; });
    }

    async function fetchLastLive(ids) {
      let users = null;
      try {
        const response = await fetch('https://gql.twitch.tv/gql', {
          method: 'POST', credentials: 'omit',
          headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ variables: { ids }, query: 'query($ids: [ID!]) { users(ids: $ids) { id lastBroadcast { startedAt } } }' }),
        });
        const json = response.ok ? await response.json() : null;
        if (!json?.errors?.length && Array.isArray(json?.data?.users)) users = json.data.users;
      } catch {}
      const now = Date.now();
      // A failed lookup is retried after a minute, not on every render.
      const failedAt = now - LAST_LIVE_TTL + LAST_LIVE_RETRY;
      for (const id of ids) lastLive.set(id, { ...lastLive.get(id), at: users ? now : failedAt });
      for (const user of users || []) {
        const time = Date.parse(user?.lastBroadcast?.startedAt);
        if (user?.id && Number.isFinite(time)) lastLive.set(user.id, { at: now, time });
      }
      if (users) rerender();
    }

    // Twitch's row renderers, wrapped to draw only pinned channels. One wrapper per renderer keeps React's
    // component identity stable, so rows are not remounted on every render.
    const pinnedOnly = new WeakMap();
    let elementShape = null;

    function onlyPinned(Renderer) {
      if (typeof Renderer !== 'function' || !elementShape) return Nothing;
      let wrapper = pinnedOnly.get(Renderer);
      if (!wrapper) {
        // A React element copied from one Twitch made, so this follows whatever React version Twitch ships.
        wrapper = props => isPinned((props.stream || props.videoConnection)?.user?.id)
          ? { ...elementShape, type: Renderer, key: null, ref: null, props, _owner: null } : null;
        pinnedOnly.set(Renderer, wrapper);
      }
      return wrapper;
    }

    // Draw the groups with Twitch's own FollowedSideNavList in the same render pass, so nothing flickers:
    //   Followed Channels  (the real header, sort menu intact)
    //     pinned channels  (rows, no sub-header)
    //   your folders / categories
    //   Other channels     (everything else; only when there are groups)
    function hook(node) {
      if (hooked.has(node)) return;
      hooked.add(node);
      const render = node.render;
      node.render = function (...args) {
        try {
          const section = this.props.section;
          const { pinned, groups, rest } = arrange(section);
          drawn = true;
          if (!groups.length && !pinned.streams.length && !pinned.offline.length) {
            layouts.set(this, new Map());
            return render.apply(this, args);
          }
          const view = (key, props, lists) => {
            const copy = Object.create(this);
            Object.defineProperty(copy, 'props', { value: { ...this.props, ...props, section: { ...section, ...lists } } });
            const element = render.apply(copy, args);
            elementShape ??= element;
            return { ...element, key: `musa-${key}` };
          };
          // The Followed section keeps every channel, so its header count (Twitch needs 5+ for the sort menu) stays
          // right, but draws only the pinned live ones, first; an unreachable initial amount keeps "Show more" away.
          // Pinned offline channels do not stay on top: they lead the offline part of the list further down, the
          // way Twitch always puts offline channels after live ones.
          elementShape ??= render.apply(this, args);
          const live = section.streams || [];
          const elements = [view('followed', {
            OnlineChannelRenderer: onlyPinned(this.props.OnlineChannelRenderer),
            OfflineChannelRenderer: Nothing,
            initialDisplayAmount: Number.MAX_SAFE_INTEGER,
          }, {
            streams: [...pinned.streams, ...live.filter(item => !pinned.streams.includes(item))],
          })];
          wantLastLive(rest.offline);
          rest.offline = [...pinned.offline, ...byLastLive(rest.offline)];
          const drawnGroups = [...groups];
          const sort = { ...this.props.sort, type: NO_SORT };
          if (!groups.length) {
            // No folders: the rest of the list continues under the pins with its header hidden (blank title),
            // so it reads as one list; Twitch's own initial amount and Show more apply.
            elements.push(view('rest', { title: '', sort }, { sectionId: 'musa-rest', streams: rest.streams, offlineChannels: rest.offline }));
            layouts.set(this, new Map());
            return elements;
          }
          if (rest.streams.length || rest.offline.length) {
            drawnGroups.push({ key: 'other', kind: 'other', title: 'Other channels', streams: rest.streams, offline: rest.offline });
          }
          // In the avatar-only sidebar there is no header to click, so collapsed groups show everything.
          const miniSidebar = !!this.props.collapsed;
          for (const group of drawnGroups) {
            const shut = !miniSidebar && options.collapsed[group.key];
            // Twitch's initial amount is sized for the whole Followed list (up to 12), so a category folder would
            // never reach it; long ones get their own. Twitch shows Show More (disabled) at exactly the initial
            // amount, so shorter folders keep an unreachable one.
            const long = group.kind === 'category' && !shut && group.streams.length > CATEGORY_SHOWN;
            const props = { title: group.title, sort };
            if (group.kind === 'category') props.initialDisplayAmount = long ? CATEGORY_SHOWN : Number.MAX_SAFE_INTEGER;
            elements.push(view(group.key, props, {
              sectionId: `musa-${group.key}`, streams: shut ? [] : group.streams, offlineChannels: shut ? [] : group.offline,
            }));
          }
          layouts.set(this, new Map(drawnGroups.map(group => [`musa-${group.key}`, group])));
          return elements;
        } catch {
          layouts.delete(this);
          return render.apply(this, args);
        }
      };
      node.forceUpdate();
    }

    function load() {
      pins = read(STORE, []).filter(pin => pin && typeof pin.id === 'string');
      folders = read(FOLDERS, []).filter(folder => folder && typeof folder.id === 'string' && Array.isArray(folder.members));
      options = { byCategory: false, collapsed: {}, ...read(OPTIONS, {}) };
    }

    function rerender() {
      for (const { node } of sections()) if (hooked.has(node)) node.forceUpdate();
      schedule();
    }

    // Every edit starts from what is saved now, not from this tab's copy: another Twitch tab may have
    // changed pins or folders since this one loaded, and saving a stale copy would erase that work.
    function change(apply) {
      load();
      apply();
      write(STORE, pins);
      write(FOLDERS, folders);
      write(OPTIONS, options);
      rerender();
    }

    // Edits made in another tab arrive as storage events; show them here straight away.
    addEventListener('storage', event => {
      if (event.key !== null && !event.key.startsWith('twitchNativePins.')) return;
      load();
      rerender();
    });

    function togglePin(id, login) {
      change(() => {
        pins = isPinned(id) ? pins.filter(pin => pin.id !== id) : [...pins, { id, login }];
      });
    }

    function assignFolder(id, folderId) {
      folders = folders.map(folder => ({ ...folder, members: folder.members.filter(member => member !== id) }));
      if (folderId) folders = folders.map(folder => folder.id === folderId ? { ...folder, members: [...folder.members, id] } : folder);
    }

    function moveToFolder(id, folderId) {
      change(() => assignFolder(id, folderId));
    }

    function createFolder(name, firstMember) {
      change(() => {
        const folder = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, members: [] };
        folders = [...folders, folder];
        if (firstMember) assignFolder(firstMember, folder.id);
      });
    }

    // ---------- Menus ----------

    function closeMenu() {
      if (!menu) return;
      menu.element.remove();
      menu.anchor?.setAttribute('aria-expanded', 'false');
      menu.anchor?.focus({ preventScroll: true });
      menu = null;
    }

    function openMenu(anchor, build) {
      const reopen = menu?.anchor === anchor;
      closeMenu();
      if (reopen) return;
      const element = document.createElement('div');
      element.className = 'musa-twitch-menu';
      element.setAttribute('role', 'menu');
      menu = { element, anchor };
      build(element);
      document.body.appendChild(element);
      const box = anchor.getBoundingClientRect();
      const width = element.offsetWidth, height = element.offsetHeight;
      element.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
      element.style.top = `${box.bottom + 4 + height > innerHeight ? Math.max(8, box.top - height - 4) : box.bottom + 4}px`;
      anchor.setAttribute('aria-expanded', 'true');
      (element.querySelector('input') || element.querySelector('button'))?.focus();
    }

    function menuItem(parent, label, action, { icon, danger, checked } = {}) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `musa-twitch-menu__item${danger ? ' musa-twitch-menu__item--danger' : ''}`;
      item.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemradio');
      if (checked !== undefined) item.setAttribute('aria-checked', String(checked));
      const lead = icon || checked ? svg(checked ? 'check' : icon) : document.createElement('span');
      if (!(icon || checked)) lead.className = 'musa-twitch-menu__spacer';
      const text = document.createElement('span');
      text.textContent = label;
      item.append(lead, text);
      item.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        action(item);
      });
      parent.appendChild(item);
      return item;
    }

    function menuDivider(parent) {
      const line = document.createElement('div');
      line.className = 'musa-twitch-menu__divider';
      line.setAttribute('role', 'separator');
      parent.appendChild(line);
    }

    function menuLabel(parent, text) {
      const label = document.createElement('div');
      label.className = 'musa-twitch-menu__label';
      label.textContent = text;
      parent.appendChild(label);
    }

    // Swap a menu item for a text field; Enter confirms, Escape closes.
    function askName(item, initial, done) {
      const input = document.createElement('input');
      input.className = 'musa-twitch-menu__input';
      input.type = 'text';
      input.maxLength = 40;
      input.value = initial;
      input.placeholder = 'Folder name';
      input.setAttribute('aria-label', 'Folder name');
      input.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          const name = input.value.trim();
          if (name) { closeMenu(); done(name); }
        } else if (event.key === 'Escape') closeMenu();
      });
      item.replaceWith(input);
      input.focus();
      input.select();
    }

    function channelMenu(anchor, id, login) {
      openMenu(anchor, element => {
        const current = folderOf(id);
        menuLabel(element, `Move ${login || 'channel'} to`);
        for (const folder of folders) {
          menuItem(element, folder.name, () => { closeMenu(); moveToFolder(id, folder.id); }, { checked: current?.id === folder.id });
        }
        menuItem(element, 'New folder…', item => askName(item, '', name => createFolder(name, id)), { icon: 'folder' });
        if (current) {
          menuDivider(element);
          menuItem(element, `Remove from ${current.name}`, () => { closeMenu(); moveToFolder(id, null); }, { danger: true });
        }
      });
    }

    function folderMenu(anchor, folder) {
      openMenu(anchor, element => {
        menuItem(element, 'Rename folder', item => askName(item, folder.name, name => change(() => {
          folders = folders.map(entry => entry.id === folder.id ? { ...entry, name } : entry);
        })));
        menuItem(element, 'Delete folder', () => {
          closeMenu();
          change(() => {
            folders = folders.filter(entry => entry.id !== folder.id);
            delete options.collapsed[`folder:${folder.id}`];
          });
        }, { danger: true });
      });
    }

    document.addEventListener('pointerdown', event => {
      if (menu && !menu.element.contains(event.target) && !menu.anchor.contains(event.target)) closeMenu();
    }, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu) closeMenu(); });
    addEventListener('resize', closeMenu);
    addEventListener('scroll', event => { if (menu && !menu.element.contains(event.target)) closeMenu(); }, true);

    // ---------- Decorating Twitch's DOM ----------

    function tool(kind, label, onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `musa-twitch-tool musa-twitch-tool--${kind}`;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.appendChild(svg(kind));
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        onClick(button);
      });
      return button;
    }

    // Put the collapse arrow and folder menu into a group's native header. The category switch lives in
    // Twitch's Sort By menu instead (decorateSortMenu).
    function decorateHeader(element, group) {
      if (group.kind === 'followed') return;
      // Followed-style headers are one big sort button, so the tools go beside it in the outer wrapper.
      const header = element.querySelector('.followed-side-nav-header--expanded') ||
        element.querySelector('.side-nav-header[data-a-target="side-nav-header-expanded"]');
      if (!header) return;
      let tools = header.querySelector('.musa-twitch-section-tools');
      const signature = `${group.key}|${group.title || ''}`;
      if (tools?.dataset.key !== signature) {
        tools?.remove();
        tools = document.createElement('div');
        tools.className = 'musa-twitch-section-tools';
        tools.dataset.key = signature;
        header.classList.add('musa-twitch-section-header');
        if (group.kind === 'folder') {
          const more = tool('more', `${group.title} folder options`, button => {
            const folder = folders.find(entry => entry.id === group.folder.id);
            if (folder) folderMenu(button, folder);
          });
          more.classList.add('musa-twitch-tool--hover');
          more.setAttribute('aria-haspopup', 'menu');
          tools.appendChild(more);
        }
        // Twitch's red live dot and a count, beside the arrow, so a collapsed group still says who is live.
        const live = document.createElement('span');
        live.className = 'musa-twitch-live-count';
        live.hidden = true;
        const dot = document.createElement('span');
        dot.className = 'musa-twitch-live-count__dot';
        dot.setAttribute('aria-hidden', 'true');
        live.append(dot, document.createElement('span'));
        tools.appendChild(live);
        tools.appendChild(tool('chevron', `Collapse ${group.title}`, () => change(() => {
          options.collapsed[group.key] = !options.collapsed[group.key];
          if (!options.collapsed[group.key]) delete options.collapsed[group.key];
        })));
        header.appendChild(tools);
      }
      // Sit just left of native buttons instead of under them: the Followed sort menu inside the header,
      // and the sidebar's collapse arrow, which floats over whichever header comes first.
      const box = header.getBoundingClientRect();
      // A full-width header button is not a blocker, but the sort icon inside it is.
      const blockers = [...header.querySelectorAll('button, .followed-side-nav-header__dropdown-trigger > :last-child')]
        .filter(item => !tools.contains(item) && item.offsetWidth && item.offsetWidth < box.width / 2);
      const arrow = document.querySelector('[data-a-target="side-nav-arrow"]');
      if (arrow && !header.contains(arrow)) {
        const spot = arrow.getBoundingClientRect();
        if (spot.width && spot.bottom > box.top && spot.top < box.bottom) blockers.push(arrow);
      }
      const left = Math.min(...blockers.map(button => button.getBoundingClientRect().left).filter(x => x > box.left));
      const right = Number.isFinite(left) ? `${Math.round(box.right - left + 4)}px` : '';
      if (tools.style.right !== right) tools.style.right = right;
      const live = tools.querySelector('.musa-twitch-live-count');
      if (live) {
        const count = group.streams.length;
        const text = count ? String(count) : '';
        if (live.lastChild.textContent !== text) {
          live.lastChild.textContent = text;
          live.hidden = !count;
          const label = `${count} live ${count === 1 ? 'channel' : 'channels'}`;
          live.title = label;
          live.setAttribute('aria-label', label);
        }
      }
      const chevron = tools.querySelector('.musa-twitch-tool--chevron');
      if (chevron) {
        const open = !options.collapsed[group.key];
        if (chevron.getAttribute('aria-expanded') !== String(open)) {
          chevron.setAttribute('aria-expanded', String(open));
          const label = `${open ? 'Collapse' : 'Expand'} ${group.title}`;
          chevron.setAttribute('aria-label', label);
          chevron.title = label;
        }
      }
    }

    // Add "Group By > Category" to the Followed list's Sort By menu, built from clones of the menu's own
    // label, row and check mark so it looks native. Clones carry no React handlers; ours does the toggling.
    function decorateSortMenu() {
      if (!document.querySelector('.followed-side-nav-header button[aria-expanded="true"]:not(:disabled)')) return;
      for (const dialog of document.querySelectorAll('.tw-dialog-layer [role="dialog"]')) {
        if (dialog.querySelector('.musa-twitch-group-by')) continue;
        const rows = [...dialog.querySelectorAll('button[aria-pressed]')];
        const on = rows.find(row => row.getAttribute('aria-pressed') === 'true');
        const off = rows.find(row => row.getAttribute('aria-pressed') === 'false');
        const list = rows[0]?.parentElement?.parentElement;
        const label = list?.firstElementChild;
        const check = on && [...on.querySelectorAll('.tw-svg')].find(icon => !icon.closest('.tw-drop-down-menu-item-figure'))?.parentElement;
        if (!on || !off || !label?.querySelector('p') || !check) continue;
        const block = document.createElement('div');
        block.className = 'musa-twitch-group-by';
        const heading = label.cloneNode(true);
        heading.querySelector('p').textContent = 'Group By';
        const wrapper = off.parentElement.cloneNode(true);
        const button = wrapper.querySelector('button');
        const text = [...button.querySelectorAll('div')].find(div => !div.children.length && div.textContent.trim());
        if (!text) continue;
        text.textContent = 'Category';
        const figure = button.querySelector('.tw-drop-down-menu-item-figure .tw-svg');
        if (figure) {
          const icon = svg('category');
          icon.setAttribute('width', '20');
          icon.setAttribute('height', '20');
          figure.replaceChildren(icon);
        }
        const mark = check.cloneNode(true);
        const paint = () => {
          button.className = (options.byCategory ? on : off).className;
          button.setAttribute('aria-pressed', String(options.byCategory));
          if (options.byCategory) text.after(mark); else mark.remove();
        };
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          change(() => { options.byCategory = !options.byCategory; });
          paint();
        });
        paint();
        block.append(heading, wrapper);
        list.appendChild(block);
      }
    }

    function rowUserId(row) {
      return findChild(fiberOf(row), fiber => !!fiber?.pendingProps?.userID)?.pendingProps?.userID;
    }

    // One-time copy of the Enhancer extension's pins, read from the ★ it draws on pinned avatars.
    // Its saved list lives in extension storage that a userscript cannot read directly.
    function importEnhancerPins(element) {
      try { if (localStorage.getItem(IMPORTED)) return false; } catch { return false; }
      const theirs = [...element.querySelectorAll('.pin-streamer-button')];
      // Enhancer fills each button a moment after creating it; wait until every one shows a star.
      if (!theirs.length || theirs.some(button => !/[★☆]/.test(button.textContent))) return false;
      load();
      let added = 0;
      for (const button of theirs) {
        if (!button.textContent.includes('★')) continue;
        const row = button.closest('.tw-transition-group > *');
        const id = row && rowUserId(row);
        if (!id || isPinned(id)) continue;
        const login = (row.querySelector('a[href]')?.getAttribute('href') || '').split('/').filter(Boolean)[0] || '';
        pins = [...pins, { id, login }];
        added++;
      }
      write(STORE, pins);
      try { localStorage.setItem(IMPORTED, new Date().toISOString()); } catch {}
      return added > 0;
    }

    function avatarButton(avatar, className, build) {
      let button = avatar.querySelector(`.${className}`);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.addEventListener('pointerdown', event => event.stopPropagation());
        build(button);
        avatar.appendChild(button);
      }
      return button;
    }

    function decorate(row) {
      const card = row.querySelector('a.side-nav-card, .side-nav-card a');
      const avatar = card?.querySelector('.tw-avatar');
      if (!avatar || card.querySelector('a[data-test-selector="similarity-channel"]')) return;
      const id = rowUserId(row);
      if (!id) return;
      avatar.classList.add('musa-twitch-pin-avatar');
      const login = (card.getAttribute('href') || '').split('/').filter(Boolean)[0] || '';
      const pin = avatarButton(avatar, BUTTON, button => button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        togglePin(button.dataset.channelId, button.dataset.login);
      }));
      const move = avatarButton(avatar, FOLDER_BUTTON, button => {
        button.setAttribute('aria-haspopup', 'menu');
        button.appendChild(svg('folder'));
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          channelMenu(button, button.dataset.channelId, button.dataset.login);
        });
      });
      const pinned = isPinned(id);
      // Only write on change: every write is a mutation that would schedule another scan.
      for (const button of [pin, move]) {
        if (button.dataset.channelId !== id) button.dataset.channelId = id;
        if (button.dataset.login !== login) button.dataset.login = login;
      }
      const star = pinned ? '★' : '☆';
      if (pin.textContent !== star) pin.textContent = star;
      if (pin.getAttribute('aria-pressed') !== String(pinned)) pin.setAttribute('aria-pressed', String(pinned));
      const pinLabel = `${pinned ? 'Unpin' : 'Pin'} ${login || 'channel'}`;
      if (pin.title !== pinLabel) { pin.title = pinLabel; pin.setAttribute('aria-label', pinLabel); }
      const moveLabel = `Move ${login || 'channel'} to a folder`;
      if (move.title !== moveLabel) { move.title = moveLabel; move.setAttribute('aria-label', moveLabel); }
    }

    // The musa-* React key a section was rendered under, or null for the plain Followed list.
    function groupKey(element, node) {
      for (let fiber = fiberOf(element), depth = 0; fiber && depth < 60; fiber = fiber.return, depth++) {
        if (fiber.stateNode === node) return null;
        if (typeof fiber.key === 'string' && fiber.key.startsWith('musa-')) return fiber.key;
      }
      return null;
    }

    // Show the Followed list once our first render is on screen, or after a short timeout as a safety net.
    function settle() {
      const root = document.documentElement;
      if (!root.classList.contains(PENDING)) return;
      if (drawn) requestAnimationFrame(() => root.classList.remove(PENDING));
      else reveal ??= setTimeout(() => root.classList.remove(PENDING), 1500);
    }

    function scan() {
      scheduled = false;
      if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
      let followed = false;
      for (const entry of sections()) {
        if (!isFollowed(entry)) continue;
        followed = true;
        hook(entry.node);
        if (importEnhancerPins(entry.element)) entry.node.forceUpdate();
        for (const row of entry.element.querySelectorAll('.tw-transition-group > *')) decorate(row);
        const group = layouts.get(entry.node)?.get(groupKey(entry.element, entry.node));
        if (group) decorateHeader(entry.element, group);
      }
      if (followed) settle();
      decorateSortMenu();
    }

    function schedule() {
      // Before the first grouped render the list is hidden, so act at once instead of batching.
      if (document.documentElement.classList.contains(PENDING)) return scan();
      if (scheduled) return;
      scheduled = true;
      setTimeout(scan, 100);
    }
    // Twitch draws menus in a dialog layer outside the sidebar; add our option before the next paint.
    // href changes catch React reusing a row element for a different channel after a reorder.
    listen(batch => {
      if (batch.dialog) decorateSortMenu();
      if (batch.sideNav) schedule();
    });
    scan();
});

export default pins;
