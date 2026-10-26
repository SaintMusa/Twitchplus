import type { Module } from '../modules';

// Nudges Twitch's player to start at a preferred quality while leaving Auto in charge.
// Auto remains in charge of throughput, buffering and device constraints.
// This is a startup hint, not a sustained minimum-quality guarantee.

declare global {
  interface Window {
    // Guard against starting twice.
    __twitchPreferredQuality?: Record<string, any>;
    __twitchPreferredQualityReport?: () => unknown;
    webpackChunktwitch_twilight?: unknown;
  }
}

// Twitch's media player and webpack runtime; checked at runtime before use.
type Player = any;
type Quality = any;

/** Ceiling choice from the popup -> height cap and a startup bitrate hint (bits/second) for that height. */
const CEILINGS: Record<string, { height: number; bitrate: number }> = {
  source: { height: Infinity, bitrate: 8_000_000 },
  '1080': { height: 1080, bitrate: 6_000_000 },
  '720': { height: 720, bitrate: 3_500_000 },
  '480': { height: 480, bitrate: 1_500_000 },
};
const PREFERRED_FPS = 60;

// The two modules are found by content: IDs change between builds, so fixed IDs stop matching.
type Role = 'settings' | 'creator';
const FINGERPRINTS: Record<Role, { markers: string[]; exportPattern: RegExp }> = {
  // Player settings store; exports `o` either as a getter (`o:()=>a`) or, in newer builds, as a value (`{o:{get:…}}`).
  settings: {
    markers: ['video-quality', 'video-muted', 'segmentKey', 'clips-viewing', 'clips-editing', '.storage.get(', '.storage.set('],
    exportPattern: /\bo\s*:\s*(?:\(\s*\)\s*=>|\{\s*get\s*:)/,
  },
  // Media player creator; exports the async factory as `F`.
  creator: {
    markers: ['player-core-base', 'ivs-player-core-distribution', 'mediaPlayerInstance', 'INITIALIZED', 'getExperiments'],
    exportPattern: /\bF\s*:\s*\(\s*\)\s*=>/,
  },
};
const ROLES = Object.keys(FINGERPRINTS) as Role[];

const sourceOf = (fn: unknown) => {
  try { return typeof fn === 'function' ? Function.prototype.toString.call(fn) : ''; } catch { return ''; }
};
/** The role whose fingerprint this module source matches, if any. */
export const roleOf = (source: string): Role | null =>
  ROLES.find((role) => FINGERPRINTS[role].markers.every((m) => source.includes(m)) && FINGERPRINTS[role].exportPattern.test(source)) ?? null;

const preferredQuality: Module = (options) => {
  const { height: PREFERRED_HEIGHT, bitrate: INITIAL_BITRATE } = CEILINGS[String(options.ceiling)] ?? CEILINGS['1080']!;
  if (window.__twitchPreferredQuality) return;
  const status: Record<string, any> = (window.__twitchPreferredQuality = {
    state: 'starting',
    preference: PREFERRED_HEIGHT === Infinity ? 'source' : `${PREFERRED_HEIGHT}p${PREFERRED_FPS}`,
    matched: [], executed: [], selected: null, decisions: 0, manual: false,
    players: 0, startupHints: 0, mode: 'native-auto', initialBitrate: INITIAL_BITRATE,
    compatibility: {},
  });
  let path = location.pathname;
  const players = new Set<Player>();
  const snapshots = new WeakMap<Player, () => unknown>();
  // Read only summaries: never expose load URLs, auth arguments or player objects.
  window.__twitchPreferredQualityReport = () => ({
    ...status, path: location.pathname,
    activePlayers: [...players].map((player) => snapshots.get(player)?.()),
  });
  function prefer() {
    if (path !== location.pathname) { path = location.pathname; status.manual = false; }
    return !status.manual;
  }
  // Explicit menu selection wins for this channel/page, including Auto.
  document.addEventListener('click', (event) => {
    if (event.isTrusted && event.target instanceof Element && event.target.closest('[data-a-target="player-settings-submenu-quality-option"]')) {
      path = location.pathname; status.manual = true; status.state = 'manual-choice-respected';
      for (const player of players) {
        try {
          const highest = player.getQualities().filter((q: Quality) => !/audio|^auto$/i.test(String(q.group || q.name || ''))).sort((a: Quality, b: Quality) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
          if (highest) player.setAutoMaxQuality(highest);
        } catch {}
      }
    }
  }, true);

  function choose(qualities: unknown) {
    const scored = (Array.isArray(qualities) ? qualities : []).map((q: Quality) => {
      if (!q || /audio|^auto$/i.test(String(q.group || ''))) return null;
      const label = [q.group, q.quality, q.name].join(' ');
      const match = /(\d+)p(?:(\d+))?/i.exec(label);
      const height = Number(q.height) || Number(match?.[1]) || 0;
      const fps = Number(q.framerate) || Number(match?.[2]) || 30;
      return height > 0 ? { q, height, fps, bitrate: Number(q.bitrate) || 0 } : null;
    }).filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.height - a.height || b.fps - a.fps || b.bitrate - a.bitrate);
    const allowed = scored.filter((q) => q.height <= PREFERRED_HEIGHT && q.fps <= PREFERRED_FPS);
    // If every available video exceeds the cap, choose the smallest video.
    return (allowed[0] || scored[scored.length - 1])?.q || null;
  }

  function attach(player: Player) {
    if (!player || players.has(player)) return;
    const required = ['load', 'getQualities', 'setAutoInitialBitrate', 'setAutoMaxQuality', 'addEventListener'];
    if (required.some((key) => typeof player[key] !== 'function')) { status.state = 'unsupported-player'; return; }
    const originalLoad = player.load;
    const originalDelete = player.delete;
    const originalQualities = player.getQualities;
    let seeded = false;
    let applying = false;
    let capKey: string | null = null;
    let lastCap: unknown = null;
    let loads = 0;
    let lastPath = location.pathname;
    function summary(q: Quality) {
      return q ? { group: q.group || null, name: q.name || null,
        height: Number(q.height) || null, bitrate: Number(q.bitrate) || null } : null;
    }
    snapshots.set(player, () => {
      try {
        return { loads, path: lastPath, ceiling: lastCap,
          auto: typeof player.isAutoQualityMode === 'function' ? player.isAutoQualityMode() : null,
          current: typeof player.getQuality === 'function' ? summary(player.getQuality()) : null,
          available: (originalQualities.call(player) || []).map(summary) };
      } catch { return { loads, path: lastPath, ceiling: lastCap, error: 'snapshot-unavailable' }; }
    });
    function hint() {
      if (!prefer()) return;
      try { player.setAutoInitialBitrate(INITIAL_BITRATE); seeded = true; status.startupHints++; }
      catch { status.state = 'startup-hint-failed'; }
    }
    function cap(qualities?: unknown) {
      if (!prefer() || applying) return;
      applying = true;
      try {
        const quality = choose(Array.isArray(qualities) ? qualities : originalQualities.call(player));
        if (quality) {
          const key = JSON.stringify([quality.group, quality.name, quality.height, quality.framerate, quality.bitrate]);
          if (key === capKey) return;
          player.setAutoMaxQuality(quality);
          capKey = key; lastCap = summary(quality);
          status.selected = quality.group || quality.name;
          status.decisions++; status.state = 'native-auto-preference-active';
        }
      } catch { status.state = 'quality-cap-failed'; }
      finally { applying = false; }
    }
    // Twitch can reuse the player without emitting the initial qualities event.
    // Its normal quality-list reads also refresh the ceiling for the new stream.
    player.getQualities = function (this: Player, ...args: unknown[]) {
      const qualities = originalQualities.apply(this, args);
      cap(qualities);
      return qualities;
    };
    player.load = function (this: Player, ...args: unknown[]) {
      loads++; lastPath = location.pathname; capKey = null; lastCap = null;
      seeded = false; hint();
      const result = originalLoad.apply(this, args);
      // load may reset engine configuration; supply the hint again afterwards.
      // Do not use the previous stream's quality list here.
      hint();
      return result;
    };
    player.addEventListener('PlayerInitialized', () => { if (!seeded) hint(); });
    player.addEventListener('PlayerQualitiesChanged', () => cap());
    player.addEventListener('PlayerSourceGroupChanged', () => { capKey = null; cap(); });
    if (typeof originalDelete === 'function') player.delete = function (this: Player, ...args: unknown[]) {
      players.delete(player);
      return originalDelete.apply(this, args);
    };
    players.add(player); status.players++;
    hint(); cap();
    // Never call setQuality: that would turn off native adaptation.
  }

  function wrap(role: Role, original: Function) {
    return function (this: unknown, module: unknown, exports: unknown, require: any) {
      const native: Record<string, any> = {};
      original.call(this, module, native, require);
      const overrides: Record<string, unknown> = {};
      if (role === 'settings' && typeof native.o?.get === 'function' && typeof native.o?.set === 'function') {
        overrides.o = {
          ...native.o,
          get(setting: string, playerType: unknown) {
            if (setting === 'video-quality' && !String(playerType || '').startsWith('clips') && prefer()) return 'auto';
            return native.o.get(setting, playerType);
          },
        };
      } else if (role === 'creator' && typeof native.F === 'function') {
        overrides.F = async function (this: unknown, ...args: unknown[]) {
          const result = await native.F.apply(this, args);
          try { attach(result?.mediaPlayerInstance); }
          catch { status.state = 'player-hook-failed'; }
          return result;
        };
      } else {
        status.state = 'unsupported-module-export';
      }
      const definitions: Record<string, () => unknown> = {};
      for (const key of Object.keys(native)) definitions[key] = () => Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : native[key];
      require.d(exports, definitions);
      if (!status.executed.includes(role)) status.executed.push(role);
      if (status.executed.length === 2 && (status.state === 'starting' || status.state === 'waiting-for-modules')) status.state = 'native-hooks-active';
    };
  }

  // Wrap exports rather than rewriting source: a module is replaced only when it matches its role's
  // fingerprint, and the wrapper still checks the exported methods before using them.
  const found: Partial<Record<Role, string>> = {};
  const inspected = new WeakSet<Function>();
  const allFound = () => ROLES.every((role) => found[role]);
  /** Searches `modules` and replaces each match in `target` (the same table unless given). */
  function patchModules(modules: unknown, target = modules as Record<string, unknown>, cache?: Record<string, unknown>) {
    if (!modules || typeof modules !== 'object') return;
    for (const [id, factory] of Object.entries(modules)) {
      if (allFound()) return;
      if (typeof factory !== 'function' || inspected.has(factory)) continue;
      inspected.add(factory);
      const role = roleOf(sourceOf(factory));
      if (!role || found[role]) continue;
      found[role] = id;
      status.matched.push(role);
      status.compatibility[role] = `module ${id}`;
      // Already run: its exports are fixed, so wrapping it now would do nothing.
      if (cache?.[id]) { status.state = 'too-late'; continue; }
      if (target[id] === factory) target[id] = wrap(role, factory);
    }
  }

  // Capture the native runtime through a harmless empty chunk. Its callback runs while Twitch's runtime
  // boots: the modules installed so far and the chunks still waiting in the queue are searched then.
  const queue = (window.webpackChunktwitch_twilight = window.webpackChunktwitch_twilight || []);
  if (!Array.isArray(queue)) { status.state = 'unsupported-runtime'; return; }
  queue.push([['twitch-plus:preferred-quality'], {}, (require: any) => {
    if (!require.m || typeof require.d !== 'function') { status.state = 'unsupported-runtime'; return; }
    patchModules(require.m, require.m, require.c);
    for (const chunk of queue) if (Array.isArray(chunk)) patchModules(chunk[1]);
    if (allFound()) return;
    // Right after this callback the runtime takes the queue's current push as the step it calls once it
    // has installed each later chunk, then puts its own handler in front. Placing ours there now means
    // every later chunk reaches it with its modules installed but not yet run, so they are swapped in
    // require.m. Assigning (rather than redefining the property) chains through Rewind's push accessor
    // when Rewind runs too, so neither hook displaces the other.
    const downstream = queue.push;
    queue.push = function (this: unknown, ...chunks: any[]) {
      if (!allFound()) {
        for (const chunk of chunks) {
          // A failing search must never stop Twitch from installing its chunk.
          try { if (Array.isArray(chunk)) patchModules(chunk[1], require.m, require.c); } catch {}
        }
      }
      return Reflect.apply(downstream, this, chunks);
    };
    if (status.state === 'starting') status.state = 'waiting-for-modules';
  }]);
};

export default preferredQuality;
