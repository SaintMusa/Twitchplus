// @ts-nocheck
// Adds a chat history panel (archived and live messages) to Twitch viewer cards.
// Network: logs.zonian.dev (archived lines), anonymous Twitch IRC (live lines), emote APIs (7TV, BTTV, FFZ),
// api.ivr.fi, and api.twitch.tv, which gets the viewer's own Twitch token for chat badges.
import type { Module } from '../modules';

declare global {
  interface Window {
    __twitchPlusViewerLogs?: boolean;
  }
}

const viewerLogs: Module = () => {
  if (window.__twitchPlusViewerLogs) return;
  window.__twitchPlusViewerLogs = true;
  const run = () => {
    try {
    const ZONIAN_BASE_URL = 'https://logs.zonian.dev';
    const MSG_SOURCE_LOGS = 'logs';
    const MSG_SOURCE_LIVE = 'live';
    const MESSAGES_PER_PAGE = 10;
    const LOGS_FETCH_LIMIT = 50; // Max messages fetched per month from the mirror API
    const MAX_LOGS_HEIGHT = '250px';
    const EMOTE_SIZE = '1.2em'; // Size of emotes in chat
    const MAX_EMOTE_CACHE_ENTRIES = 20;
    const MAX_USER_COLOR_CACHE_ENTRIES = 500;
    const MAX_RENDERED_MESSAGES = 400;
    const EMOTE_CACHE_TTL_MS = 30 * 60 * 1000;
    const CHANNEL_ID_CACHE_TTL_MS = 60 * 60 * 1000;
    const USER_COLOR_CACHE_TTL_MS = 10 * 60 * 1000;
    const BADGE_CACHE_TTL_MS = 60 * 60 * 1000;
    const IRC_WS_URL = 'wss://irc-ws.chat.twitch.tv:443';
    const MAX_SEEN_MESSAGE_IDS = 5000; // Limit seenMessageIds Set size
    const DUPLICATE_CHECK_WINDOW_MS = 5000; // Window for checking duplicate messages

    // Emote cache: { channelId: { emotes: Map<name, url>, loading: Promise, loaded: boolean } }
    const emoteCache = new Map();
    // Channel ID cache: { channelName: channelId }
    const channelIdCache = new Map();
    const channelIdInflight = new Map(); // lower login -> Promise (dedupe parallel emote + badge loads)

    const LOG_AVAILABILITY_TTL_MS = 60 * 1000;
    const logAvailabilityCache = new Map(); // key -> { daysList, expiresAt }
    const logAvailabilityInflight = new Map(); // key -> Promise
    // User color cache: { username: color }
    const userColorCache = new Map();
    // Track current channel for preloading
    let currentChannel = null;
    const ircSockets = new Map();

    // Pre-compiled regex patterns for performance
    const INVISIBLE_CHARS_REGEX = /[\u200B\u200C\u200D\uFE00-\uFE0F\u00AD\u180E\u2060\u2063\u034F]/g;
    const WHITESPACE_REGEX = /(\s+)/;
    const WHITESPACE_ONLY_REGEX = /^\s+$/;
    const LINK_PROTOCOL_REGEX = /^(https?:\/\/)/i;
    const LINK_WWW_REGEX = /^(www\.)/i;
    const LINK_DOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:[/?#][^\s]*)?$/i;
    const LINK_LEADING_PUNCT_REGEX = /^[\(\[\{<"']/;
    const LINK_TRAILING_PUNCT_REGEX = /[\)\]\}>",.!?;:]+$/;

    // User info cache (consolidates channel ID and user creation date lookups)
    const userInfoCache = new Map();
    const accountCreatedRenderState = new WeakMap();
    // Badge cache: { cacheKey -> { badges: Map<setId, Map<version, url>>, expiresAt } }
    const badgeCache = new Map();

    // Track active viewer card states for cleanup (using numeric IDs to avoid closure issues)
    let nextStateId = 0;
    const activeStates = new Map(); // stateId -> state

    // Get cached timestamp in milliseconds (caches on message object for reuse)
    function getTimestampMs(msg) {
        if (msg._timestampMs !== undefined) return msg._timestampMs;
        if (msg.timestamp instanceof Date) {
            const ms = msg.timestamp.getTime();
            msg._timestampMs = Number.isFinite(ms) ? ms : 0;
        } else {
            msg._timestampMs = 0;
        }
        return msg._timestampMs;
    }

    function compareMessages(a, b) {
        const timeDiff = getTimestampMs(a) - getTimestampMs(b);
        if (timeDiff !== 0) return timeDiff;

        const userA = (a.username || '').toLowerCase();
        const userB = (b.username || '').toLowerCase();
        if (userA !== userB) return userA < userB ? -1 : 1;

        const msgA = a.message || '';
        const msgB = b.message || '';
        if (msgA !== msgB) return msgA < msgB ? -1 : 1;

        return 0;
    }

    function insertMessageSorted(messages, msg) {
        let low = 0;
        let high = messages.length;

        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (compareMessages(messages[mid], msg) <= 0) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        messages.splice(low, 0, msg);
    }

    // Get cached message ID (caches on message object for reuse)
    function getMessageId(msg) {
        if (msg._id) return msg._id;
        const timestamp = Math.floor(getTimestampMs(msg) / 1000);
        msg._id = `${msg.username.toLowerCase()}-${timestamp}-${msg.message}`;
        return msg._id;
    }

    function pruneSeenMessageIds(seenMessageIds) {
        if (seenMessageIds.size <= MAX_SEEN_MESSAGE_IDS) return;
        const toRemove = seenMessageIds.size - MAX_SEEN_MESSAGE_IDS;
        let removed = 0;
        for (const key of seenMessageIds) {
            seenMessageIds.delete(key);
            removed++;
            if (removed >= toRemove) break;
        }
    }

    // Helper to normalize FFZ URLs (protocol-relative to https)
    function normalizeUrl(url) {
        return url.startsWith('//') ? 'https:' + url : url;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function withBackoff(task, retries = 3, baseDelayMs = 300) {
        let attempt = 0;
        while (true) {
            try {
                return await task();
            } catch (error) {
                if (error && typeof error.message === 'string') {
                    if (error.message === 'Not found' || error.message.includes('HTTP 404')) {
                        throw error;
                    }
                }
                if (attempt >= retries) {
                    throw error;
                }
                const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
                await sleep(delay);
                attempt++;
            }
        }
    }

    function getAnonNick() {
        return `justinfan${Math.floor(Math.random() * 100000)}`;
    }

    function formatDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) return null;

        const units = [
            { label: 'd', value: 86400 },
            { label: 'h', value: 3600 },
            { label: 'm', value: 60 },
            { label: 's', value: 1 }
        ];

        let remaining = seconds;
        const parts = [];
        for (const unit of units) {
            if (remaining < unit.value) continue;
            const count = Math.floor(remaining / unit.value);
            remaining -= count * unit.value;
            parts.push(`${count}${unit.label}`);
            if (parts.length === 2) break;
        }

        return parts.length ? parts.join(' ') : `${seconds}s`;
    }

    // Decode IRC tag escape sequences (\s → space, \: → ;, \\ → \, etc.)
    function decodeIrcTagValue(value) {
        if (!value) return '';
        return value
            .replace(/\\s/g, ' ')
            .replace(/\\:/g, ';')
            .replace(/\\\\/g, '\\')
            .replace(/\\r/g, '\r')
            .replace(/\\n/g, '\n');
    }

    // Human-readable badge title with sub-month info from badge-info tag
    function getBadgeTitle(setId, version, badgeInfo) {
        if (setId === 'subscriber' && badgeInfo) {
            const entry = badgeInfo.split(',').find(b => b.startsWith('subscriber/'));
            if (entry) {
                const months = entry.split('/')[1];
                return `Subscriber (${months} month${months === '1' ? '' : 's'})`;
            }
        }
        if (setId === 'predictions' && version) {
            return `Prediction (${version})`;
        }
        if (setId === 'hype-train' && version) {
            return `Hype Train (${version})`;
        }
        const pretty = setId.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        return version && version !== '1' ? `${pretty} (${version})` : pretty;
    }

    function getIrcSocket(channel) {
        const key = channel.toLowerCase();
        if (ircSockets.has(key)) {
            return ircSockets.get(key);
        }

        const socket = new WebSocket(IRC_WS_URL);
        const entry = {
            socket,
            channel: key,
            subscribers: new Set(),
            open: false,
            closed: false
        };
        ircSockets.set(key, entry);

        socket.addEventListener('open', () => {
            entry.open = true;
            socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
            socket.send('PASS SCHMOOPIIE');
            socket.send(`NICK ${getAnonNick()}`);
            socket.send(`JOIN #${key}`);
        });

        socket.addEventListener('message', (event) => {
            const raw = String(event.data || '');
            const lines = raw.split(/\r?\n/).filter(Boolean);
            for (const line of lines) {
                if (line.startsWith('PING')) {
                    socket.send(line.replace('PING', 'PONG'));
                    continue;
                }
                for (const state of entry.subscribers) {
                    if (!state.isLive) continue;
                    handleIrcLineForState(line, state);
                }
            }
        });

        const handleClose = () => {
            entry.closed = true;
            entry.open = false;
            for (const state of entry.subscribers) {
                state.unsubscribeIrc = null;
                if (state.isLive) {
                    state.liveMode = 'disconnected';
                    const root = state.container && state.container.closest('.enhancer-chatlogs');
                    if (root) updateHeaderMeta(root, state);
                }
            }
            entry.subscribers.clear();
            ircSockets.delete(key);
        };

        socket.addEventListener('close', handleClose);
        socket.addEventListener('error', handleClose);

        return entry;
    }

    function handleIrcLineForState(line, state) {
        if (!state.container || !document.contains(state.container)) return;
        const parsed = parseIRCMessage(line);
        if (!parsed) return;
        if (parsed.username.toLowerCase() !== state.username.toLowerCase()) return;

        const msgId = getMessageId(parsed);
        if (state.seenMessageIds.has(msgId)) return;
        if (isLikelyDuplicate(parsed, state.allMessages)) {
            state.seenMessageIds.add(msgId);
            pruneSeenMessageIds(state.seenMessageIds);
            return;
        }

        state.seenMessageIds.add(msgId);
        pruneSeenMessageIds(state.seenMessageIds);
        insertMessageSorted(state.allMessages, parsed);

        appendLiveMessages(state.container, [parsed], state);
    }

    function subscribeIrc(channel, state) {
        const entry = getIrcSocket(channel);
        entry.subscribers.add(state);
        return () => {
            entry.subscribers.delete(state);
            if (entry.subscribers.size === 0) {
                entry.socket.close();
                ircSockets.delete(channel.toLowerCase());
            }
        };
    }

    // Get user's chat color from the current chat or viewer card
    function getUserColor(username) {
        if (!username) return '#bf94ff';

        try {
            const lowerUsername = username.toLowerCase();

            // Check cache first
            if (userColorCache.has(lowerUsername)) {
                const cached = userColorCache.get(lowerUsername);
                if (cached && cached.expiresAt > Date.now()) {
                    return cached.color;
                }
                userColorCache.delete(lowerUsername);
            }

            // Try to find the user's color from chat messages
            const chatLines = document.querySelectorAll('.chat-line__message[data-user="' + lowerUsername + '"]');
            for (const line of chatLines) {
                const usernameSpan = line.querySelector('.chat-line__username');
                if (usernameSpan && usernameSpan.style && usernameSpan.style.color) {
                    if (userColorCache.size >= MAX_USER_COLOR_CACHE_ENTRIES) {
                        const oldestKey = userColorCache.keys().next().value;
                        if (oldestKey) {
                            userColorCache.delete(oldestKey);
                        }
                    }
                    userColorCache.set(lowerUsername, {
                        color: usernameSpan.style.color,
                        expiresAt: Date.now() + USER_COLOR_CACHE_TTL_MS
                    });
                    return usernameSpan.style.color;
                }
            }
        } catch {
            // A malformed username can make the selector invalid; fall back to the default color.
        }

        return '#bf94ff';
    }

    // Get channel ID from Twitch GQL (needed for emote APIs)
    async function getChannelId(channelName) {
        if (channelIdCache.has(channelName)) {
            const cached = channelIdCache.get(channelName);
            if (cached && cached.expiresAt > Date.now()) {
                return cached.id;
            }
            channelIdCache.delete(channelName);
        }

        const lowerChannelName = channelName.toLowerCase();
        if (channelIdInflight.has(lowerChannelName)) {
            return channelIdInflight.get(lowerChannelName);
        }

        const promise = (async () => {
            try {
                // Try to get from Twitch's internal state first
                const twitchState = window.__APOLLO_CLIENT__?.cache?.data?.data;
                if (twitchState) {
                    for (const [key, value] of Object.entries(twitchState)) {
                        if (key.startsWith('User:') && value?.login?.toLowerCase() === lowerChannelName) {
                            const id = key.slice(5); // 'User:'.length === 5
                            channelIdCache.set(channelName, {
                                id,
                                expiresAt: Date.now() + CHANNEL_ID_CACHE_TTL_MS
                            });
                            return id;
                        }
                    }
                }

                // Fallback: use consolidated fetchUserInfo (avoids duplicate API calls)
                const userInfo = await fetchUserInfo(channelName);
                if (userInfo?.id) {
                    channelIdCache.set(channelName, {
                        id: userInfo.id,
                        expiresAt: Date.now() + CHANNEL_ID_CACHE_TTL_MS
                    });
                    return userInfo.id;
                }
            } catch (e) {
                console.error('[Twitch Plus] Failed to get channel ID:', e);
            }

            return null;
        })().finally(() => {
            channelIdInflight.delete(lowerChannelName);
        });

        channelIdInflight.set(lowerChannelName, promise);
        return promise;
    }

    // Fetch 7TV emotes for a channel (global + channel requests in parallel)
    async function fetch7TVEmotes(channelId) {
        const emotes = new Map();

        const globalP = fetch('https://7tv.io/v3/emote-sets/global')
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null);
        const channelP = channelId
            ? fetch(`https://7tv.io/v3/users/twitch/${channelId}`)
                .then(r => (r.ok ? r.json() : null))
                .catch(() => null)
            : Promise.resolve(null);

        const [globalData, channelData] = await Promise.all([globalP, channelP]);

        if (globalData?.emotes) {
            for (const emote of globalData.emotes) {
                const url = `https://cdn.7tv.app/emote/${emote.id}/1x.webp`;
                emotes.set(emote.name, { url, provider: '7tv' });
            }
        }
        if (channelData?.emote_set?.emotes) {
            for (const emote of channelData.emote_set.emotes) {
                const url = `https://cdn.7tv.app/emote/${emote.id}/1x.webp`;
                emotes.set(emote.name, { url, provider: '7tv' });
            }
        }

        return emotes;
    }

    // Fetch BTTV emotes for a channel (global + channel in parallel)
    async function fetchBTTVEmotes(channelId) {
        const emotes = new Map();

        const globalP = fetch('https://api.betterttv.net/3/cached/emotes/global')
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null);
        const channelP = channelId
            ? fetch(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`)
                .then(r => (r.ok ? r.json() : null))
                .catch(() => null)
            : Promise.resolve(null);

        const [globalData, channelData] = await Promise.all([globalP, channelP]);

        if (globalData && Array.isArray(globalData)) {
            for (const emote of globalData) {
                const url = `https://cdn.betterttv.net/emote/${emote.id}/1x`;
                emotes.set(emote.code, { url, provider: 'bttv' });
            }
        }
        if (channelData) {
            const allEmotes = [...(channelData.channelEmotes || []), ...(channelData.sharedEmotes || [])];
            for (const emote of allEmotes) {
                const url = `https://cdn.betterttv.net/emote/${emote.id}/1x`;
                emotes.set(emote.code, { url, provider: 'bttv' });
            }
        }

        return emotes;
    }

    // Fetch FFZ emotes for a channel (global + channel in parallel)
    async function fetchFFZEmotes(channelId) {
        const emotes = new Map();

        const globalP = fetch('https://api.frankerfacez.com/v1/set/global')
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null);
        const channelP = channelId
            ? fetch(`https://api.frankerfacez.com/v1/room/id/${channelId}`)
                .then(r => (r.ok ? r.json() : null))
                .catch(() => null)
            : Promise.resolve(null);

        const [globalData, channelData] = await Promise.all([globalP, channelP]);

        if (globalData) {
            for (const setId of globalData.default_sets || []) {
                const set = globalData.sets?.[setId];
                if (set?.emoticons) {
                    for (const emote of set.emoticons) {
                        const url = emote.urls['1'] || emote.urls['2'] || Object.values(emote.urls)[0];
                        if (url) {
                            emotes.set(emote.name, { url: normalizeUrl(url), provider: 'ffz' });
                        }
                    }
                }
            }
        }
        if (channelData) {
            for (const set of Object.values(channelData.sets || {})) {
                for (const emote of set.emoticons || []) {
                    const url = emote.urls['1'] || emote.urls['2'] || Object.values(emote.urls)[0];
                    if (url) {
                        emotes.set(emote.name, { url: normalizeUrl(url), provider: 'ffz' });
                    }
                }
            }
        }

        return emotes;
    }

    // Fetch Twitch emotes using emotes.adamcy.pl (global + channel in parallel)
    async function fetchTwitchEmotes(channelName) {
        const emotes = new Map();

        const globalP = fetch('https://emotes.adamcy.pl/v1/global/emotes/twitch')
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null);
        const channelP = channelName
            ? fetch(`https://emotes.adamcy.pl/v1/channel/${encodeURIComponent(channelName)}/emotes/twitch`)
                .then(r => (r.ok ? r.json() : null))
                .catch(() => null)
            : Promise.resolve(null);

        const [globalData, channelData] = await Promise.all([globalP, channelP]);

        if (globalData && Array.isArray(globalData)) {
            for (const emote of globalData) {
                if (emote.code && emote.urls && emote.urls.length > 0) {
                    const url = emote.urls.find(u => u.size === '1x')?.url || emote.urls[0]?.url;
                    if (url) {
                        emotes.set(emote.code, { url, provider: 'twitch' });
                    }
                }
            }
        }

        if (channelData && Array.isArray(channelData)) {
            for (const emote of channelData) {
                if (emote.code && emote.urls && emote.urls.length > 0) {
                    const url = emote.urls.find(u => u.size === '1x')?.url || emote.urls[0]?.url;
                    if (url) {
                        emotes.set(emote.code, { url, provider: 'twitch' });
                    }
                }
            }
        }

        return emotes;
    }

    // Load all emotes for a channel
    async function loadEmotesForChannel(channelName) {
        const cacheKey = channelName.toLowerCase();

        // Return existing cache if available
        if (emoteCache.has(cacheKey)) {
            const cached = emoteCache.get(cacheKey);
            if (cached.expiresAt && cached.expiresAt <= Date.now()) {
                emoteCache.delete(cacheKey);
            } else if (cached.loaded) {
                return cached.emotes;
            } else if (cached.loading) {
                await cached.loading;
                return cached.emotes;
            }
        }

        // Simple cache cap (evict oldest)
        if (emoteCache.size >= MAX_EMOTE_CACHE_ENTRIES) {
            const oldestKey = emoteCache.keys().next().value;
            if (oldestKey) {
                emoteCache.delete(oldestKey);
            }
        }

        // Create cache entry with loading promise
        const cacheEntry = {
            emotes: new Map(),
            loaded: false,
            loading: null,
            expiresAt: Date.now() + EMOTE_CACHE_TTL_MS
        };
        emoteCache.set(cacheKey, cacheEntry);

        cacheEntry.loading = (async () => {
            const channelId = await getChannelId(channelName);

            // Fetch all emote sources in parallel
            const [sevenTVEmotes, bttvEmotes, ffzEmotes, twitchEmotes] = await Promise.all([
                fetch7TVEmotes(channelId),
                fetchBTTVEmotes(channelId),
                fetchFFZEmotes(channelId),
                fetchTwitchEmotes(channelName)
            ]);

            // Merge all emotes efficiently (7TV takes priority, then BTTV, FFZ, Twitch)
            cacheEntry.emotes = new Map([
                ...twitchEmotes,
                ...ffzEmotes,
                ...bttvEmotes,
                ...sevenTVEmotes
            ]);

            cacheEntry.loaded = true;
            cacheEntry.expiresAt = Date.now() + EMOTE_CACHE_TTL_MS;
        })();

        await cacheEntry.loading;
        return cacheEntry.emotes;
    }

    // Fill a badge container element with badge images for the given badges string
    function fillBadges(container, badgesStr, badgeInfo, badgeData) {
        container.innerHTML = '';
        if (!badgesStr || !badgeData || badgeData.size === 0) return;
        for (const part of badgesStr.split(',')) {
            const slashIdx = part.indexOf('/');
            if (slashIdx === -1) continue;
            const setId = part.slice(0, slashIdx);
            const version = part.slice(slashIdx + 1);
            const versionMap = badgeData.get(setId);
            if (!versionMap) continue;
            const url = versionMap.get(version) || versionMap.get('1') || versionMap.values().next().value;
            if (!url) continue;
            const img = document.createElement('img');
            img.src = url;
            img.alt = setId;
            img.title = getBadgeTitle(setId, version, badgeInfo);
            img.className = 'chatlogs-badge';
            img.onerror = () => img.remove();
            container.appendChild(img);
        }
    }

    // Insert badges into already-rendered message elements (called after badge data loads)
    function rerenderBadges(container, state) {
        if (!state.badges || state.badges.size === 0) return;
        requestAnimationFrame(() => {
            for (const msgEl of container.querySelectorAll('.chatlogs-message[data-badges]')) {
                const badgesContainer = msgEl.querySelector('.chatlogs-badges-container');
                if (!badgesContainer) continue;
                fillBadges(
                    badgesContainer,
                    msgEl.dataset.badges || '',
                    msgEl.dataset.badgeInfo || '',
                    state.badges
                );
            }
        });
    }

    // Hardcoded CDN URLs for common global badges, used when Helix is unavailable or the user is logged out.
    // Helix (see fetchAllHelixBadgeJson) is the source of truth when logged in.
    const FALLBACK_GLOBAL_BADGES = {
        moderator:    { 1: 'https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/1' },
        vip:          { 1: 'https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/1' },
        broadcaster:  { 1: 'https://static-cdn.jtvnw.net/badges/v1/5527c58c-fb7d-422d-b71b-f309dcb85cc1/1' },
        partner:      { 1: 'https://static-cdn.jtvnw.net/badges/v1/d12a2e27-16f6-41d0-ab77-b780518f00a3/1' },
        staff:        { 1: 'https://static-cdn.jtvnw.net/badges/v1/d97c37bd-a6f5-4c38-8f57-4e4bef88af34/1' },
        premium:      { 1: 'https://static-cdn.jtvnw.net/badges/v1/bbbe0db0-a598-423e-86d0-f9fb98ca1933/1' },
        founder:      { 1: 'https://static-cdn.jtvnw.net/badges/v1/511b78a9-ab37-472f-9569-457753bbe7d3/1' },
        subscriber:   { 1: 'https://static-cdn.jtvnw.net/badges/v1/5d9f2208-5dd8-11e7-8513-2ff4adfae661/1' },
        'sub-gifter': {
            1: 'https://static-cdn.jtvnw.net/badges/v1/f1d8486f-eb2e-4553-b44f-4d614617afc1/1',
            5: 'https://static-cdn.jtvnw.net/badges/v1/3e638e02-b765-4070-81bd-a73d1ae34965/1',
            10: 'https://static-cdn.jtvnw.net/badges/v1/bffca343-9d7d-49b4-a1ca-90af2c6a1639/1',
            25: 'https://static-cdn.jtvnw.net/badges/v1/17e09e26-2528-4a04-9c7f-8518348324d1/1',
            50: 'https://static-cdn.jtvnw.net/badges/v1/47308ed4-c979-4f3f-ad20-35a8ab76d85d/1',
            100: 'https://static-cdn.jtvnw.net/badges/v1/5056c366-7299-4b3c-a15a-a18573650bfb/1',
            250: 'https://static-cdn.jtvnw.net/badges/v1/df25dded-df81-408e-a2d3-40d48f0d529f/1',
            500: 'https://static-cdn.jtvnw.net/badges/v1/f440decb-7468-4bf9-8666-98ba74f6eab5/1',
            1000: 'https://static-cdn.jtvnw.net/badges/v1/b8c76744-c7e9-44be-90d0-08840a8f6e39/1'
        },
        turbo:        { 1: 'https://static-cdn.jtvnw.net/badges/v1/bd444ec6-8f34-4bf9-91f4-af1e3428d80f/1' },
        global_mod:   { 1: 'https://static-cdn.jtvnw.net/badges/v1/9384c43e-b98b-4f39-8193-3d193a4b75a0/1' },
        'artist-badge': { 1: 'https://static-cdn.jtvnw.net/badges/v1/4300a897-03dc-4e83-8c0e-c332fee7057f/1' },
        no_audio:     { 1: 'https://static-cdn.jtvnw.net/badges/v1/aef2cd08-f29b-45a1-8c12-d44d7fd5e6f0/1' },
        no_video:     { 1: 'https://static-cdn.jtvnw.net/badges/v1/199a0dba-58f3-494e-a7fc-1fa0a1001fb8/1' },
        bits: {
            1: 'https://static-cdn.jtvnw.net/badges/v1/73b5c3fb-24f9-4a82-a852-2f475b59411c/1',
            100: 'https://static-cdn.jtvnw.net/badges/v1/09d93036-e7ce-431c-9a9e-7044297133f2/1',
            1000: 'https://static-cdn.jtvnw.net/badges/v1/0d85a29e-79ad-4c63-a285-3acd2c66f2ba/1',
            5000: 'https://static-cdn.jtvnw.net/badges/v1/57cd97fc-3e9e-4c6d-9d41-60147137234e/1',
            10000: 'https://static-cdn.jtvnw.net/badges/v1/68af213b-a771-4124-b6e3-9bb6d98aa732/1',
            25000: 'https://static-cdn.jtvnw.net/badges/v1/64ca5920-c663-4bd8-bfb1-751b4caea2dd/1',
            50000: 'https://static-cdn.jtvnw.net/badges/v1/62310ba7-9916-4235-9eba-40110d67f85d/1',
            75000: 'https://static-cdn.jtvnw.net/badges/v1/ce491fa4-b24f-4f3b-b6ff-44b080202792/1',
            100000: 'https://static-cdn.jtvnw.net/badges/v1/96f0540f-aa63-49e1-a8b3-259ece3bd098/1',
            200000: 'https://static-cdn.jtvnw.net/badges/v1/4a0b90c4-e4ef-407f-84fe-36b14aebdbb6/1',
            300000: 'https://static-cdn.jtvnw.net/badges/v1/ac13372d-2e94-41d1-ae11-ecd677f69bb6/1',
            400000: 'https://static-cdn.jtvnw.net/badges/v1/a8f393af-76e6-4aa2-9dd0-7dcc1c34f036/1',
            500000: 'https://static-cdn.jtvnw.net/badges/v1/f6932b57-6a6e-4062-a770-dfbd9f4302e5/1',
            600000: 'https://static-cdn.jtvnw.net/badges/v1/4d908059-f91c-4aef-9acb-634434f4c32e/1',
            700000: 'https://static-cdn.jtvnw.net/badges/v1/a1d2a824-f216-4b9f-9642-3de8ed370957/1',
            800000: 'https://static-cdn.jtvnw.net/badges/v1/5ec2ee3e-5633-4c2a-8e77-77473fe409e6/1',
            900000: 'https://static-cdn.jtvnw.net/badges/v1/088c58c6-7c38-45ba-8f73-63ef24189b84/1',
            1000000: 'https://static-cdn.jtvnw.net/badges/v1/494d1c8e-c3b2-4d88-8528-baff57c9bd3f/1'
        }
    };

    function getFallbackBadgeMap() {
        const badges = new Map();
        for (const [setId, versions] of Object.entries(FALLBACK_GLOBAL_BADGES)) {
            const versionMap = new Map();
            for (const [ver, url] of Object.entries(versions)) {
                versionMap.set(String(ver), url);
            }
            badges.set(setId, versionMap);
        }
        return badges;
    }

    /** Merge fallback versions into Helix maps (fill gaps; never overwrite API URLs). */
    function mergeFallbackBadgeVersions(badges, fallback) {
        for (const [setId, fallbackVersions] of fallback) {
            if (!badges.has(setId)) {
                badges.set(setId, new Map(fallbackVersions));
                continue;
            }
            const existing = badges.get(setId);
            for (const [ver, url] of fallbackVersions) {
                if (!existing.has(ver)) {
                    existing.set(ver, url);
                }
            }
        }
    }

    /**
     * Twitch paginates badge sets (default page size is small). Without paging, sets like
     * predictions / hype-train may never appear in the first page.
     */
    async function fetchAllHelixBadgeJson(baseUrl, headers) {
        const merged = [];
        let cursor = null;
        for (let guard = 0; guard < 25; guard++) {
            const u = new URL(baseUrl);
            u.searchParams.set('first', '100');
            if (cursor) {
                u.searchParams.set('after', cursor);
            }
            const res = await fetch(u.toString(), { headers });
            if (!res.ok) {
                return merged.length ? { data: merged } : null;
            }
            const json = await res.json();
            if (Array.isArray(json.data)) {
                merged.push(...json.data);
            }
            cursor = json.pagination && json.pagination.cursor ? json.pagination.cursor : null;
            if (!cursor) break;
        }
        return { data: merged };
    }

    // Read Twitch auth credentials from the page context (readable from localStorage on twitch.tv).
    function getTwitchApiCredentials() {
        try {
            const authToken = (localStorage.getItem('auth-token') || '')
                .trim()
                .replace(/^"|"$/g, '')
                .replace(/^OAuth\s+/i, '');
            // Twitch's own web-app client ID (publicly known, used for all twitch.tv GQL requests)
            const clientId = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
            if (authToken) return { authToken, clientId };
        } catch (e) { /* localStorage may be blocked in some browser configs */ }
        return null;
    }

    async function loadBadgesForChannel(channel) {
        const channelId = await getChannelId(channel);
        const cacheKey = channelId || 'global';

        if (badgeCache.has(cacheKey)) {
            const cached = badgeCache.get(cacheKey);
            if (cached.expiresAt > Date.now()) return cached.badges;
            badgeCache.delete(cacheKey);
        }

        const badges = new Map(); // setId -> Map<version, imageUrl>

        // Helix API returns: { data: [{ set_id, versions: [{ id, image_url_1x, ... }] }] }
        function parseHelixBadges(data) {
            if (!data || !Array.isArray(data.data)) return;
            for (const badge of data.data) {
                const versionMap = new Map();
                for (const ver of badge.versions || []) {
                    const url = ver.image_url_1x || ver.image_url_2x;
                    if (url) versionMap.set(String(ver.id), url);
                }
                if (versionMap.size === 0) continue;
                const setId = badge.set_id;
                if (badges.has(setId)) {
                    const prev = badges.get(setId);
                    for (const [k, v] of versionMap) {
                        if (!prev.has(k)) prev.set(k, v);
                    }
                } else {
                    badges.set(setId, versionMap);
                }
            }
        }

        const creds = getTwitchApiCredentials();
        if (creds) {
            const headers = {
                'Authorization': `Bearer ${creds.authToken}`,
                'Client-ID': creds.clientId,
            };
            try {
                const globalP = fetchAllHelixBadgeJson('https://api.twitch.tv/helix/chat/badges/global', headers)
                    .catch(() => null);
                const channelP = channelId
                    ? fetchAllHelixBadgeJson(
                        `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${encodeURIComponent(channelId)}`,
                        headers
                    ).catch(() => null)
                    : Promise.resolve(null);
                const [globalJson, channelJson] = await Promise.all([globalP, channelP]);
                if (globalJson) parseHelixBadges(globalJson);
                if (channelJson) parseHelixBadges(channelJson);
            } catch {
                // Helix is best effort; fallback badges are merged below.
            }
        }

        mergeFallbackBadgeVersions(badges, getFallbackBadgeMap());

        badgeCache.set(cacheKey, { badges, expiresAt: Date.now() + BADGE_CACHE_TTL_MS });
        return badges;
    }

    // Parse the IRC emotes tag into a sorted array of { id, start, end }
    function parseEmotePositions(emoteTag) {
        if (!emoteTag) return [];
        const result = [];
        for (const part of emoteTag.split('/')) {
            const colonIdx = part.indexOf(':');
            if (colonIdx === -1) continue;
            const emoteId = part.slice(0, colonIdx);
            for (const range of part.slice(colonIdx + 1).split(',')) {
                const dashIdx = range.indexOf('-');
                if (dashIdx === -1) continue;
                const start = parseInt(range.slice(0, dashIdx), 10);
                const end = parseInt(range.slice(dashIdx + 1), 10);
                if (!isNaN(start) && !isNaN(end)) result.push({ id: emoteId, start, end });
            }
        }
        return result.sort((a, b) => a.start - b.start);
    }

    // Render a message using IRC emote position data (precise Twitch emotes) with 3rd-party
    // name-matching for text segments that fall between Twitch emote positions.
    function renderMessageWithEmotePositions(message, emoteTag, fallbackEmotes) {
        const positions = parseEmotePositions(emoteTag);
        if (positions.length === 0) return null;

        const fragment = document.createDocumentFragment();
        const chars = [...message]; // spread handles Unicode surrogate pairs correctly
        let cursor = 0;

        function appendTextChunk(text) {
            if (!text) return;
            for (const word of text.split(WHITESPACE_REGEX)) {
                if (!word) continue;
                if (WHITESPACE_ONLY_REGEX.test(word)) {
                    fragment.appendChild(document.createTextNode(word));
                    continue;
                }
                const clean = stripInvisibleChars(word).trim();
                const emoteData = clean && fallbackEmotes ? fallbackEmotes.get(clean) : null;
                if (emoteData) {
                    const img = document.createElement('img');
                    img.src = emoteData.url;
                    img.alt = clean;
                    img.title = `${clean} (${emoteData.provider.toUpperCase()})`;
                    img.className = 'chatlogs-emote';
                    img.style.cssText = `height:${EMOTE_SIZE};width:auto;vertical-align:middle;margin:0 2px`;
                    img.onerror = function() { img.replaceWith(document.createTextNode(clean)); };
                    fragment.appendChild(img);
                } else {
                    const { leading, core, trailing } = splitLinkPunctuation(word);
                    if (leading) fragment.appendChild(document.createTextNode(leading));
                    if (core && isLikelyLink(core)) fragment.appendChild(createLinkNode(core));
                    else if (core) fragment.appendChild(document.createTextNode(core));
                    if (trailing) fragment.appendChild(document.createTextNode(trailing));
                }
            }
        }

        for (const { id, start, end } of positions) {
            if (start < 0 || end >= chars.length) continue;
            if (start > cursor) appendTextChunk(chars.slice(cursor, start).join(''));
            const emoteName = chars.slice(start, end + 1).join('');
            const img = document.createElement('img');
            img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`;
            img.alt = emoteName;
            img.title = emoteName;
            img.className = 'chatlogs-emote';
            img.style.cssText = `height:${EMOTE_SIZE};width:auto;vertical-align:middle;margin:0 2px`;
            img.onerror = function() { this.replaceWith(document.createTextNode(emoteName)); };
            fragment.appendChild(img);
            cursor = end + 1;
        }

        if (cursor < chars.length) appendTextChunk(chars.slice(cursor).join(''));
        return fragment.childNodes.length > 0 ? fragment : null;
    }

    // Strip invisible/zero-width characters from text for emote matching
    function stripInvisibleChars(text) {
        if (!text) return '';
        // Remove zero-width spaces, variation selectors, and other invisible chars
        return text.replace(INVISIBLE_CHARS_REGEX, '');
    }

    function splitLinkPunctuation(text) {
        let leading = '';
        let trailing = '';
        let core = text;

        while (core && LINK_LEADING_PUNCT_REGEX.test(core[0])) {
            leading += core[0];
            core = core.slice(1);
        }

        while (core && LINK_TRAILING_PUNCT_REGEX.test(core[core.length - 1])) {
            trailing = core[core.length - 1] + trailing;
            core = core.slice(0, -1);
        }

        return { leading, core, trailing };
    }

    function isLikelyLink(text) {
        if (!text) return false;
        if (LINK_PROTOCOL_REGEX.test(text) || LINK_WWW_REGEX.test(text)) return true;
        if (text.includes('@')) return false;
        return LINK_DOMAIN_REGEX.test(text);
    }

    function createLinkNode(text) {
        const link = document.createElement('a');
        link.className = 'chatlogs-linkified';
        link.href = LINK_PROTOCOL_REGEX.test(text) ? text : `https://${text}`;
        link.textContent = text;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        return link;
    }

    // Render message text with emotes
    function renderMessageWithEmotes(messageText, emotes) {
        const fragment = document.createDocumentFragment();

        if (!messageText) {
            return fragment;
        }

        // Split by whitespace, keeping the whitespace tokens
        const words = messageText.split(WHITESPACE_REGEX);

        for (const word of words) {
            if (!word) continue;

            // Check if it's whitespace only
            if (WHITESPACE_ONLY_REGEX.test(word)) {
                fragment.appendChild(document.createTextNode(word));
                continue;
            }

            // Strip invisible characters for emote matching only
            const cleanWord = stripInvisibleChars(word).trim();

            // Check if cleaned word is an emote
            const emoteData = cleanWord ? emotes.get(cleanWord) : null;
            if (emoteData) {
                const img = document.createElement('img');
                img.src = emoteData.url;
                img.alt = cleanWord;
                img.title = `${cleanWord} (${emoteData.provider.toUpperCase()})`;
                img.className = 'chatlogs-emote';
                img.style.height = EMOTE_SIZE;
                img.style.width = 'auto';
                img.style.verticalAlign = 'middle';
                img.style.margin = '0 2px';
                img.onerror = function() {
                    img.replaceWith(document.createTextNode(cleanWord));
                };

                fragment.appendChild(img);
            } else {
                const { leading, core, trailing } = splitLinkPunctuation(word);
                if (leading) {
                    fragment.appendChild(document.createTextNode(leading));
                }
                if (core && isLikelyLink(core)) {
                    fragment.appendChild(createLinkNode(core));
                } else if (core) {
                    fragment.appendChild(document.createTextNode(core));
                }
                if (trailing) {
                    fragment.appendChild(document.createTextNode(trailing));
                }
            }
        }

        return fragment;
    }

    // Fetch user info from ivr.fi API (consolidates channel ID and creation date lookups)
    async function fetchUserInfo(username) {
        const lowerUsername = username.toLowerCase();

        // Check cache first
        if (userInfoCache.has(lowerUsername)) {
            const cached = userInfoCache.get(lowerUsername);
            if (cached?.loading) {
                return cached.loading;
            }
            if (cached.expiresAt > Date.now()) {
                return cached;
            }
            userInfoCache.delete(lowerUsername);
        }

        const loading = (async () => {
            try {
                const response = await fetch(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(username)}`);
                if (response.ok) {
                    const data = await response.json();
                    if (data[0]) {
                        const userInfo = {
                            id: data[0].id || null,
                            createdAt: data[0].createdAt ? new Date(data[0].createdAt) : null,
                            expiresAt: Date.now() + CHANNEL_ID_CACHE_TTL_MS
                        };
                        userInfoCache.set(lowerUsername, userInfo);
                        return userInfo;
                    }
                }
            } catch (e) {
                console.error('[Twitch Plus] Failed to fetch user info:', e);
            }

            userInfoCache.delete(lowerUsername);
            return null;
        })();

        userInfoCache.set(lowerUsername, { loading, expiresAt: 0 });
        return loading;
    }

    // Fetch user account creation date (uses consolidated fetchUserInfo)
    async function fetchUserCreatedAt(username) {
        const userInfo = await fetchUserInfo(username);
        return userInfo?.createdAt || null;
    }

    // Format date for display (e.g., "January 7, 2025")
    function formatDateForDisplay(date) {
        if (!date || !(date instanceof Date)) return null;
        const months = ['January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December'];
        return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    }

    function getAccountCreatedLabel(createdDate) {
        return `Account Created ${formatDateForDisplay(createdDate)}`;
    }

    function setAccountCreatedElementState(container, createdDate) {
        const text = container.querySelector('[data-chatlogs-account-created-text]') || container.querySelector('p');
        if (text && createdDate) {
            text.textContent = getAccountCreatedLabel(createdDate);
        }
    }

    const CALENDAR_PATH = 'M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1ZM5 6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H5Zm2 5a1 1 0 0 1 1-1h8a1 1 0 1 1 0 2H8a1 1 0 0 1-1-1Zm1 3a1 1 0 1 0 0 2h5a1 1 0 1 0 0-2H8Z';

    // Copy one of the card's own info rows ("Previously Subbed for 14 Months", "Following since …") and swap in
    // the calendar icon and our text, so the row matches Twitch's current size and spacing exactly. Twitch's
    // generated class names change with its builds, so hard-coded ones go stale (the icon then shows huge).
    function cloneAccountCreatedElement(templateRow, createdDate) {
        const row = templateRow.cloneNode(true);
        const icon = row.querySelector('svg');
        const textElement = [...row.querySelectorAll('*')].reverse().find(element => !element.children.length && element.textContent.trim());
        if (!icon || !textElement) return null;
        for (const element of [row, ...row.querySelectorAll('*')]) {
            for (const name of [...element.getAttributeNames()]) {
                if (name === 'id' || name === 'data-a-target' || name === 'data-test-selector' || name.startsWith('aria-')) element.removeAttribute(name);
            }
        }
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('aria-hidden', 'true');
        icon.replaceChildren();
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', CALENDAR_PATH);
        path.setAttribute('fill', 'currentColor');
        icon.appendChild(path);
        textElement.dataset.chatlogsAccountCreatedText = 'true';
        textElement.textContent = getAccountCreatedLabel(createdDate);
        row.classList.add('enhancer-account-created');
        return row;
    }

    // The marked element may be just the row's text; climb to the smallest ancestor holding exactly one icon,
    // which is the whole row (icon + text) and never the block of several rows.
    function findAccountCreatedTemplate(banner) {
        const item = banner.querySelector('[data-a-target="viewer-card-tier"]') ||
            banner.querySelector('[data-a-target="viewer-card-followed-since"]');
        for (let row = item; row && row !== banner; row = row.parentElement) {
            const icons = row.querySelectorAll('svg').length;
            if (icons === 1) return row;
            if (icons > 1) return null;
        }
        return null;
    }

    // Create account created element matching Twitch's style
    function createAccountCreatedElement(createdDate) {
        const container = document.createElement('div');
        container.className = 'Layout-sc-1xcs6mc-0 fHdBNk enhancer-account-created enhancer-account-created--fallback';

        // Calendar/clock SVG icon
        const svgWrapper = document.createElement('div');
        svgWrapper.className = 'ScSvgWrapper-sc-wkgzod-0 dVDUDh tw-svg';
        svgWrapper.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="${CALENDAR_PATH}"/>
        </svg>`;

        const text = document.createElement('p');
        text.className = 'CoreText-sc-1txzju1-0 cVgnVN InjectLayout-sc-1i43xsx-0 hPZnMK';
        text.dataset.chatlogsAccountCreatedText = 'true';
        text.textContent = getAccountCreatedLabel(createdDate);

        container.appendChild(svgWrapper);
        container.appendChild(text);
        setAccountCreatedElementState(container, createdDate);

        return container;
    }

    function findAccountCreatedInfoContainer(banner) {
        let infoContainer = banner.querySelector('.Layout-sc-1xcs6mc-0.fHdBNk')?.parentElement;
        if (!infoContainer) {
            const infoItem = banner.querySelector('[data-a-target="viewer-card-followed-since"]') ||
                banner.querySelector('[data-a-target="viewer-card-tier"]');
            infoContainer = infoItem ? infoItem.parentElement : null;
        }
        if (!infoContainer) {
            infoContainer = banner.querySelector('.viewer-card-header__display-name') ?? null;
        }
        return infoContainer;
    }

    function upsertAccountCreatedElement(viewerCard, createdDate) {
        let accountCreatedEl = viewerCard.querySelector('.enhancer-account-created');
        if (accountCreatedEl) {
            setAccountCreatedElementState(accountCreatedEl, createdDate);
            return accountCreatedEl;
        }

        if (!createdDate) {
            return null;
        }

        const banner = viewerCard.querySelector('.viewer-card-header__banner');
        if (!banner) {
            return null;
        }

        // Preferred: a copy of Twitch's own info row, placed just before it in the same block.
        const template = findAccountCreatedTemplate(banner);
        const cloned = template?.parentElement && cloneAccountCreatedElement(template, createdDate);
        if (cloned) {
            template.parentElement.insertBefore(cloned, template);
            // Insurance: if the copied icon still comes out larger than an info icon, pin it to Twitch's 2rem.
            const icon = cloned.querySelector('svg');
            if (icon && icon.getBoundingClientRect().width > 24) {
                icon.style.width = '2rem';
                icon.style.height = '2rem';
                icon.style.flex = 'none';
            }
            return cloned;
        }

        const infoContainer = findAccountCreatedInfoContainer(banner);
        if (!infoContainer) {
            return null;
        }

        accountCreatedEl = createAccountCreatedElement(createdDate);
        const firstInfoItem = infoContainer.querySelector('.Layout-sc-1xcs6mc-0.fHdBNk');
        if (firstInfoItem) {
            infoContainer.insertBefore(accountCreatedEl, firstInfoItem);
        } else {
            infoContainer.appendChild(accountCreatedEl);
        }

        return accountCreatedEl;
    }

    function syncAccountCreatedElement(viewerCard) {
        const state = accountCreatedRenderState.get(viewerCard);
        if (!state) return null;
        return upsertAccountCreatedElement(viewerCard, state.createdDate);
    }

    function requestAccountCreatedRender(viewerCard, createdDate) {
        if (!createdDate) {
            return null;
        }

        accountCreatedRenderState.set(viewerCard, { createdDate });

        const rendered = syncAccountCreatedElement(viewerCard);
        if (rendered) {
            return rendered;
        }

        if (!viewerCard.dataset.chatlogsAccountObserver) {
            viewerCard.dataset.chatlogsAccountObserver = 'true';
            const observer = new MutationObserver(() => {
                if (!document.contains(viewerCard)) {
                    observer.disconnect();
                    delete viewerCard.dataset.chatlogsAccountObserver;
                    return;
                }

                if (syncAccountCreatedElement(viewerCard)) {
                    observer.disconnect();
                    delete viewerCard.dataset.chatlogsAccountObserver;
                }
            });
            observer.observe(viewerCard, { childList: true, subtree: true });
            setTimeout(() => {
                observer.disconnect();
                delete viewerCard.dataset.chatlogsAccountObserver;
            }, 3000);
        }

        return null;
    }

    function prepareAccountCreatedForViewerCard(viewerCard) {
        if (viewerCard.dataset.chatlogsAccountPrepared) {
            return;
        }

        viewerCard.dataset.chatlogsAccountPrepared = 'true';

        const username = getUsernameFromCard(viewerCard);
        if (username) {
            fetchUserInfo(username).catch(() => {});
            return;
        }

        const observer = new MutationObserver(() => {
            const nextUsername = getUsernameFromCard(viewerCard);
            if (!nextUsername) return;
            fetchUserInfo(nextUsername).catch(() => {});
            observer.disconnect();
        });

        observer.observe(viewerCard, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 3000);
    }

    // Add account created info to viewer card header
    async function addAccountCreatedToCard(viewerCard, username) {
        const createdDate = await fetchUserCreatedAt(username);
        if (!createdDate) return;
        requestAccountCreatedRender(viewerCard, createdDate);
    }

    // Get current channel name from URL
    function getCurrentChannel() {
        const pathParts = window.location.pathname.split('/').filter(Boolean);
        if (pathParts.length > 0) {
            const specialPaths = ['directory', 'settings', 'subscriptions', 'inventory', 'wallet', 'drops', 'search', 'videos', 'clips', 'schedule', 'about'];
            if (!specialPaths.includes(pathParts[0])) {
                return pathParts[0];
            }
        }
        return null;
    }

    // Get username from viewer card
    function getUsernameFromCard(viewerCard) {
        const usernameLink = viewerCard.querySelector('.viewer-card-header__display-name a');
        if (usernameLink) {
            const href = usernameLink.getAttribute('href');
            if (href) {
                return href.replace(/^\//, '').toLowerCase();
            }
            return usernameLink.textContent.trim().toLowerCase();
        }
        return null;
    }

    // Parse Twitch IRC/TMI line (live WebSocket)
    function parseIRCMessage(ircString) {
        try {
            let tags = {};
            let rest = ircString;

            if (rest.startsWith('@')) {
                const tagEnd = rest.indexOf(' ');
                const tagString = rest.substring(1, tagEnd);
                rest = rest.substring(tagEnd + 1).trim();

                tagString.split(';').forEach((tag) => {
                    const equalsIndex = tag.indexOf('=');
                    if (equalsIndex === -1) {
                        tags[tag] = '';
                        return;
                    }
                    const key = tag.slice(0, equalsIndex);
                    const value = tag.slice(equalsIndex + 1);
                    tags[key] = value;
                });
            }

            if (rest.startsWith(':')) {
                rest = rest.substring(1);
            }

            const sourceEnd = rest.indexOf(' ');
            const source = rest.substring(0, sourceEnd);
            rest = rest.substring(sourceEnd + 1).trim();

            const command = rest.split(' ', 1)[0];

            if (command === 'CLEARCHAT') {
                const targetIdx = rest.indexOf(' :');
                const targetUser = targetIdx !== -1 ? rest.substring(targetIdx + 2).trim() : '';
                if (!targetUser) {
                    return null;
                }

                const durationSeconds = Number.parseInt(tags['ban-duration'] || '', 10);
                const actionText = Number.isFinite(durationSeconds) && durationSeconds > 0
                    ? `was timed out for ${formatDuration(durationSeconds)}.`
                    : 'was banned.';

                return {
                    username: targetUser,
                    message: actionText,
                    timestamp: tags['tmi-sent-ts'] ? new Date(Number.parseInt(tags['tmi-sent-ts'], 10)) : new Date(),
                    color: '#96a3ab',
                    source: MSG_SOURCE_LIVE,
                    eventType: 'moderation'
                };
            }

            // Parse regular chat messages only after moderation events are handled.
            // Skip CLEARMSG, USERNOTICE without message, etc.
            if (command !== 'PRIVMSG') {
                return null;
            }

            const messageStart = rest.indexOf(':');
            let message = messageStart !== -1 ? rest.substring(messageStart + 1) : '';

            // Trim the message and strip any trailing carriage returns or other whitespace
            message = message.trim();

            // Skip empty messages
            if (!message) {
                return null;
            }

            // Detect /me action messages (\x01ACTION ...\x01)
            let isAction = false;
            if (message.startsWith('\x01ACTION ') && message.endsWith('\x01')) {
                message = message.slice(8, -1);
                isAction = true;
            }

            const username = tags['display-name'] || tags['login'] || (source ? source.split('!')[0] : 'Unknown');

            return {
                username: username,
                message: message,
                timestamp: tags['tmi-sent-ts'] ? new Date(Number.parseInt(tags['tmi-sent-ts'], 10)) : new Date(),
                color: tags['color'] || '#bf94ff',
                badges: tags['badges'] || '',
                badgeInfo: tags['badge-info'] || '',
                firstMsg: tags['first-msg'] === '1',
                replyParentUser: decodeIrcTagValue(tags['reply-parent-display-name'] || ''),
                replyParentBody: decodeIrcTagValue(tags['reply-parent-msg-body'] || ''),
                emotePositions: tags['emotes'] || '',
                isAction: isAction,
                source: MSG_SOURCE_LIVE
            };
        } catch (e) {
            return null;
        }
    }

    // Parse a message from the Zonian mirror JSON API (/channel/.../user/...?json)
    function parseLogMessage(msg) {
        if (!msg || !msg.text || !msg.timestamp) return null;
        let messageText = msg.text;
        let isAction = false;
        if (messageText.startsWith('\x01ACTION ') && messageText.endsWith('\x01')) {
            messageText = messageText.slice(8, -1);
            isAction = true;
        }
        return {
            username: msg.displayName || msg.username || 'Unknown',
            message: messageText,
            timestamp: new Date(msg.timestamp),
            color: (msg.tags && msg.tags.color) || '#bf94ff',
            badges: (msg.tags && msg.tags.badges) || '',
            badgeInfo: (msg.tags && msg.tags['badge-info']) || '',
            emotePositions: (msg.tags && msg.tags.emotes) || '',
            isAction: isAction,
            id: msg.id || null,
            source: MSG_SOURCE_LOGS
        };
    }

    // Check which days have historical logs for a user; returns day list or null
    async function fetchLogAvailability(channel, username) {
        const key = `${channel.toLowerCase()}\0${username.toLowerCase()}`;

        const cached = logAvailabilityCache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.daysList;
        }

        if (logAvailabilityInflight.has(key)) {
            return logAvailabilityInflight.get(key);
        }

        const promise = (async () => {
            const url = `${ZONIAN_BASE_URL}/api/${encodeURIComponent(channel)}/${encodeURIComponent(username)}`;
            const data = await withBackoff(async () => {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            });
            let daysList;
            if (!data.available || !data.available.user) {
                daysList = null;
            } else {
                daysList = (data.loggedData && data.loggedData.list) || [];
            }
            logAvailabilityCache.set(key, {
                daysList,
                expiresAt: Date.now() + LOG_AVAILABILITY_TTL_MS
            });
            return daysList;
        })().finally(() => {
            logAvailabilityInflight.delete(key);
        });

        logAvailabilityInflight.set(key, promise);
        return promise;
    }

    // Derive a deduplicated month list (newest first) from the day list returned by /api
    function getMonthList(daysList) {
        const seen = new Set();
        const months = [];
        for (const d of daysList) {
            const key = `${d.year}-${d.month}`;
            if (!seen.has(key)) {
                seen.add(key);
                months.push({ year: d.year, month: d.month });
            }
        }
        return months; // already newest-first because daysList is newest-first
    }

    // Fetch the most recent LOGS_FETCH_LIMIT messages for a month from the mirror API.
    // reverse=true makes the API return newest-first so limit selects the right end;
    // we then reverse the array back to ascending order for display.
    async function fetchLogMonth(channel, username, year, month) {
        const url = `${ZONIAN_BASE_URL}/channel/${encodeURIComponent(channel)}/user/${encodeURIComponent(username)}/${year}/${month}?json&reverse=true&limit=${LOGS_FETCH_LIMIT}`;
        const data = await withBackoff(async () => {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        });
        if (!data.messages || !Array.isArray(data.messages)) return [];
        // API returns newest-first; reverse to oldest-first for internal sort order
        const msgs = data.messages
            .reverse()
            .map(parseLogMessage)
            .filter(m => m !== null);
        return msgs;
    }

    // Format timestamp for display (time only, like Twitch's VCML: "17:36")
    function formatTimestamp(timestamp) {
        if (timestamp instanceof Date) {
            const hours = String(timestamp.getHours()).padStart(2, '0');
            const minutes = String(timestamp.getMinutes()).padStart(2, '0');
            return `${hours}:${minutes}`;
        }
        return '?';
    }

    // Get date string for date separator (M/D/YYYY format like Twitch)
    function getDateString(timestamp) {
        if (timestamp instanceof Date) {
            const month = timestamp.getMonth() + 1;
            const day = timestamp.getDate();
            const year = timestamp.getFullYear();
            return `${month}/${day}/${year}`;
        }
        return null;
    }

    // Create date separator element
    function createDateSeparator(dateString) {
        const separator = document.createElement('div');
        separator.className = 'chatlogs-date-separator';
        separator.textContent = dateString;
        return separator;
    }

    // Same layout as date separators; marks the boundary before live (IRC) lines
    function createLiveSeparator() {
        const separator = document.createElement('div');
        separator.className = 'chatlogs-date-separator chatlogs-live-separator';
        separator.textContent = 'Live';
        return separator;
    }

    // Create a message element (matches Twitch's VCML structure)
    function createMessageElement(msg, emotes, userColor, badges) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'Layout-sc-1xcs6mc-0 eRdVkj vcml-message chatlogs-message';
        msgDiv.dataset.timestampMs = String(getTimestampMs(msg));

        const innerDiv = document.createElement('div');
        innerDiv.id = crypto.randomUUID();

        const timestampWrapper = document.createElement('div');
        timestampWrapper.className = 'Layout-sc-1xcs6mc-0 nnbce';
        timestampWrapper.style.display = 'inline';
        const timestamp = document.createElement('span');
        timestamp.className = 'vcml-message__timestamp';
        timestamp.textContent = formatTimestamp(msg.timestamp);
        timestamp.style.opacity = '0.75';
        timestamp.style.marginRight = '6px';
        timestampWrapper.appendChild(timestamp);

        // System/moderation events
        if (msg.eventType === 'moderation') {
            const systemText = document.createElement('span');
            systemText.className = 'text-fragment';
            systemText.style.fontStyle = 'italic';
            systemText.style.opacity = '0.85';
            systemText.textContent = `${msg.username} ${msg.message}`;
            innerDiv.appendChild(timestampWrapper);
            innerDiv.appendChild(systemText);
            msgDiv.appendChild(innerDiv);
            msgDiv.dataset.messageText = msg.message || '';
            return msgDiv;
        }

        const displayColor = userColor || msg.color || '#bf94ff';

        // Reply context — shown as a quoted block above the message row
        if (msg.replyParentUser && msg.replyParentBody) {
            const replyCtx = document.createElement('div');
            replyCtx.className = 'chatlogs-reply-context';
            replyCtx.textContent = `↩ ${msg.replyParentUser}: ${msg.replyParentBody}`;
            innerDiv.appendChild(replyCtx);
        }

        innerDiv.appendChild(timestampWrapper);

        // Badges container (filled immediately if badge data is ready, or filled later by rerenderBadges)
        const badgesContainer = document.createElement('span');
        badgesContainer.className = 'chatlogs-badges-container';
        if (msg.badges) {
            msgDiv.dataset.badges = msg.badges;
            msgDiv.dataset.badgeInfo = msg.badgeInfo || '';
            if (badges && badges.size > 0) {
                fillBadges(badgesContainer, msg.badges, msg.badgeInfo || '', badges);
            }
        }
        innerDiv.appendChild(badgesContainer);

        const usernameWrapper = document.createElement('span');
        usernameWrapper.className = 'message-author__username';
        const usernameSpan = document.createElement('span');
        usernameSpan.className = 'message-author__display-name';
        usernameSpan.setAttribute('data-test-selector', 'message-username');
        usernameSpan.textContent = msg.username;
        usernameSpan.style.color = displayColor;
        usernameWrapper.appendChild(usernameSpan);

        // First-message indicator pill
        if (msg.firstMsg) {
            const pill = document.createElement('span');
            pill.className = 'chatlogs-first-msg';
            pill.title = 'First message in this channel';
            pill.textContent = 'First';
            usernameWrapper.appendChild(pill);
        }

        innerDiv.appendChild(usernameWrapper);

        // Separator — colon for normal messages, space for /me actions
        if (msg.isAction) {
            innerDiv.appendChild(document.createTextNode(' '));
        } else {
            const separator = document.createElement('span');
            separator.textContent = ': ';
            innerDiv.appendChild(separator);
        }

        const messageText = msg.message || '';
        const messageWrapper = document.createElement('span');

        const messageSpan = document.createElement('span');
        messageSpan.className = 'text-fragment';
        messageSpan.setAttribute('data-a-target', 'chat-message-text');
        if (msg.isAction) {
            messageSpan.style.color = displayColor;
            messageSpan.style.fontStyle = 'italic';
        }

        // Render order: position-based Twitch emotes (precise) → name-based fallback → plain text
        let rendered = null;
        if (msg.emotePositions && messageText) {
            rendered = renderMessageWithEmotePositions(messageText, msg.emotePositions, emotes);
        }
        if (!rendered && emotes && emotes.size > 0 && messageText) {
            rendered = renderMessageWithEmotes(messageText, emotes);
        }
        if (rendered && rendered.childNodes.length > 0) {
            messageSpan.appendChild(rendered);
        } else {
            messageSpan.textContent = messageText;
        }

        messageWrapper.appendChild(messageSpan);
        innerDiv.appendChild(messageWrapper);
        msgDiv.appendChild(innerDiv);

        // Data attributes for later re-renders (emotes, badges)
        msgDiv.dataset.messageText = messageText;
        if (msg.emotePositions) msgDiv.dataset.emotePositions = msg.emotePositions;

        return msgDiv;
    }

    // Re-render messages with emotes after emotes are loaded
    function rerenderMessagesWithEmotes(container, state) {
        const { emotes } = state;
        if (!emotes || emotes.size === 0) return;

        // Use requestAnimationFrame to avoid blocking UI
        requestAnimationFrame(() => {
            for (const msgEl of container.querySelectorAll('.chatlogs-message')) {
                const messageText = msgEl.dataset.messageText;
                if (!messageText) continue;

                const textFragment = msgEl.querySelector('.text-fragment');
                if (!textFragment) continue;

                const emotePositions = msgEl.dataset.emotePositions || '';
                const alreadyHasEmotes = !!textFragment.querySelector('.chatlogs-emote');

                let rendered = null;
                if (emotePositions) {
                    // Re-render with position-based Twitch emotes + 3rd-party in gaps
                    rendered = renderMessageWithEmotePositions(messageText, emotePositions, emotes);
                } else if (!alreadyHasEmotes) {
                    rendered = renderMessageWithEmotes(messageText, emotes);
                }

                if (rendered && rendered.childNodes.length > 0) {
                    textFragment.innerHTML = '';
                    textFragment.appendChild(rendered);
                }
            }
        });
    }

    function renderLoadingSkeleton(container, labelText = 'Loading chat logs...') {
        container.innerHTML = '';
        const loadingDiv = document.createElement('p');
        loadingDiv.className = 'CoreText-sc-1txzju1-0 cVgnVN chatlogs-loading';
        loadingDiv.textContent = labelText;
        container.appendChild(loadingDiv);
    }

    function updateHeaderMeta(rootContainer, state) {
        const statusEl = rootContainer.querySelector('[data-chatlogs-meta="status"]');
        const countEl = rootContainer.querySelector('[data-chatlogs-meta="count"]');
        if (!statusEl || !countEl) return;

        const totalMessages = state.allMessages.length;
        const displayedCount = Math.min(state.displayedCount, totalMessages);
        countEl.textContent = `${displayedCount} of ${totalMessages} messages`;

        // Rebuild status element with a colored dot indicator
        statusEl.innerHTML = '';
        const dot = document.createElement('span');
        dot.className = 'chatlogs-status-dot';
        let statusText;

        if (!state.isLive) {
            dot.classList.add('chatlogs-status-dot--stopped');
            statusText = 'Stopped';
        } else if (state.liveMode === 'ws') {
            dot.classList.add('chatlogs-status-dot--live');
            statusText = 'Live';
        } else if (state.liveMode === 'disconnected') {
            dot.classList.add('chatlogs-status-dot--stopped');
            statusText = 'Live disconnected';
        } else {
            dot.classList.add('chatlogs-status-dot--connecting');
            statusText = 'Connecting';
        }

        statusEl.appendChild(dot);
        statusEl.appendChild(document.createTextNode(statusText));
    }

    // Copy the slot around one of Twitch's own text buttons (Whisper, Follow, or on your own card Edit Profile)
    // and give it our label. Twitch's style classes are generated and change with every Twitch build, so
    // hard-coded ones go stale; a copy always matches the current look. Copies carry no React handlers,
    // so the copied button does nothing until we add ours.
    function cloneNativeTextButton(templateButton, label) {
        const templateSlot = templateButton.closest('.viewer-card-drag-cancel')?.parentElement;
        if (!templateSlot) return null;
        const slot = templateSlot.cloneNode(true);
        const button = slot.querySelector('button');
        if (!button) return null;
        for (const element of [slot, ...slot.querySelectorAll('*')]) {
            for (const name of [...element.getAttributeNames()]) {
                // Drop Twitch's identifiers so nothing mistakes the copy for the real Whisper/Follow button;
                // keep only the label marker Twitch's own CSS styles.
                if (name === 'id' || name === 'disabled' || name.startsWith('aria-') || name === 'data-test-selector' ||
                    (name === 'data-a-target' && element.getAttribute(name) !== 'tw-core-button-label-text')) {
                    element.removeAttribute(name);
                }
            }
        }
        // Text only: drop icons such as Follow's heart.
        button.querySelectorAll('svg, [data-a-selector="tw-core-button-icon"], [class*="ButtonIconFigure"]').forEach(icon => {
            (icon.closest('[data-a-selector="tw-core-button-icon"]') || icon).remove();
        });
        let text = button.querySelector('[data-a-target="tw-core-button-label-text"]');
        if (!text) {
            text = [...button.querySelectorAll('*')].reverse().find(element => element.textContent.trim()) || button;
        }
        text.textContent = label;
        text.dataset.chatlogsButtonLabel = 'true';
        button.type = 'button';
        return { slot, button };
    }

    function findNativeTextButton(viewerCard) {
        return viewerCard.querySelector('[data-test-selector="whisper-button"]') ||
            viewerCard.querySelector('[data-a-target="follow-button"]') ||
            [...viewerCard.querySelectorAll('button')].find(button =>
                !button.closest('.enhancer-chatlogs-toggle-wrap, .enhancer-chatlogs') &&
                button.querySelector('[data-a-target="tw-core-button-label-text"]'));
    }

    function createNativeTextButton(label) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ScCoreButton-sc-ocjdkq-0 cikFpu';

        const labelWrapper = document.createElement('div');
        labelWrapper.className = 'ScCoreButtonLabel-sc-s7h2b7-0 OyGFd';

        const text = document.createElement('div');
        text.className = 'Layout-sc-1xcs6mc-0 iBachR';
        text.setAttribute('data-a-target', 'tw-core-button-label-text');
        text.dataset.chatlogsButtonLabel = 'true';
        text.textContent = label;

        labelWrapper.appendChild(text);
        button.appendChild(labelWrapper);
        return button;
    }

    function setNativeButtonLabel(button, label) {
        const text = button.querySelector('[data-chatlogs-button-label="true"]');
        if (text) {
            text.textContent = label;
        } else {
            button.textContent = label;
        }
    }

    function setupToolbarInteractions(rootContainer, messagesContainer) {
        rootContainer.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-chatlogs-action]');
            if (!button) return;
            const stateId = rootContainer.dataset.chatlogsStateId;
            if (!stateId) return;
            const state = activeStates.get(Number(stateId));
            if (!state) return;

            const action = button.dataset.chatlogsAction;
            if (action === 'newest') {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            } else if (action === 'oldest') {
                messagesContainer.scrollTop = 0;
            } else if (action === 'refresh') {
                refreshLogs(messagesContainer, state, button, rootContainer);
            }
        });
    }

    // Create the logs section container
    function createLogsSection(channel, username) {
        const container = document.createElement('div');
        container.className = 'Layout-sc-1xcs6mc-0 kvjacc enhancer-chatlogs';
        container.style.marginTop = '8px';

        // Header - compact meta row + link (no redundant title; it lives in the toggle section header)
        const header = document.createElement('div');
        header.className = 'Layout-sc-1xcs6mc-0 kvrzxX chatlogs-header';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.gap = '8px';

        const metaRow = document.createElement('div');
        metaRow.className = 'Layout-sc-1xcs6mc-0 kvrzxX chatlogs-meta';
        metaRow.style.gap = '4px';
        metaRow.style.flexWrap = 'wrap';
        metaRow.style.alignItems = 'center';

        const statusBadge = document.createElement('span');
        statusBadge.className = 'CoreText-sc-1txzju1-0 cVgnVN chatlogs-status';
        statusBadge.dataset.chatlogsMeta = 'status';

        const metaSep = document.createElement('span');
        metaSep.className = 'CoreText-sc-1txzju1-0 cVgnVN chatlogs-meta-sep';
        metaSep.textContent = '·';

        const countBadge = document.createElement('span');
        countBadge.className = 'CoreText-sc-1txzju1-0 cVgnVN';
        countBadge.dataset.chatlogsMeta = 'count';
        countBadge.textContent = '0 messages';

        metaRow.appendChild(statusBadge);
        metaRow.appendChild(metaSep);
        metaRow.appendChild(countBadge);

        const openLink = document.createElement('a');
        openLink.href = `https://tv.supa.sh/logs?c=${encodeURIComponent(channel)}&u=${encodeURIComponent(username)}`;
        openLink.target = '_blank';
        openLink.rel = 'noopener noreferrer';
        openLink.className = 'ScCoreLink-sc-16kq0mq-0 dEeZDR tw-link chatlogs-link';
        openLink.innerHTML = `Open Full History <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:middle;opacity:0.7;margin-left:2px"><path fill="currentColor" d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>`;

        header.appendChild(metaRow);
        header.appendChild(openLink);
        container.appendChild(header);

        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'Layout-sc-1xcs6mc-0 kvrzxX chatlogs-toolbar';
        toolbar.style.gap = '6px';
        toolbar.style.margin = '6px 0 2px';

        const actionsGroup = document.createElement('div');
        actionsGroup.className = 'Layout-sc-1xcs6mc-0 kvrzxX chatlogs-actions';
        actionsGroup.style.gap = '4px';

        const refreshButton = createNativeTextButton('Refresh');
        refreshButton.classList.add('chatlogs-action-button');
        refreshButton.dataset.chatlogsAction = 'refresh';

        const newestButton = createNativeTextButton('Newest');
        newestButton.classList.add('chatlogs-action-button');
        newestButton.dataset.chatlogsAction = 'newest';

        const oldestButton = createNativeTextButton('Oldest');
        oldestButton.classList.add('chatlogs-action-button');
        oldestButton.dataset.chatlogsAction = 'oldest';

        actionsGroup.appendChild(refreshButton);
        actionsGroup.appendChild(newestButton);
        actionsGroup.appendChild(oldestButton);

        toolbar.appendChild(actionsGroup);
        container.appendChild(toolbar);

        // Messages container
        const messagesContainer = document.createElement('div');
        messagesContainer.className = 'chatlogs-messages';
        messagesContainer.style.maxHeight = MAX_LOGS_HEIGHT;
        messagesContainer.style.overflowY = 'auto';
        messagesContainer.style.overflowX = 'hidden';
        messagesContainer.style.marginTop = '4px';

        // Stop drag events from propagating to parent (viewer card drag behavior)
        // This allows text selection and scrolling to work properly
        messagesContainer.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        }, true);
        messagesContainer.addEventListener('touchstart', (e) => {
            e.stopPropagation();
        }, { passive: true, capture: true });
        messagesContainer.addEventListener('dragstart', (e) => {
            e.stopPropagation();
        }, true);

        renderLoadingSkeleton(messagesContainer);
        container.appendChild(messagesContainer);

        setupToolbarInteractions(container, messagesContainer);

        // Load the logs
        initializeLogs(channel, username, messagesContainer, container);

        return container;
    }

    // Initialize logs from Zonian mirror API; new lines arrive via IRC only
    async function initializeLogs(channel, username, container, rootContainer) {
        // Start network work immediately so it overlaps the next frame and each other
        const availabilityPromise = fetchLogAvailability(channel, username).catch(e => {
            console.warn('[Twitch Plus] fetchLogAvailability threw:', e.message);
            return null;
        });
        const emotePromise = loadEmotesForChannel(channel).catch(e => {
            console.error('[Twitch Plus] Emote loading failed:', e);
            return new Map();
        });
        const badgePromise = loadBadgesForChannel(channel).catch(e => {
            console.error('[Twitch Plus] Badge loading failed:', e);
            return new Map();
        });

        await new Promise(requestAnimationFrame);
        if (!document.contains(container)) return;
        try {
            const daysList = await availabilityPromise;

            if (!document.contains(container)) return;

            const seenIds = new Set();
            const userColor = getUserColor(username);
            const stateId = nextStateId++;
            const hasHistory = !!(daysList && daysList.length > 0);

            const state = {
                _stateId: stateId,
                allMessages: [],
                displayedCount: 0,
                emotes: new Map(),
                badges: getFallbackBadgeMap(),
                channel: channel,
                username: username,
                userColor: userColor,
                seenMessageIds: seenIds,
                isLive: true,
                lastDisplayedDate: null,
                isRefreshing: false,
                liveMode: null,
                container: container,
                unsubscribeIrc: null,
                containerObserver: null,
                // Historical pagination: month-level (day endpoint returns 400)
                daysList: getMonthList(daysList || []),
                nextDayIndex: 0,
                isLoadingMore: false,
                hasMoreHistory: hasHistory,
                liveSectionStarted: false
            };

            activeStates.set(stateId, state);
            if (rootContainer) {
                rootContainer.dataset.chatlogsStateId = String(stateId);
            }

            container.innerHTML = '';

            if (hasHistory) {
                // Historical path: fetch the most recent month, show 10, lazy-load older on scroll
                await loadMoreHistory(container, state);
            } else {
                showMoreMessages(container, state);
            }

            if (!document.contains(container)) return;

            // Set up scroll-to-top listener for loading older messages
            setupScrollLoadMore(container, state);
            if (hasHistory) {
                await ensureScrollableOrLoadMore(container, state);
            }

            if (rootContainer) {
                updateHeaderMeta(rootContainer, state);
            }

            // Load emotes in background and re-render when ready
            emotePromise.then(emotes => {
                if (emotes && emotes.size > 0 && document.contains(container) && state.emotes) {
                    state.emotes = emotes;
                    rerenderMessagesWithEmotes(container, state);
                }
            });

            badgePromise.then(badges => {
                if (badges && badges.size > 0 && document.contains(container)) {
                    state.badges = badges;
                    rerenderBadges(container, state);
                }
            });

            // Start live updates (IRC WebSocket)
            startLiveUpdates(container, state);

        } catch (error) {
            container.innerHTML = '';
            const errorDiv = document.createElement('p');
            errorDiv.className = 'CoreText-sc-1txzju1-0 cVgnVN chatlogs-error';
            errorDiv.textContent = `Failed to load logs: ${error.message}`;
            container.appendChild(errorDiv);
            console.error('[Twitch Plus] Error:', error);
        }
    }

    // Additional check for message duplicates in live IRC streams
    function isLikelyDuplicate(newMsg, existingMessages) {
        const newTime = getTimestampMs(newMsg);
        const newContent = newMsg.message.toLowerCase().trim();
        const newUsername = newMsg.username.toLowerCase();
        const startIndex = Math.max(0, existingMessages.length - 20);

        for (let i = existingMessages.length - 1; i >= startIndex; i--) {
            const existing = existingMessages[i];

            if (existing.username.toLowerCase() !== newUsername) continue;
            if (existing.message.toLowerCase().trim() !== newContent) continue;

            // Same content from same user within window = likely duplicate
            const existingTime = getTimestampMs(existing);
            if (existingTime === 0) continue;

            if (Math.abs(newTime - existingTime) < DUPLICATE_CHECK_WINDOW_MS) {
                return true;
            }
        }
        return false;
    }

    // Unified cleanup function for state resources
    function cleanupState(state) {
        state.isLive = false;

        if (state.unsubscribeIrc) {
            state.unsubscribeIrc();
            state.unsubscribeIrc = null;
        }

        if (state.containerObserver) {
            state.containerObserver.disconnect();
            state.containerObserver = null;
        }

        // Release large data structures for garbage collection
        state.allMessages = [];
        if (state.seenMessageIds) {
            state.seenMessageIds.clear();
        }
        state.emotes = null;
        state.badges = null;
        state.container = null;

        // Remove from active states tracking (allows full GC of state object)
        if (state._stateId !== undefined) {
            activeStates.delete(state._stateId);
        }
    }

    // Set up a watcher for container removal (only once per state)
    // Uses stateId instead of direct state reference to avoid closure memory retention
    function setupContainerWatcher(container, state) {
        // Avoid duplicate observers
        if (state.containerObserver) return;

        const stateId = state._stateId;
        if (!document.contains(container)) {
            const currentState = activeStates.get(stateId);
            if (currentState) {
                cleanupState(currentState);
            }
            return;
        }
        const observer = new MutationObserver(() => {
            if (!document.contains(container)) {
                // Look up state by ID instead of holding direct reference
                const currentState = activeStates.get(stateId);
                if (currentState) {
                    cleanupState(currentState);
                }
                observer.disconnect();
            }
        });

        // Store reference for cleanup
        state.containerObserver = observer;
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function startLiveUpdates(container, state) {
        state.container = container;
        try {
            state.liveMode = 'ws';
            state.unsubscribeIrc = subscribeIrc(state.channel, state);
            const rootContainer = container.closest('.enhancer-chatlogs');
            if (rootContainer) {
                updateHeaderMeta(rootContainer, state);
            }
        } catch {
            state.liveMode = 'disconnected';
            const rootContainer = container.closest('.enhancer-chatlogs');
            if (rootContainer) {
                updateHeaderMeta(rootContainer, state);
            }
        }

        // Set up container removal watcher if not already set
        setupContainerWatcher(container, state);
    }

    async function refreshLogs(container, state, triggerButton, rootContainer) {
        if (state.isRefreshing) return;
        state.isRefreshing = true;

        const { channel, username } = state;

        if (triggerButton) {
            triggerButton.disabled = true;
            setNativeButtonLabel(triggerButton, 'Refreshing...');
        }

        try {
            cleanupState(state);
            renderLoadingSkeleton(container);
            await initializeLogs(channel, username, container, rootContainer);
        } finally {
            if (triggerButton && document.contains(triggerButton)) {
                triggerButton.disabled = false;
                setNativeButtonLabel(triggerButton, 'Refresh');
            }
        }
    }

    function pruneLiveMessages(container, maxMessages) {
        const messages = container.querySelectorAll('.chatlogs-message');
        const excess = messages.length - maxMessages;
        if (excess <= 0) return messages.length;
        for (let i = 0; i < excess; i++) {
            messages[i].remove();
        }
        return maxMessages;
    }

    // Append new live messages to the container
    function appendLiveMessages(container, messages, state) {
        const { emotes, userColor, badges } = state;

        // Remove "no messages" placeholder if present
        const emptyDiv = container.querySelector('.chatlogs-empty');
        if (emptyDiv) {
            emptyDiv.remove();
        }

        const loadingDiv = container.querySelector('.chatlogs-loading');
        if (loadingDiv) {
            loadingDiv.remove();
        }

        // Find the count info element (sticky at bottom)
        const countInfo = container.querySelector('.chatlogs-count');

        // Check if user is scrolled to bottom (with small threshold)
        const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 30;

        // Get the date of the last displayed message to check if we need a date separator
        let lastDisplayedDate = state.lastDisplayedDate || null;

        if (!state.liveSectionStarted && messages.length > 0) {
            state.liveSectionStarted = true;
            const liveSep = createLiveSeparator();
            if (countInfo) {
                container.insertBefore(liveSep, countInfo);
            } else {
                container.appendChild(liveSep);
            }
        }

        for (const msg of messages) {
            const msgDate = getDateString(msg.timestamp);

            // Add date separator if date changed
            if (msgDate && msgDate !== lastDisplayedDate) {
                const separator = createDateSeparator(msgDate);
                if (countInfo) {
                    container.insertBefore(separator, countInfo);
                } else {
                    container.appendChild(separator);
                }
                lastDisplayedDate = msgDate;
            }

            const msgElement = createMessageElement(msg, emotes, userColor, badges);

            // Insert before count info if it exists, otherwise append
            if (countInfo) {
                container.insertBefore(msgElement, countInfo);
            } else {
                container.appendChild(msgElement);
            }

            state.displayedCount++;
        }

        const visibleCount = pruneLiveMessages(container, MAX_RENDERED_MESSAGES);

        // Update last displayed date in state
        state.lastDisplayedDate = lastDisplayedDate;

        // Update count info
        if (countInfo) {
            const totalMessages = state.allMessages.length;
            const safeDisplayedCount = Math.min(state.displayedCount, totalMessages);
            const safeVisibleCount = Math.min(visibleCount, totalMessages);
            const infoText = state.displayedCount > visibleCount
                ? `Showing last ${safeVisibleCount} of ${totalMessages}`
                : `Showing ${safeDisplayedCount} of ${totalMessages}`;
            countInfo.textContent = infoText;
        }

        // Auto-scroll to bottom if user was already at bottom
        if (isAtBottom) {
            container.scrollTop = container.scrollHeight;
        }

        const rootContainer = container.closest('.enhancer-chatlogs');
        if (!countInfo) {
            refreshControls(container, state);
        }
        if (rootContainer) {
            updateHeaderMeta(rootContainer, state);
        }
    }

    // Show more messages (pagination)
    function showMoreMessages(container, state) {
        const { displayedCount, emotes, userColor, badges } = state;
        const totalMessages = state.allMessages.length;

        const loadingDiv = container.querySelector('.chatlogs-loading');
        if (loadingDiv) {
            loadingDiv.remove();
        }

        if (totalMessages === 0) {
            container.innerHTML = '';
            const emptyDiv = document.createElement('p');
            emptyDiv.className = 'CoreText-sc-1txzju1-0 cVgnVN chatlogs-empty';
            emptyDiv.textContent = 'No chat messages found for this user.';
            container.appendChild(emptyDiv);
            const rootContainer = container.closest('.enhancer-chatlogs');
            if (rootContainer) {
                updateHeaderMeta(rootContainer, state);
            }
            return;
        }

        // Calculate which messages to show (from the end, going backwards)
        const startIndex = Math.max(0, totalMessages - displayedCount - MESSAGES_PER_PAGE);
        const endIndex = totalMessages - displayedCount;
        const newMessages = state.allMessages.slice(startIndex, endIndex);

        // Remove existing count info if present
        const existingCount = container.querySelector('.chatlogs-count');
        if (existingCount) {
            existingCount.remove();
        }

        // Create message elements with date separators (prepend to show older messages at top)
        const fragment = document.createDocumentFragment();
        let lastDateInBatch = null;

        for (let i = 0; i < newMessages.length; i++) {
            const msg = newMessages[i];
            const msgDate = getDateString(msg.timestamp);

            // Add date separator if date changed from previous message in this batch
            if (msgDate && msgDate !== lastDateInBatch) {
                fragment.appendChild(createDateSeparator(msgDate));
                lastDateInBatch = msgDate;
            }

            fragment.appendChild(createMessageElement(msg, emotes, userColor, badges));
        }

        // Save scroll position before inserting (to maintain user's view)
        const scrollHeightBefore = container.scrollHeight;
        const scrollTopBefore = container.scrollTop;

        // Insert at the beginning
        if (container.firstChild) {
            container.insertBefore(fragment, container.firstChild);
        } else {
            container.appendChild(fragment);
        }

        // Restore scroll position - keep user at same visual position
        // (new content was added above, so we need to offset by the height difference)
        if (displayedCount > 0) {
            const scrollHeightAfter = container.scrollHeight;
            const heightAdded = scrollHeightAfter - scrollHeightBefore;
            container.scrollTop = scrollTopBefore + heightAdded;
        }

        // Update displayed count
        state.displayedCount += newMessages.length;

        // Update lastDisplayedDate to the date of the last message in the filtered list
        // (used by appendLiveMessages to know when to add date separators)
        if (state.allMessages.length > 0) {
            const lastMsg = state.allMessages[state.allMessages.length - 1];
            state.lastDisplayedDate = getDateString(lastMsg.timestamp);
        }

        refreshControls(container, state);

        // Scroll to bottom on initial load only
        if (displayedCount === 0) {
            container.scrollTop = container.scrollHeight;
        }
    }

    // Fetch the next oldest month from the historical API, prepend messages, render more
    async function loadMoreHistory(container, state) {
        if (state.isLoadingMore) return;

        // Serve from local cache first if there are unshown messages
        if (state.displayedCount < state.allMessages.length) {
            showMoreMessages(container, state);
            return;
        }

        // Nothing more to fetch
        if (!state.hasMoreHistory || state.nextDayIndex >= state.daysList.length) {
            state.hasMoreHistory = false;
            refreshControls(container, state);
            return;
        }

        state.isLoadingMore = true;

        const loadingEl = document.createElement('div');
        loadingEl.className = 'chatlogs-loading chatlogs-loading-spinner';
        const spinner = document.createElement('span');
        spinner.className = 'chatlogs-spinner';
        const spinnerLabel = document.createElement('span');
        spinnerLabel.className = 'chatlogs-spinner-label';
        spinnerLabel.textContent = 'Loading older messages…';
        loadingEl.appendChild(spinner);
        loadingEl.appendChild(spinnerLabel);
        if (container.firstChild) {
            container.insertBefore(loadingEl, container.firstChild);
        } else {
            container.appendChild(loadingEl);
        }

        try {
            // Keep trying months until we collect at least one new message or run out.
            // This prevents empty entries (e.g. a month with no activity yet) from
            // causing a false "No messages found" on the very first load.
            // A per-month fetch error (404 etc.) is treated as an empty month, not a fatal abort.
            const MAX_EMPTY_DAYS = 10;
            let emptyDayStreak = 0;
            let newMsgs = [];

            while (
                newMsgs.length === 0 &&
                emptyDayStreak < MAX_EMPTY_DAYS &&
                state.nextDayIndex < state.daysList.length
            ) {
                const month = state.daysList[state.nextDayIndex++];
                let messages = [];
                try {
                    messages = await fetchLogMonth(state.channel, state.username, month.year, month.month);
                } catch (dayErr) {
                    console.warn('[Twitch Plus] fetchLogMonth failed for', month, '—', dayErr.message, '(skipping)');
                }

                const deduped = messages.filter(msg => {
                    const id = getMessageId(msg);
                    if (state.seenMessageIds.has(id)) return false;
                    if (isLikelyDuplicate(msg, state.allMessages)) return false;
                    state.seenMessageIds.add(id);
                    pruneSeenMessageIds(state.seenMessageIds);
                    return true;
                });

                if (deduped.length > 0) {
                    newMsgs = newMsgs.concat(deduped);
                } else {
                    emptyDayStreak++;
                }
            }

            if (newMsgs.length > 0) {
                newMsgs.sort(compareMessages);
                // Prepend older messages; displayedCount stays the same so the
                // same "last N" messages remain visible — showMoreMessages picks
                // up the new ones from the front on the next render pass.
                state.allMessages = [...newMsgs, ...state.allMessages];
            }

            if (state.nextDayIndex >= state.daysList.length) {
                state.hasMoreHistory = false;
            }
        } catch (e) {
            console.error('[Twitch Plus] loadMoreHistory fatal error:', e);
            state.hasMoreHistory = false;
        } finally {
            loadingEl.remove();
            state.isLoadingMore = false;
            showMoreMessages(container, state);
        }
    }

    // When content does not overflow the messages box, scrollTop stays at 0 and no scroll
    // events fire — so "scroll to top to load older" never runs. Keep fetching until the
    // list becomes scrollable or there is nothing left to load.
    async function ensureScrollableOrLoadMore(container, state) {
        if (!activeStates.has(state._stateId)) return;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const maxIterations = 30;
        const slack = 8;
        for (let i = 0; i < maxIterations; i++) {
            if (!activeStates.has(state._stateId)) return;
            const canLoadMore =
                state.hasMoreHistory || state.displayedCount < state.allMessages.length;
            if (!canLoadMore) break;
            if (container.scrollHeight > container.clientHeight + slack) break;

            const prevScrollH = container.scrollHeight;
            const prevMsgLen = state.allMessages.length;
            const prevDisplayed = state.displayedCount;

            await loadMoreHistory(container, state);
            if (!activeStates.has(state._stateId)) return;

            const noProgress =
                container.scrollHeight === prevScrollH &&
                state.allMessages.length === prevMsgLen &&
                state.displayedCount === prevDisplayed;
            if (noProgress) break;
        }
    }

    // Trigger loadMoreHistory when the user scrolls to the top of the messages box
    function setupScrollLoadMore(container, state) {
        container.addEventListener('scroll', () => {
            // Bail if this state was replaced by a refresh
            if (!activeStates.has(state._stateId)) return;
            if (
                container.scrollTop < 50 &&
                !state.isLoadingMore &&
                (state.hasMoreHistory || state.displayedCount < state.allMessages.length)
            ) {
                loadMoreHistory(container, state);
            }
        }, { passive: true });
    }

    function refreshControls(container, state) {
        const totalMessages = state.allMessages.length;

        const existingCount = container.querySelector('.chatlogs-count');
        if (existingCount) {
            existingCount.remove();
        }

        if (totalMessages === 0) {
            const rootContainer = container.closest('.enhancer-chatlogs');
            if (rootContainer) {
                updateHeaderMeta(rootContainer, state);
            }
            return;
        }

        const countInfo = document.createElement('p');
        countInfo.className = 'CoreText-sc-1txzju1-0 cVgnVN chatlogs-count';
        countInfo.style.margin = '8px 0 0';

        const safeDisplayedCount = Math.min(state.displayedCount, totalMessages);
        const hasMore = state.displayedCount < totalMessages || state.hasMoreHistory;
        let infoText = `Showing ${safeDisplayedCount}`;
        infoText += hasMore ? ' · more available' : ' · all loaded';

        countInfo.textContent = infoText;
        container.appendChild(countInfo);

        const rootContainer = container.closest('.enhancer-chatlogs');
        if (rootContainer) {
            updateHeaderMeta(rootContainer, state);
        }
    }

    function createLogsToggleSection(channel, username) {
        const wrapper = document.createElement('div');
        wrapper.className = 'InjectLayout-sc-1i43xsx-0 iDMNUO viewer-card-drag-cancel enhancer-chatlogs-toggle-wrap';

        const host = document.createElement('div');
        host.className = 'Layout-sc-1xcs6mc-0 enhancer-chatlogs-host';
        host.hidden = true;
        wrapper.appendChild(host);

        let logsSection = null;

        function toggle(button) {
            if (!logsSection) {
                logsSection = createLogsSection(channel, username);
                host.appendChild(logsSection);
            }
            const willShow = host.hidden;
            host.hidden = !willShow;
            if (button) {
                setNativeButtonLabel(button, willShow ? 'Hide Logs' : 'Chat Logs');
            }
        }

        return { wrapper, toggle };
    }

    // Enhance a viewer card with logs section
    function enhanceViewerCard(viewerCard) {
        if (viewerCard.querySelector('.enhancer-chatlogs') || viewerCard.querySelector('.enhancer-chatlogs-toggle-wrap')) {
            return;
        }

        const channel = getCurrentChannel();
        const username = getUsernameFromCard(viewerCard);

        if (!channel || !username) {
            return;
        }

        // Warm caches so opening Chat Logs is faster (availability + channel ID for emotes/badges)
        fetchLogAvailability(channel, username).catch(() => {});
        getChannelId(channel).catch(() => {});

        // Add account created date to header (async, fire and forget)
        addAccountCreatedToCard(viewerCard, username).catch(() => {});

        const { wrapper: logsWrapper, toggle: toggleLogs } = createLogsToggleSection(channel, username);

        // A copy of one of Twitch's own buttons, so it matches the current card; the old hard-coded markup is
        // only a fallback for cards with no text button to copy.
        const template = findNativeTextButton(viewerCard);
        const cloned = template && cloneNativeTextButton(template, 'Chat Logs');
        let toggleButton, buttonSlot;
        if (cloned) {
            ({ button: toggleButton, slot: buttonSlot } = cloned);
        } else {
            toggleButton = createNativeTextButton('Chat Logs');
            const buttonDragCancel = document.createElement('div');
            buttonDragCancel.className = 'InjectLayout-sc-1i43xsx-0 iDMNUO viewer-card-drag-cancel';
            buttonDragCancel.appendChild(toggleButton);
            buttonSlot = document.createElement('div');
            buttonSlot.className = 'Layout-sc-1xcs6mc-0 gPVkpw';
            buttonSlot.appendChild(buttonDragCancel);
        }
        toggleButton.classList.add('enhancer-chatlogs-toggle-button');
        toggleButton.addEventListener('click', () => toggleLogs(toggleButton));

        // Insert the button after the Whisper button (or Follow as fallback) in the native button row.
        // On your own viewer card neither button exists (it shows Edit Profile / Edit Chat Identity instead),
        // so fall back to any existing button slot in the action area.
        const whisperButton = viewerCard.querySelector('[data-test-selector="whisper-button"]');
        const followButton = viewerCard.querySelector('[data-a-target="follow-button"]');
        const anchorButton = whisperButton || followButton;

        if (anchorButton) {
            const anchorSlot = anchorButton.closest('.viewer-card-drag-cancel')?.parentElement;
            if (anchorSlot?.parentElement) {
                const buttonRow = anchorSlot.parentElement;
                buttonRow.insertBefore(buttonSlot, anchorSlot.nextSibling);

                // Twitch places empty flex-grow spacer slots after the buttons. When our button
                // wraps to a new row those spacers wrap with it and create a gap on the right.
                // Hide any sibling slots that follow ours and contain no visible content.
                let sibling = buttonSlot.nextElementSibling;
                while (sibling) {
                    const dragCancel = sibling.querySelector('.viewer-card-drag-cancel');
                    if (dragCancel && dragCancel.childElementCount === 0) {
                        sibling.style.display = 'none';
                    }
                    sibling = sibling.nextElementSibling;
                }
            }
        } else {
            // Self viewer card fallback: append to the parent of any existing button slot.
            // That container is a non-wrapping flex row sized for two buttons, so enable
            // wrapping so our third button doesn't overflow.
            const anySlot = template?.closest('.viewer-card-drag-cancel')?.parentElement || viewerCard.querySelector('.gPVkpw, .fsLBGq');
            const container = anySlot?.parentElement;
            if (container) {
                container.style.flexWrap = 'wrap';
                container.appendChild(buttonSlot);
            }
        }

        // Append the logs host section to the viewer card content
        const watchTimeSection = viewerCard.querySelector('.enhancer-watchtime');
        if (watchTimeSection) {
            watchTimeSection.parentNode.insertBefore(logsWrapper, watchTimeSection.nextSibling);
        } else {
            const viewerCardContent = viewerCard.querySelector('.viewer-card');
            if (viewerCardContent) {
                viewerCardContent.appendChild(logsWrapper);
            } else {
                viewerCard.appendChild(logsWrapper);
            }
        }

    }

    // Kick off fetchUserInfo as soon as the username link is available in the positioner,
    // so the result is cached by the time addAccountCreatedToCard runs.
    function prefetchUserInfoForPositioner(positioner) {
        function tryPrefetch() {
            const link = positioner.querySelector('.viewer-card-header__display-name a');
            if (link) {
                const href = link.getAttribute('href');
                const username = href ? href.replace(/^\//, '').toLowerCase() : null;
                if (username) {
                    fetchUserInfo(username).catch(() => {});
                }
                return true;
            }
            return false;
        }

        if (tryPrefetch()) return;

        // Username link not rendered yet — observe until it appears
        const inner = new MutationObserver(() => {
            if (tryPrefetch()) inner.disconnect();
        });
        inner.observe(positioner, { childList: true, subtree: true });
        setTimeout(() => inner.disconnect(), 3000);
    }

    // Watch for viewer cards
    function observeViewerCards() {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.matches && node.matches('[data-a-target="viewer-card-positioner"]')) {
                            // Pre-fetch user info immediately so account creation date is ready
                            prefetchUserInfoForPositioner(node);
                            const viewerCard = node.querySelector('[data-a-target="viewer-card"]');
                            if (viewerCard) {
                                prepareAccountCreatedForViewerCard(viewerCard);
                                setTimeout(() => enhanceViewerCard(viewerCard), 150);
                            }
                        }
                        // One scan for both targets instead of two, and none for leaf nodes such as most chat
                        // pieces, which cannot contain a card.
                        if (!node.firstElementChild) continue;
                        for (const found of node.querySelectorAll('[data-a-target="viewer-card-positioner"], [data-a-target="viewer-card"]')) {
                            if (found.matches('[data-a-target="viewer-card-positioner"]')) {
                                prefetchUserInfoForPositioner(found);
                            } else {
                                prepareAccountCreatedForViewerCard(found);
                                setTimeout(() => enhanceViewerCard(found), 150);
                            }
                        }
                    }
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        document.querySelectorAll('[data-a-target="viewer-card-positioner"]').forEach(positioner => {
            prefetchUserInfoForPositioner(positioner);
        });

        document.querySelectorAll('[data-a-target="viewer-card"]').forEach(card => {
            prepareAccountCreatedForViewerCard(card);
            enhanceViewerCard(card);
        });
    }

    // Preload emotes for current channel
    function preloadChannelEmotes() {
        const channel = getCurrentChannel();
        if (channel && channel !== currentChannel) {
            currentChannel = channel;
            loadEmotesForChannel(channel).catch(() => {});
        }
    }

    // Watch for channel changes to preload emotes
    function observeChannelChanges() {
        // Check on initial load
        setTimeout(preloadChannelEmotes, 1000);

        // Watch for URL changes using history API interception (lighter than MutationObserver)
        let lastUrl = location.href;

        // Intercept pushState and replaceState
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function(...args) {
            originalPushState.apply(this, args);
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                preloadChannelEmotes();
            }
        };

        history.replaceState = function(...args) {
            originalReplaceState.apply(this, args);
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                preloadChannelEmotes();
            }
        };

        // Also listen for popstate (back/forward navigation)
        window.addEventListener('popstate', () => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                preloadChannelEmotes();
            }
        });
    }

    // Periodic cleanup of expired cache entries
    // Only runs when page is visible, pauses when hidden
    function startCacheCleanup() {
        let cleanupIntervalId = null;

        const runCleanup = () => {
            const now = Date.now();

            // Clean expired emote cache entries
            for (const [key, entry] of emoteCache) {
                if (entry.expiresAt && entry.expiresAt <= now) {
                    emoteCache.delete(key);
                }
            }

            // Clean expired channel ID cache entries
            for (const [key, entry] of channelIdCache) {
                if (entry.expiresAt && entry.expiresAt <= now) {
                    channelIdCache.delete(key);
                }
            }

            // Clean expired user color cache entries
            for (const [key, entry] of userColorCache) {
                if (entry.expiresAt && entry.expiresAt <= now) {
                    userColorCache.delete(key);
                }
            }

            // Clean expired user info cache entries
            for (const [key, entry] of userInfoCache) {
                if (entry.expiresAt && entry.expiresAt <= now) {
                    userInfoCache.delete(key);
                }
            }
        };

        const startInterval = () => {
            if (!cleanupIntervalId) {
                cleanupIntervalId = setInterval(runCleanup, 5 * 60 * 1000); // Every 5 minutes
            }
        };

        const stopInterval = () => {
            if (cleanupIntervalId) {
                clearInterval(cleanupIntervalId);
                cleanupIntervalId = null;
            }
        };

        // Start/stop based on page visibility
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopInterval();
            } else {
                startInterval();
            }
        });

        // Full cleanup on page unload
        window.addEventListener('beforeunload', () => {
            stopInterval();

            // Clean up all active viewer card states
            for (const state of activeStates.values()) {
                cleanupState(state);
            }
            activeStates.clear();

            // Clear all caches
            emoteCache.clear();
            channelIdCache.clear();
            userColorCache.clear();
            userInfoCache.clear();

            // Close all IRC sockets
            for (const entry of ircSockets.values()) {
                if (entry.socket && entry.socket.readyState === WebSocket.OPEN) {
                    entry.socket.close();
                }
            }
            ircSockets.clear();
        });

        // Start interval if page is currently visible
        if (!document.hidden) {
            startInterval();
        }
    }

    function injectStyles() {
        if (document.getElementById('enhancer-chatlogs-styles')) return;
        const style = document.createElement('style');
        style.id = 'enhancer-chatlogs-styles';
        style.textContent = `
            /* Ensure the logs wrapper fills the full card width */
            .enhancer-chatlogs-toggle-wrap,
            .enhancer-chatlogs-host { width: 100%; box-sizing: border-box; }

            /* The panel styles itself from Twitch's theme variables (they follow light/dark mode). Twitch's
               generated class names change with every Twitch build, so the ones the panel still carries are
               only hints; layout and look come from here. */
            .enhancer-chatlogs {
                display: flex; flex-direction: column; gap: 0.6rem;
                padding: 0 1rem 1rem; box-sizing: border-box;
                color: var(--color-text-base, #efeff1); font-size: 1.3rem; line-height: 1.5;
            }
            .enhancer-chatlogs .chatlogs-header {
                display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.4rem 0.8rem;
            }
            .enhancer-chatlogs .chatlogs-meta {
                display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem;
                color: var(--color-text-alt-2, #adadb8); font-size: 1.2rem;
            }
            .enhancer-chatlogs .chatlogs-status {
                display: inline-flex; align-items: center; gap: 0.5rem; font-weight: 600; color: var(--color-text-base, #efeff1);
            }
            .enhancer-chatlogs .chatlogs-link {
                display: inline-flex; align-items: center; gap: 0.2rem; font-size: 1.2rem; font-weight: 600;
                color: var(--color-text-link, #bf94ff); text-decoration: none;
            }
            .enhancer-chatlogs .chatlogs-link:hover { color: var(--color-text-link-hover, #a970ff); text-decoration: underline; }
            .enhancer-chatlogs .chatlogs-toolbar,
            .enhancer-chatlogs .chatlogs-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; }
            .enhancer-chatlogs .chatlogs-toolbar { margin: 0; }
            /* Twitch's secondary (grey) pill buttons, one step below the purple Follow/Whisper/Chat Logs row. */
            .enhancer-chatlogs .chatlogs-action-button {
                display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
                height: 3rem; padding: 0 1.2rem; border: 0; border-radius: 9000px;
                background: var(--color-background-button-secondary-default, rgba(83, 83, 95, 0.38));
                color: var(--color-text-button-secondary, #efeff1);
                font-family: inherit; font-size: 1.3rem; font-weight: 600; line-height: 1; white-space: nowrap;
                cursor: pointer; appearance: none;
            }
            .enhancer-chatlogs .chatlogs-action-button:hover:not(:disabled) {
                background: var(--color-background-button-secondary-hover, rgba(83, 83, 95, 0.48));
            }
            .enhancer-chatlogs .chatlogs-action-button:active:not(:disabled) {
                background: var(--color-background-button-secondary-active, rgba(83, 83, 95, 0.55));
            }
            .enhancer-chatlogs .chatlogs-action-button:focus-visible {
                outline: 2px solid var(--color-border-interactable-focus, #a970ff); outline-offset: 2px;
            }
            .enhancer-chatlogs .chatlogs-action-button:disabled { opacity: 0.5; cursor: default; }
            .enhancer-chatlogs .chatlogs-action-button * { pointer-events: none; }
            .enhancer-chatlogs .chatlogs-messages {
                margin: 0 -0.4rem; padding: 0 0.4rem;
                border-top: 1px solid var(--color-border-base, rgba(83, 83, 95, 0.48));
                padding-top: 0.4rem;
            }
            .enhancer-chatlogs .chatlogs-message { display: block; padding: 0.3rem 0.4rem; line-height: 2rem; }
            /* Account Created row when the card has no Twitch info row to copy: one line, icon at Twitch's
               usual 2rem icon size, like "Previously Subbed for …". */
            .enhancer-account-created--fallback { display: flex; align-items: center; gap: 0.5rem; }
            .enhancer-account-created--fallback .tw-svg { display: inline-flex; flex: none; }
            .enhancer-account-created--fallback svg { width: 2rem; height: 2rem; flex: none; }
            .enhancer-account-created--fallback p { margin: 0; }
            .enhancer-chatlogs .vcml-message__timestamp {
                color: var(--color-text-alt-2, #adadb8); font-variant-numeric: tabular-nums; opacity: 1 !important;
            }

            /* Date separator - horizontal rule with centered date */
            .chatlogs-date-separator {
                display: flex;
                align-items: center;
                gap: 8px;
                margin: 10px 0 4px;
                font-size: 1.1rem;
                color: var(--color-text-alt-2, #adadb8);
                font-weight: 600;
                white-space: nowrap;
            }
            .chatlogs-date-separator::before,
            .chatlogs-date-separator::after {
                content: '';
                flex: 1;
                height: 1px;
                background: var(--color-border-base, rgba(255,255,255,0.15));
            }

            .chatlogs-live-separator {
                color: #00b26b;
            }
            .chatlogs-live-separator::before,
            .chatlogs-live-separator::after {
                background: rgba(0, 178, 107, 0.35);
            }

            /* Live status dot */
            .chatlogs-status-dot {
                display: inline-block;
                width: 7px;
                height: 7px;
                border-radius: 50%;
                margin-right: 4px;
                vertical-align: middle;
                position: relative;
                top: -1px;
                flex-shrink: 0;
            }
            .chatlogs-status-dot--live    { background: #00b26b; box-shadow: 0 0 0 2px rgba(0,178,107,0.25); }
            .chatlogs-status-dot--connecting { background: #f0a500; }
            .chatlogs-status-dot--stopped { background: #6b7280; }

            /* Message row */
            .chatlogs-message { border-radius: 2px; transition: background 0.1s; overflow-wrap: break-word; word-break: break-word; min-width: 0; }
            .chatlogs-message:hover { background: rgba(255,255,255,0.04); }

            /* Messages scrollbar - use standard properties to avoid permanent gutter reservation */
            .chatlogs-messages { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.25) transparent; }

            /* Count footer */
            .chatlogs-count { opacity: 0.65; text-align: center; }

            .chatlogs-link { font-size: 1.2rem; white-space: nowrap; }

            /* Emote images */
            .chatlogs-emote { display: inline-block !important; }

            /* Linkified URLs */
            .chatlogs-linkified { color: #a970ff; text-decoration: none; overflow-wrap: break-word; word-break: break-all; }
            .chatlogs-linkified:hover { text-decoration: underline; }

            /* Badges */
            .chatlogs-badges-container { display: inline; vertical-align: middle; margin-right: 2px; }
            .chatlogs-badge { display: inline-block; height: 1.8rem; width: auto; vertical-align: middle; margin-right: 3px; border-radius: 2px; }

            /* First-message pill */
            .chatlogs-first-msg {
                display: inline-block;
                font-size: 0.75em;
                font-weight: 600;
                background: rgba(100, 200, 255, 0.12);
                color: #7dd3fc;
                border: 1px solid rgba(100, 200, 255, 0.25);
                border-radius: 3px;
                padding: 0 4px;
                margin-left: 5px;
                vertical-align: middle;
                line-height: 1.5;
                cursor: default;
            }

            /* Reply context block above the message row */
            .chatlogs-reply-context {
                display: block;
                font-size: 1.1rem;
                opacity: 0.55;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                padding-left: 6px;
                margin-bottom: 2px;
                border-left: 2px solid rgba(255, 255, 255, 0.22);
            }

            /* Meta separator dot */
            .chatlogs-meta-sep { opacity: 0.4; margin: 0 2px; }

            /* Scroll-up loading spinner */
            .chatlogs-loading-spinner {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                padding: 8px 0;
                opacity: 0.75;
            }
            .chatlogs-spinner {
                display: inline-block;
                width: 16px;
                height: 16px;
                border: 2px solid rgba(169,112,255,0.25);
                border-top-color: #a970ff;
                border-radius: 50%;
                animation: chatlogs-spin 0.7s linear infinite;
                flex-shrink: 0;
            }
            .chatlogs-spinner-label {
                font-size: 1.1rem;
                color: var(--color-text-alt-2, #adadb8);
            }
            @keyframes chatlogs-spin {
                to { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }

    // Initialize
    function init() {
        injectStyles();
        observeViewerCards();
        observeChannelChanges();
        startCacheCleanup();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    } catch (error) {
      console.error('[Twitch Plus] viewerLogs', error);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
};

export default viewerLogs;
