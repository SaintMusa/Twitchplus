// @ts-nocheck
// Unlocks Twitch's native DVR rewind by patching its eligibility module, and serves archive playback lookups.
import type { Module } from '../modules';

const rewind: Module = () => {
  let disabled = false, debug = false;
  try {
    disabled = localStorage.getItem('twitchNativeRewind.disabled') === '1';
    debug = localStorage.getItem('twitchNativeRewind.debug') === '1';
  } catch (_) {}
  // One small queue marker prevents duplicate installations. It is not a
  // privacy boundary; the remaining hooks are observable to page JavaScript.
  const installationKey = Symbol.for('twitchNativeRewind.installed');
  const existingQueue = window.webpackChunktwitch_twilight;
  if (!disabled && existingQueue?.[installationKey]) return;
  const status = { state: disabled ? 'disabled' : 'starting', matched: 0, executed: 0, moduleId: null, verifiedBuild: null, roles: null, calls: {}, lastEligibility: null };
  const bridgeStatus = { state: disabled ? 'disabled' : 'starting', channel: null, lookups: 0, supplied: 0, failures: 0, last: null };
  let syncBridgeRoute = () => {};
  const events = [];
  const info = (...args) => { if (debug) console.info('[Twitch Native Rewind]', ...args); };
  const warn = (...args) => { if (debug) console.warn('[Twitch Native Rewind]', ...args); };
  if (debug) {
    window.__twitchNativeRewindV1 = status;
    window.__twitchArchiveBridge = bridgeStatus;
    window.__twitchRewindReport = () => {
      syncBridgeRoute();
      return JSON.parse(JSON.stringify({ patch: status, bridge: bridgeStatus, events, coverage: 'Opt-in local diagnostics only; no passive fetch monitoring.' }));
    };
  }
  if (disabled) return;
  const queue = window.webpackChunktwitch_twilight = existingQueue || [];
  if (!Array.isArray(queue)) { status.state = 'unsupported-runtime'; return; }
  try { Object.defineProperty(queue, installationKey, { value: true, configurable: true }); }
  catch (_) { status.state = 'unsupported-runtime'; return; }
  installArchiveBridge();
  const releases = [];
  // Build compatibility: the DVR gate module is found by content fingerprint, not by
  // chunk ID, module ID or exact minified text. Its exports are wrapped by role
  // (flag / channel check / eligibility), worked out from each function's own source.
  // If any export cannot be classified, the original module runs unchanged.
  // KNOWN_SOURCE is only used to report whether this is the build verified by hand.
  const KNOWN_SOURCE = "(e,t,n)=>{\"use strict\";n.d(t,{Hl:()=>d,Sw:()=>l,TV:()=>s,fh:()=>c});var i=n(571421);const r=\"savvy-part-1\",a=\"savvy-part-1-flag\",o=\"savvy-part-2\",s=()=>i.Mv.getAssignment(r,\"boolean\",!1),c=(e,t,n,a)=>{var s;if(a)return i.Mv.getAssignment(r,\"boolean\",!1);if(n.isDvrEligible)return!0;if(!(t.isAffiliate||t.isPartner))return!1;if(i.Mv.getAssignment(o,\"boolean\",!1))return!0;return(e.hasTurbo||e.isStaff||!(!e.subscription||!(null===(s=e.subscription.product)||void 0===s?void 0:s.hasAdFree)))&&i.Mv.getAssignment(r,\"boolean\",!1)},l=()=>i.Mv.getAssignment(a,\"boolean\",!1)||i.Mv.getAssignment(o,\"boolean\",!1),d=e=>(e.isAffiliate||e.isPartner)&&(i.Mv.getAssignment(a,\"boolean\",!1)||i.Mv.getAssignment(o,\"boolean\",!1))}";
  const MARKERS = ['savvy-part-1', 'savvy-part-2', 'isDvrEligible', 'isAffiliate', 'getAssignment'];
  // Only supported runtimes are hooked; unknown runtimes keep native behavior.
  const CHUNK_GLOBALS = ['webpackChunktwitch_twilight'];
  const sourceOf = fn => { try { return Function.prototype.toString.call(fn); } catch (_) { return ''; } };
  const escapeRegExp = name => name.replace(/\$/g, '\\$');
  function paramsOf(source) {
    const match = /^\(?\s*([\w$\s,]*?)\s*\)?\s*=>/.exec(source) || /^function\s*[\w$]*\s*\(([\w$\s,]*)\)/.exec(source);
    return match ? match[1].split(',').map(p => p.trim()).filter(Boolean) : null;
  }
  // Index of the single parameter read as `param.property`, or -1.
  function paramUsing(source, params, property) {
    const found = params.map((p, i) => new RegExp(`(?:^|[^\\w$.])${escapeRegExp(p)}\\.${property}\\b`).test(source) ? i : -1).filter(i => i >= 0);
    return found.length === 1 ? found[0] : -1;
  }
  function matchingBrace(source, open) {
    let depth = 0, quote = null, escaped = false, lineComment = false, blockComment = false;
    for (let i = open; i < source.length; i++) {
      const ch = source[i], next = source[i + 1];
      if (lineComment) { if (ch === '\n') lineComment = false; continue; }
      if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
      if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return i;
    }
    return -1;
  }
  function factoryBody(source) {
    let open;
    if (/^\s*(?:async\s+)?function\b/.test(source)) {
      const paramsStart = source.indexOf('('), paramsEnd = paramsStart < 0 ? -1 : source.indexOf(')', paramsStart + 1);
      open = paramsEnd < 0 ? -1 : source.indexOf('{', paramsEnd + 1);
      if (open < 0 || source.slice(paramsEnd + 1, open).trim()) return null;
    } else {
      const arrow = /^\s*(?:\([\w$\s,]*\)|[\w$]+)\s*=>/.exec(source);
      if (!arrow) return null;
      open = source.indexOf('{', arrow[0].length);
      if (open < 0 || source.slice(arrow[0].length, open).trim()) return null;
    }
    const close = matchingBrace(source, open);
    return close > open ? source.slice(open + 1, close) : null;
  }
  function moduleScopeMask(source) {
    const mask = new Uint8Array(source.length);
    let depth = 0, quote = null, escaped = false, lineComment = false, blockComment = false;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i], next = source[i + 1];
      if (lineComment) { if (ch === '\n') lineComment = false; continue; }
      if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
      if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') { depth++; continue; }
      if (ch === '}') { depth--; continue; }
      if (depth === 0) mask[i] = 1;
    }
    return mask;
  }
  function bindingName(match) {
    const equals = match[0].indexOf('=');
    const before = match[0].slice(0, equals);
    const identifier = /([\w$]+)\s*$/.exec(before);
    return identifier ? { name: identifier[1], offset: match.index + identifier.index + identifier[0].lastIndexOf(identifier[1]) } : null;
  }
  function moduleBindings(source) {
    const body = factoryBody(source);
    const experiments = new Map();
    const helpers = new Map();
    if (!body) return { valid: false, experiments, helpers };
    const topLevel = moduleScopeMask(body);
    const allowedWrites = new Set();
    let valid = true;
    const literal = /(?:\b(?:var|let|const)\s+|[;,]\s*)([\w$]+)\s*=\s*(["'])(savvy-part-(?:1-flag|1|2))\2(?=\s*[,;])/g;
    for (const match of body.matchAll(literal)) {
      if (!topLevel[match.index]) continue;
      const declaration = bindingName(match);
      if (!declaration) { valid = false; continue; }
      if (experiments.has(declaration.name)) valid = false;
      allowedWrites.add(declaration.offset);
      experiments.set(declaration.name, match[3]);
    }
    const helper = /(?:\b(?:var|let|const)\s+|[;,]\s*)([\w$]+)\s*=\s*\(\s*\)\s*=>\s*[\w$]+\.Mv\.getAssignment\(\s*([\w$]+)\s*,\s*(["'])boolean\3\s*,\s*!1\s*\)(?=\s*[,;])/g;
    for (const match of body.matchAll(helper)) {
      if (!topLevel[match.index]) continue;
      const declaration = bindingName(match);
      if (!declaration) { valid = false; continue; }
      if (helpers.has(declaration.name) || experiments.has(declaration.name)) valid = false;
      allowedWrites.add(declaration.offset);
      const experiment = experiments.get(match[2]);
      if (experiment) helpers.set(declaration.name, experiment);
    }
    const names = new Set([...experiments.keys(), ...helpers.keys()]);
    for (const name of names) {
      const escaped = escapeRegExp(name);
      const write = new RegExp(`(^|[^\\w$.])${escaped}\\s*(?:&&=|\\|\\|=|\\?\\?=|\\*\\*=|>>>=|>>=|<<=|\\+=|-=|\\*=|/=|%=|&=|\\|=|\\^=|=(?!=|>))`, 'g');
      for (const match of body.matchAll(write)) {
        const offset = match.index + match[1].length;
        if (topLevel[offset] && !allowedWrites.has(offset)) valid = false;
      }
      const increment = new RegExp(`(^|[^\\w$.])(?:\\+\\+|--)\\s*${escaped}|(^|[^\\w$.])${escaped}\\s*(?:\\+\\+|--)`, 'g');
      for (const match of body.matchAll(increment)) {
        const offset = match.index + (match[1] || match[2] || '').length;
        if (topLevel[offset]) valid = false;
      }
      const declaration = new RegExp(`\\b(?:var|let|const)\\s+${escaped}\\b`, 'g');
      for (const match of body.matchAll(declaration)) {
        const nameOffset = match.index + match[0].lastIndexOf(name);
        if (topLevel[match.index] && !allowedWrites.has(nameOffset)) valid = false;
      }
    }
    if (experiments.size && [...experiments.keys()].some(name => helpers.has(name))) valid = false;
    return { valid, experiments, helpers };
  }
  function stripOuterParens(value) {
    let result = value.trim();
    while (result.startsWith('(') && result.endsWith(')')) {
      let depth = 0, closesAtEnd = false;
      for (let i = 0; i < result.length; i++) {
        if (result[i] === '(') depth++;
        else if (result[i] === ')') {
          depth--;
          if (depth === 0) { closesAtEnd = i === result.length - 1; break; }
          if (depth < 0) break;
        }
      }
      if (!closesAtEnd) break;
      result = result.slice(1, -1).trim();
    }
    return result;
  }
  function zeroArgExpression(source) {
    let body;
    const arrow = source.indexOf('=>');
    if (arrow >= 0) body = source.slice(arrow + 2).trim();
    else {
      const open = source.indexOf('{'), close = source.lastIndexOf('}');
      if (open < 0 || close <= open) return null;
      const returned = /^\s*return\s+([\s\S]*?)\s*;?\s*$/.exec(source.slice(open + 1, close));
      if (!returned) return null;
      body = returned[1];
    }
    const block = /^\{\s*return\s+([\s\S]*?)\s*;?\s*\}$/.exec(body);
    if (block) body = block[1];
    body = body.trim().replace(/;$/, '').trim();
    return body ? stripOuterParens(body) : null;
  }
  function splitTopLevelOr(expression) {
    const parts = [];
    let depth = 0, quote = null, start = 0;
    for (let i = 0; i < expression.length; i++) {
      const ch = expression[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && ch === '|' && expression[i + 1] === '|') {
        parts.push(expression.slice(start, i).trim());
        start = ++i + 1;
      }
      if (depth < 0) return null;
    }
    if (depth !== 0 || quote) return null;
    parts.push(expression.slice(start).trim());
    return parts.every(Boolean) ? parts : null;
  }
  function experimentGate(source, bindings) {
    const expression = zeroArgExpression(source);
    if (!expression || !bindings?.valid) return null;
    const terms = splitTopLevelOr(expression);
    if (!terms) return null;
    const resolved = [];
    for (const raw of terms) {
      const term = stripOuterParens(raw);
      const assignment = /^[\w$]+\.Mv\.getAssignment\(\s*([\w$]+)\s*,\s*(["'])boolean\2\s*,\s*!1\s*\)$/.exec(term);
      if (assignment) {
        const experiment = bindings.experiments.get(assignment[1]);
        if (!experiment) return null;
        resolved.push(experiment);
        continue;
      }
      const helper = /^([\w$]+)\(\)$/.exec(term);
      const experiment = helper && bindings.helpers.get(helper[1]);
      if (!experiment) return null;
      resolved.push(experiment);
    }
    if (!resolved.every(value => value === 'savvy-part-1' || value === 'savvy-part-1-flag' || value === 'savvy-part-2')) return null;
    return resolved;
  }
  function classify(fn, bindings) {
    if (typeof fn !== 'function') return null;
    const source = sourceOf(fn), params = paramsOf(source);
    if (!params) return null;
    if (source.includes('isDvrEligible')) {
      const stream = paramUsing(source, params, 'isDvrEligible'), channel = paramUsing(source, params, 'isAffiliate');
      if (stream < 0 || channel < 0 || stream === channel) return null;
      let special = params.findIndex(p => new RegExp(`if\\(\\s*!?\\s*${escapeRegExp(p)}\\s*\\)`).test(source));
      // The leading special-case check can also be written as a ternary.
      // Only inspect the start of the body; nested conditions can use the viewer.
      if (special < 0 && source.includes('=>')) {
        const body = source.slice(source.indexOf('=>') + 2).trim();
        special = params.findIndex(p => new RegExp(`^\\(?\\s*${escapeRegExp(p)}\\s*\\?`).test(body));
      }
      if (special === stream || special === channel) special = -1;
      return { role: 'eligibility', stream, channel, special };
    }
    // The same module can also export a channel availability reason.
    // It returns strings/null, not eligibility; keep its native function untouched.
    if (params.length === 1 && paramUsing(source, params, 'isParticipatingDJ') === 0 &&
        paramUsing(source, params, 'isAffiliate') === 0 && paramUsing(source, params, 'isPartner') === 0 &&
        /(["'])dj\1/.test(source) && /(["'])not-enabled\1/.test(source)) return { role: 'availabilityReason' };
    // Newer builds also export a savvy-part-2 check for DJs and affiliates. It reads isAffiliate like the
    // channel check does, so tell it apart by isParticipatingDJ; it belongs to the native variant, kept as is.
    if (params.length === 1 && paramUsing(source, params, 'isParticipatingDJ') === 0) return { role: 'djVariant' };
    if (params.length === 1 && paramUsing(source, params, 'isAffiliate') === 0) return { role: 'channel' };
    if (params.length === 0) {
      const experiments = experimentGate(source, bindings);
      if (!experiments) return null;
      if (experiments.length === 1 && experiments[0] === 'savvy-part-2') return { role: 'nativeVariant' };
      if (!experiments.includes('savvy-part-1') && !experiments.includes('savvy-part-1-flag')) return null;
      return { role: 'flag', experiments };
    }
    return null;
  }
  function counted(name) { if (debug) status.calls[name] = (status.calls[name] || 0) + 1; }
  function override(name, info, original) {
    if (info.role === 'availabilityReason' || info.role === 'nativeVariant' || info.role === 'djVariant') return original;
    if (info.role === 'flag') return function () { counted(name); return true; };
    if (info.role === 'channel') return function (channel) {
      counted(name);
      if (channel?.isAffiliate || channel?.isPartner) return true;
      try { return !!Reflect.apply(original, this, arguments); } catch (_) { return false; }
    };
    return function (...args) {
      counted(name);
      const stream = args[info.stream], channel = args[info.channel], specialCase = info.special >= 0 && !!args[info.special];
      let allowed = !!(specialCase || stream?.isDvrEligible || channel?.isAffiliate || channel?.isPartner);
      // Keep any new positive rule a future build adds.
      if (!allowed) try { allowed = !!Reflect.apply(original, this, args); } catch (_) {}
      if (debug) status.lastEligibility = { affiliate: !!channel?.isAffiliate, partner: !!channel?.isPartner, explicitDvrEligible: !!stream?.isDvrEligible, specialCase, allowed };
      return allowed;
    };
  }
  // Returns a plan, null when the exports do not fit, or undefined when they are not initialised yet.
  function buildPlan(definition, bindings) {
    const plan = {}, roles = {};
    const flagExperiments = [];
    if (!bindings?.valid) return null;
    for (const name of Object.keys(definition)) {
      let original;
      try { original = definition[name](); } catch (_) { return undefined; }
      const info = classify(original, bindings);
      if (!info) return null;
      roles[name] = info.role;
      if (info.role === 'flag') flagExperiments.push(...info.experiments);
      plan[name] = override(name, info, original);
    }
    const count = role => Object.values(roles).filter(r => r === role).length;
    // Native rollout exports stay untouched, so any number is safe (some builds export two).
    if (count('eligibility') !== 1 || count('channel') !== 1 || count('flag') < 2 ||
        !flagExperiments.includes('savvy-part-1') || !flagExperiments.includes('savvy-part-1-flag') ||
        count('availabilityReason') > 1 || count('djVariant') > 1) return null;
    status.roles = roles;
    return plan;
  }
  const wrappedFactories = new WeakSet(), inspected = new WeakSet();
  function wrapFactory(original) {
    const bindings = moduleBindings(sourceOf(original));
    const wrapped = function (module, exports, require) {
      status.executed++;
      let intercepted = false;
      const requireProxy = new Proxy(require, { get(target, prop, receiver) {
        if (prop !== 'd') return Reflect.get(target, prop, receiver);
        return function (destination, definition, values) {
          const args = [...arguments];
          const forward = () => Reflect.apply(target.d, this, args);
          if (destination !== exports || !definition || typeof definition !== 'object') return forward();
          intercepted = true;
          // Accessor/prototype-based maps can have side effects when read. Leave
          // unfamiliar helper shapes entirely to Twitch instead of rebuilding them.
          const isPlainMap = map => {
            if (!map || typeof map !== 'object') return false;
            const prototype = Object.getPrototypeOf(map);
            return (prototype === null || prototype === Object.prototype)
              && Object.values(Object.getOwnPropertyDescriptors(map)).every(entry => 'value' in entry);
          };
          if (!isPlainMap(definition) || (values !== undefined && !isPlainMap(values))) {
            status.state = 'unsupported-build';
            return forward();
          }
          // Twitch's require.d accepts (exports, getters, directValues).
          // Keep the argument lists intact: dropping values removes exports and
          // crashes the channel page before the player can mount.
          const direct = values && typeof values === 'object' ? values : {};
          const combined = { ...definition };
          for (const name of Object.keys(direct)) {
            if (!Object.prototype.hasOwnProperty.call(combined, name)) combined[name] = () => direct[name];
          }
          let plan; // undefined: not built yet; null: rejected
          const resolve = () => {
            if (plan !== undefined) return plan;
            const result = buildPlan(combined, bindings);
            if (result === undefined) return null; // circular import reached early; retry next access
            plan = result;
            if (plan) { status.state = 'active'; info('DVR gate active. Actual rewind playback is not yet confirmed.', status.roles); }
            else { status.state = 'unsupported-build'; warn('DVR module exports did not match the expected roles; original behaviour kept.'); }
            return plan;
          };
          const getters = {};
          for (const name of Object.keys(definition)) getters[name] = () => { const p = resolve(); return p ? p[name] : definition[name](); };
          args[1] = getters;
          if (Object.keys(direct).length) {
            const p = resolve();
            // Unknown or not-yet-initialised shapes retain all original values.
            if (p) args[2] = Object.fromEntries(Object.keys(direct).map(name => [name, p[name]]));
          }
          return forward();
        };
      } });
      const factoryArgs = [...arguments];
      factoryArgs[2] = requireProxy;
      const result = Reflect.apply(original, this, factoryArgs);
      if (!intercepted) { status.state = 'unsupported-build'; warn('DVR module no longer exports through require.d; original behaviour kept.'); }
      else if (status.state === 'patched-awaiting-execution') status.state = 'executed-awaiting-use';
      return result;
    };
    wrappedFactories.add(wrapped);
    return wrapped;
  }
  function patchChunk(chunk) {
    if (status.matched || !Array.isArray(chunk) || !chunk[1] || typeof chunk[1] !== 'object') return;
    const modules = chunk[1];
    for (const id of Object.keys(modules)) {
      const factory = modules[id];
      if (typeof factory !== 'function' || wrappedFactories.has(factory) || inspected.has(factory)) continue;
      inspected.add(factory);
      const source = sourceOf(factory);
      if (!MARKERS.every(marker => source.includes(marker))) continue;
      try { modules[id] = wrapFactory(factory); }
      catch (_) { status.state = 'unsupported-build'; return; }
      Object.assign(status, { matched: 1, moduleId: id, verifiedBuild: source === KNOWN_SOURCE, state: 'patched-awaiting-execution' });
      for (const release of releases) release();
      info(status.verifiedBuild ? 'Verified DVR module found.' : 'DVR module found by fingerprint in an unverified build; exports are checked by role before use.', { moduleId: id });
      return;
    }
  }
  function hookQueue(name) {
    const queue = window[name];
    if (!Array.isArray(queue) || queue.push !== Array.prototype.push) return false;
    let downstream = queue.push;
    // A failing scan must never stop Twitch from installing its chunk: the patch is skipped instead.
    const scan = chunk => {
      try { patchChunk(chunk); } catch (error) { status.lastError = String(error); }
    };
    const wrapPush = handler => function (...chunks) {
      if (!status.matched) for (const chunk of chunks) scan(chunk);
      return Reflect.apply(handler, this, chunks);
    };
    let push = wrapPush(downstream);
    const getPush = () => push;
    const setPush = handler => {
      if (typeof handler !== 'function') {
        status.state = 'unsupported-runtime';
        Object.defineProperty(queue, 'push', { value: handler, writable: true, configurable: true });
        return;
      }
      if (handler !== push) { downstream = handler; push = wrapPush(handler); }
    };
    try { Object.defineProperty(queue, 'push', { configurable: true, enumerable: false, get: getPush, set: setPush }); }
    catch (_) { return false; }
    releases.push(() => {
      const descriptor = Object.getOwnPropertyDescriptor(queue, 'push');
      if (descriptor?.get === getPush && descriptor?.set === setPush) {
        // A later hook may have locked our accessor. Keep the now-idle wrapper
        // rather than interrupting Twitch's current chunk installation.
        try { Object.defineProperty(queue, 'push', { configurable: true, enumerable: false, writable: true, value: downstream }); }
        catch (_) {}
      }
    });
    for (const chunk of queue) scan(chunk);
    return true;
  }
  if (!CHUNK_GLOBALS.filter(hookQueue).length) {
    status.state = 'too-late-or-conflict';
    warn('Twitch runtime or another hook already started. Another rewind patch or an early Twitch runtime start may be interfering; reload.');
    return;
  }
  if (!status.matched) status.state = 'waiting-for-module';

  function clearChannelDiagnostics() {
    status.lastEligibility = null;
    events.length = 0;
  }
  function installArchiveBridge() {
    if (typeof window.fetch !== 'function') { bridgeStatus.state = 'unavailable'; return; }
    const bridge = bridgeStatus;
    bridge.state = 'installed';
    const fetchBeforeBridge = window.fetch;
    const cache = new Map();
    const controllers = new Set();
    let generation = 0;
    const channelAtRoute = () => {
      const match = /^\/([a-zA-Z0-9_]+)(?:\/|$)/.exec(location.pathname);
      return match ? match[1].toLowerCase() : null;
    };
    let routeChannel = channelAtRoute();
    bridge.channel = routeChannel;
    syncBridgeRoute = () => {
      const next = channelAtRoute();
      if (next === routeChannel) return generation;
      routeChannel = next;
      generation++;
      cache.clear();
      for (const controller of controllers) controller.abort();
      controllers.clear();
      Object.assign(bridge, { state: 'installed', channel: next, lookups: 0, supplied: 0, failures: 0, last: null });
      clearChannelDiagnostics();
      return generation;
    };
    // Chromium emits this for committed SPA/history navigation. Request/report
    // checks below also invalidate work if the Navigation API is unavailable.
    window.navigation?.addEventListener('currententrychange', syncBridgeRoute);
    const current = (channel, started) => syncBridgeRoute() === started && channel === routeChannel;
    // Names Twitch has used, or plausibly will, for the operation and its channel variable.
    const OPERATIONS = new Set(['DVRVideoIDQuery']);
    const CHANNEL_VARIABLES = ['channelLogin', 'login', 'channel'];

    function requests(input, init) {
      try {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
        const url = new URL(raw, location.href);
        if (url.hostname !== 'gql.twitch.tv' || url.pathname !== '/gql') return [];
        if (typeof init?.body === 'string') return parseBody(init.body);
        if (init?.body == null && typeof Request !== 'undefined' && input instanceof Request) {
          // Clone synchronously before the real fetch consumes the Request body.
          return input.clone().text().then(parseBody, () => []);
        }
        return [];
      } catch (_) { return []; }
    }

    function parseBody(text) {
      try {
        const body = JSON.parse(text);
        return (Array.isArray(body) ? body : [body]).map((op, index) => {
          const name = op.operationName || (/\bquery\s+(\w+)/.exec(op.query || '') || [])[1];
          const channel = CHANNEL_VARIABLES.map(v => op.variables?.[v]).find(v => typeof v === 'string');
          return OPERATIONS.has(name) && channel && /^[a-zA-Z0-9_]+$/.test(channel)
            ? { index, channel: channel.toLowerCase() } : null;
        }).filter(Boolean);
      } catch (_) { return []; }
    }

    // Locate the dvr object wherever the response nests it; refuse if not exactly one.
    function findDvr(value, depth = 0) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 6) return [];
      const found = [];
      for (const [key, child] of Object.entries(value)) {
        if (key === 'dvr' && child && typeof child === 'object' && !Array.isArray(child)) found.push(child);
        else found.push(...findDvr(child, depth + 1));
      }
      return found;
    }

    async function listedArchive(channel, started) {
      const saved = cache.get(channel);
      if (saved && saved.expires > Date.now()) {
        cache.delete(channel); cache.set(channel, saved);
        return saved.promise;
      }
      // Only definite answers stay cached; a failed lookup is retried next time.
      const promise = discover(channel, started).then(result => {
        if (result?.failed) { if (cache.get(channel)?.promise === promise) cache.delete(channel); return result; }
        return result;
      });
      cache.delete(channel);
      cache.set(channel, { expires: Date.now() + 60000, promise });
      if (cache.size > 20) cache.delete(cache.keys().next().value);
      return promise;
    }

    // Returns { id, streamStart }, null for a definite no-match, or { failed: true }.
    async function discover(channel, started) {
      if (!current(channel, started)) return null;
      bridge.lookups++;
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 1500);
      try {
        const response = await Reflect.apply(fetchBeforeBridge, window, ['https://gql.twitch.tv/gql', {
          method: 'POST', credentials: 'omit', signal: controller.signal,
          headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ variables: { login: channel },
            query: `query($login: String!) {
              user(login: $login) {
                stream { id createdAt }
                videos(first: 5, type: ARCHIVE, sort: TIME) { edges { node { id createdAt status } } }
              }
            }`,
          }),
        }]);
        if (!response.ok) return { failed: true };
        const json = await response.json();
        if (json.errors?.length) return { failed: true };
        const start = Date.parse(json.data?.user?.stream?.createdAt);
        if (!Number.isFinite(start)) return null;
        const candidates = (json.data?.user?.videos?.edges || []).map(edge => edge?.node).filter(node => {
          const archiveStart = Date.parse(node?.createdAt);
          return /^\d+$/.test(String(node?.id || '')) && String(node?.status ?? '').toUpperCase() === 'RECORDING'
            && Number.isFinite(archiveStart) && Math.abs(archiveStart - start) <= 120000;
        });
        // Refuse stale, ambiguous, offline, or unlisted archives. Timestamp matching
        // is still a heuristic; native playback remains subject to normal access.
        return candidates.length === 1 ? { id: String(candidates[0].id), streamStart: start } : null;
      } catch (_) { return { failed: true }; }
      finally { clearTimeout(timeout); controllers.delete(controller); }
    }

    window.fetch = function (input, init) {
      const selected = requests(input, init);
      const pending = Reflect.apply(fetchBeforeBridge, this, arguments);
      if (Array.isArray(selected) && !selected.length) return pending;
      const started = syncBridgeRoute();
      return pending.then(async response => {
        if (!response.ok) return response;
        try {
          const operations = await selected;
          if (!operations.length) return response;
          const json = await response.clone().json();
          const rows = Array.isArray(json) ? json : [json];
          let changed = false;
          const additions = [];
          // Start required lookups together: one slow lookup does not multiply
          // the 1.5-second timeout by the number of DVR operations in a batch.
          await Promise.all(operations.map(async op => {
            if (!current(op.channel, started)) return;
            const row = rows[op.index];
            if (row?.errors?.length) return;
            const matches = findDvr(row?.data);
            if (matches.length !== 1) return;
            const dvr = matches[0];
            // Only fill a vod ID field the server already returned empty; never invent one.
            const field = Object.keys(dvr).find(k => /^vod_?id$/i.test(k));
            if (!field || dvr[field]) return;
            const archive = await listedArchive(op.channel, started);
            if (!current(op.channel, started)) return;
            if (archive?.failed) {
              bridge.failures++;
              bridge.last = { channel: op.channel, matchingArchiveFound: false, lookupFailed: true };
              bridge.state = 'lookup-failed';
              return;
            }
            bridge.last = { channel: op.channel, matchingArchiveFound: !!archive };
            if (!archive) { bridge.state = 'no-matching-public-archive'; return; }
            dvr[field] = archive.id;
            changed = true;
            additions.push(op.channel);
          }));
          if (!changed || syncBridgeRoute() !== started) return response;
          const headers = new Headers(response.headers);
          headers.delete('content-length'); headers.delete('content-encoding');
          headers.set('content-type', 'application/json');
          // Only the missing vod ID changes. Tokens and playback requests are never
          // rewritten. A synthetic response does not retain URL/redirect metadata.
          const patched = new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers });
          bridge.supplied += additions.length;
          bridge.state = 'archive-id-supplied';
          if (debug) for (const channel of additions) {
            events.push({ event: 'bridge-archive-supplied', channel, vodIDPresent: true });
            if (events.length > 40) events.shift();
            info('Supplied a matching publicly listed archive ID for', channel);
          }
          return patched;
        } catch (_) { return response; }
      });
    };
  }
};

export default rewind;
