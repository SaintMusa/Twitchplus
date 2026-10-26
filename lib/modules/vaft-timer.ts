// @ts-nocheck
/*! @license MIT
 * Based on TwitchAdSolutions vaft 37.0.0, https://github.com/pixeltris/TwitchAdSolutions
 * Copyright (c) 2020-present TwitchAdSolutions Contributors
 * Credits: https://github.com/cleanlock/VideoAdBlockForTwitch#credits
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// Builds the video worker's source from this file's function text (toString), hence the unminified build (wxt.config.ts).
import type { Module } from '../modules';

const vaftTimer: Module = () => {
    'use strict';
    const ourTwitchAdSolutionsVersion = 24;// Used to prevent conflicts with outdated versions of the scripts
    if (typeof window.twitchAdSolutionsVersion !== 'undefined' && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
    function declareOptions(scope) {
        scope.AdSignifier = 'stitched';
        scope.ClientID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        scope.BackupPlayerTypes = [
            'embed',//Source
            'popout',//Source
            'autoplay',//360p
        ];
        scope.FallbackPlayerType = 'embed';
        scope.ForceAccessTokenPlayerType = 'popout';
        scope.SkipPlayerReloadOnHevc = false;// If true this will skip player reload on streams which have 2k/4k quality (if you enable this and you use the 2k/4k quality setting you'll get error #4000 / #3000 / spinning wheel on chrome based browsers)
        scope.AlwaysReloadPlayerOnAd = false;// Always pause/play when entering/leaving ads
        scope.ReloadPlayerAfterAd = true;// After the ad finishes do a player reload instead of pause/play
        scope.PlayerReloadMinimalRequestsTime = 1500;
        scope.PlayerReloadMinimalRequestsPlayerIndex = 2;//autoplay
        scope.HasTriggeredPlayerReload = false;
        scope.StreamInfos = [];
        scope.StreamInfosByUrl = [];
        scope.GQLDeviceID = null;
        scope.ClientVersion = null;
        scope.ClientSession = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.PlayerBufferingFix = true;// If true this will pause/play the player when it gets stuck buffering
        scope.PlayerBufferingDelay = 600;// How often should we check the player state (in milliseconds)
        scope.PlayerBufferingIdleDelay = 3000;// How often to look for a player while there isn't one (in milliseconds)
        scope.PlayerBufferingSameStateCount = 3;// How many times of seeing the same player state until we trigger pause/play (it will only trigger it one time until the player state changes again)
        scope.PlayerBufferingDangerZone = 1;// The buffering time left (in seconds) when we should ignore the players playback position in the player state check
        scope.PlayerBufferingDoPlayerReload = false;// If true this will do a player reload instead of pause/play (player reloading is better at fixing the playback issues but it takes slightly longer)
        scope.PlayerBufferingMinRepeatDelay = 8000;// Minimum delay (in milliseconds) between each pause/play (this is to avoid over pressing pause/play when there are genuine buffering problems)
        scope.PlayerBufferingPrerollCheckEnabled = false;// Enable this if you're getting an immediate pause/play/reload as you open a stream (which is causing the stream to take longer to load). One problem with this being true is that it can cause the player to get stuck in some instances requiring the user to press pause/play
        scope.PlayerBufferingPrerollCheckOffset = 5;// How far the stream need to move before doing the buffering mitigation (depends on PlayerBufferingPrerollCheckEnabled being true)
        scope.V2API = false;
        scope.IsAdStrippingEnabled = true;
        scope.AdSegmentCache = new Map();
        scope.ForceSuppressClientAds = true;// Sets SUPPRESS="true" in the master playlist, the flag Twitch's page checks before running client-side ads
        scope.BackupPlayerTypeCooldown = 10000;// After a backup player type serves ads, skip it for this long (in milliseconds) instead of re-requesting it every playlist refresh
        scope.AccessTokenCache = new Map();// channel + player type -> { token, expires }
        scope.GqlRequestTimeout = 8000;// Give up on a GQL request relayed through the page after this long (in milliseconds)
        scope.ShortCircuitAdGqlRequests = true;// Answer Twitch's client-side ad GQL queries (VideoAdRequestDecline, FetchAdsService_FetchAds) locally with "no ad"
    }
    let isActivelyStrippingAds = false;
    let localStorageHookFailed = false;
    let lastAdBannerData = null;
    const twitchWorkers = [];
    const workerStringConflicts = [
        'twitch',
        'isVariantA'// TwitchNoSub
    ];
    const workerStringAllow = [];
    const workerStringReinsert = [
        'isVariantA',// TwitchNoSub (prior to (0.9))
        'besuper/',// TwitchNoSub (0.9)
        '${patch_url}'// TwitchNoSub (0.9.1)
    ];
    function getCleanWorker(worker) {
        let root = null;
        let parent = null;
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringConflicts.some((x) => workerString.includes(x)) && !workerStringAllow.some((x) => workerString.includes(x))) {
                if (parent !== null) {
                    Object.setPrototypeOf(parent, Object.getPrototypeOf(proto));
                }
            } else {
                if (root === null) {
                    root = proto;
                }
                parent = proto;
            }
            proto = Object.getPrototypeOf(proto);
        }
        return root;
    }
    function getWorkersForReinsert(worker) {
        const result = [];
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringReinsert.some((x) => workerString.includes(x))) {
                result.push(proto);
            }
            proto = Object.getPrototypeOf(proto);
        }
        return result;
    }
    function reinsertWorkers(worker, reinsert) {
        let parent = worker;
        for (let i = 0; i < reinsert.length; i++) {
            Object.setPrototypeOf(reinsert[i], parent);
            parent = reinsert[i];
        }
        return parent;
    }
    function isValidWorker(worker) {
        const workerString = worker.toString();
        return !workerStringConflicts.some((x) => workerString.includes(x))
            || workerStringAllow.some((x) => workerString.includes(x))
            || workerStringReinsert.some((x) => workerString.includes(x));
    }
    function hookWindowWorker() {
        const reinsert = getWorkersForReinsert(window.Worker);
        const newWorker = class Worker extends getCleanWorker(window.Worker) {
            constructor(twitchBlobUrl, options) {
                let isTwitchWorker = false;
                try {
                    isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith('.twitch.tv');
                } catch {}
                if (!isTwitchWorker) {
                    super(twitchBlobUrl, options);
                    return;
                }
                const newBlobStr = `
                    const pendingFetchRequests = new Map();
                    ${stripAdSegments.toString()}
                    ${getPlaylistHeadTime.toString()}
                    ${stripMafAds.toString()}
                    ${getAdPodInfo.toString()}
                    ${cleanServedPlaylist.toString()}
                    ${forceSuppressClientAds.toString()}
                    ${getVideoSessionId.toString()}
                    ${getBackupAccessToken.toString()}
                    ${getStreamUrlForResolution.toString()}
                    ${processM3U8.toString()}
                    ${hookWorkerFetch.toString()}
                    ${declareOptions.toString()}
                    ${getAccessToken.toString()}
                    ${gqlRequest.toString()}
                    ${parseAttributes.toString()}
                    ${getWasmWorkerJs.toString()}
                    ${getServerTimeFromM3u8.toString()}
                    ${replaceServerTimeInM3u8.toString()}
                    const workerString = getWasmWorkerJs('${twitchBlobUrl.replaceAll("'", "%27")}');
                    declareOptions(self);
                    GQLDeviceID = ${GQLDeviceID ? "'" + GQLDeviceID + "'" : null};
                    AuthorizationHeader = ${AuthorizationHeader ? "'" + AuthorizationHeader + "'" : undefined};
                    ClientIntegrityHeader = ${ClientIntegrityHeader ? "'" + ClientIntegrityHeader + "'" : null};
                    ClientVersion = ${ClientVersion ? "'" + ClientVersion + "'" : null};
                    ClientSession = ${ClientSession ? "'" + ClientSession + "'" : null};
                    self.addEventListener('message', function(e) {
                        if (e.data.key == 'UpdateClientVersion') {
                            ClientVersion = e.data.value;
                        } else if (e.data.key == 'UpdateClientSession') {
                            ClientSession = e.data.value;
                        } else if (e.data.key == 'UpdateDeviceId') {
                            GQLDeviceID = e.data.value;
                        } else if (e.data.key == 'UpdateClientIntegrityHeader') {
                            ClientIntegrityHeader = e.data.value;
                        } else if (e.data.key == 'UpdateAuthorizationHeader') {
                            AuthorizationHeader = e.data.value;
                        } else if (e.data.key == 'FetchResponse') {
                            const responseData = e.data.value;
                            if (pendingFetchRequests.has(responseData.id)) {
                                const { resolve, reject } = pendingFetchRequests.get(responseData.id);
                                pendingFetchRequests.delete(responseData.id);
                                if (responseData.error) {
                                    reject(new Error(responseData.error));
                                } else {
                                    // Create a Response object from the response data
                                    const response = new Response(responseData.body, {
                                        status: responseData.status,
                                        statusText: responseData.statusText,
                                        headers: responseData.headers
                                    });
                                    resolve(response);
                                }
                            }
                        } else if (e.data.key == 'TriggeredPlayerReload') {
                            HasTriggeredPlayerReload = true;
                        }
                    });
                    hookWorkerFetch();
                    eval(workerString);
                `;
                const blobUrl = URL.createObjectURL(new Blob([newBlobStr]));
                super(blobUrl, options);
                twitchWorkers.push(this);
                // Forget workers Twitch shuts down, so messages stop going to them and their blob can be freed
                const realTerminate = this.terminate;
                this.terminate = function() {
                    const index = twitchWorkers.indexOf(this);
                    if (index >= 0) {
                        twitchWorkers.splice(index, 1);
                    }
                    URL.revokeObjectURL(blobUrl);
                    return realTerminate.apply(this, arguments);
                };
                this.addEventListener('message', (e) => {
                    if (e.data.key == 'UpdateAdBlockBanner') {
                        lastAdBannerData = e.data;
                        updateAdblockBanner(e.data);
                    } else if (e.data.key == 'PauseResumePlayer') {
                        doTwitchPlayerTask(true, false);
                    } else if (e.data.key == 'ReloadPlayer') {
                        doTwitchPlayerTask(false, true);
                    }
                });
                this.addEventListener('message', async event => {
                    if (event.data.key == 'FetchRequest') {
                        const fetchRequest = event.data.value;
                        const responseData = await handleWorkerFetchRequest(fetchRequest);
                        this.postMessage({
                            key: 'FetchResponse',
                            value: responseData
                        });
                    }
                });
            }
        };
        let workerInstance = reinsertWorkers(newWorker, reinsert);
        Object.defineProperty(window, 'Worker', {
            get: function() {
                return workerInstance;
            },
            set: function(value) {
                if (isValidWorker(value)) {
                    workerInstance = value;
                } else {
                    console.log('Attempt to set twitch worker denied');
                }
            }
        });
    }
    function getWasmWorkerJs(twitchBlobUrl) {
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.overrideMimeType("text/javascript");
        req.send();
        return req.responseText;
    }
    function hookWorkerFetch() {
        const realFetch = fetch;
        fetch = async function(url, options) {
            if (typeof url === 'string') {
                if (AdSegmentCache.has(url)) {
                    return new Promise(function(resolve, reject) {
                        const send = function() {
                            return realFetch('data:video/mp4;base64,AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA', options).then(function(response) {
                                resolve(response);
                            })['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                }
                url = url.trimEnd();
                if (url.endsWith('m3u8')) {
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status !== 200) {
                                resolve(response);
                                return;
                            }
                            const textStr = await response.text();
                            try {
                                resolve(new Response(await processM3U8(url, textStr, realFetch)));
                            } catch (err) {
                                // Never leave the player's request hanging: hand it the playlist unchanged
                                console.error('vaft: failed to process playlist', err);
                                resolve(new Response(textStr));
                            }
                        };
                        realFetch(url, options).then(processAfter)['catch'](function(err) {
                            reject(err);
                        });
                    });
                } else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    const channelName = (new URL(url)).pathname.match(/([^\/]+)(?=\.\w+$)/)[0];
                    if (ForceAccessTokenPlayerType) {
                        // parent_domains is used to determine if the player is embeded and stripping it gets rid of fake ads
                        const tempUrl = new URL(url);
                        tempUrl.searchParams.delete('parent_domains');
                        url = tempUrl.toString();
                    }
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status != 200) {
                                resolve(response);
                                return;
                            }
                            const encodingsM3u8 = await response.text();
                            try {
                                const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                                let streamInfo = StreamInfos[channelName];
                                if (streamInfo != null && streamInfo.EncodingsM3U8 != null) {
                                    let isCacheAlive = false;
                                    try {
                                        const cachedStreamUrl = streamInfo.EncodingsM3U8.match(/^https:.*\.m3u8$/m);
                                        isCacheAlive = cachedStreamUrl != null && (await realFetch(cachedStreamUrl[0])).status === 200;
                                    } catch {}
                                    if (!isCacheAlive) {
                                        // The cached encodings are dead (the stream probably restarted)
                                        for (const streamUrl of Object.keys(streamInfo.Urls)) {
                                            delete StreamInfosByUrl[streamUrl];
                                        }
                                        streamInfo = null;
                                    }
                                }
                                if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                                    StreamInfos[channelName] = streamInfo = {
                                        ChannelName: channelName,
                                        IsShowingAd: false,
                                        LastPlayerReload: 0,
                                        EncodingsM3U8: encodingsM3u8,
                                        ModifiedM3U8: null,
                                        IsUsingModifiedM3U8: false,
                                        UsherParams: (new URL(url)).search,
                                        RequestedAds: new Set(),
                                        Urls: [],// xxx.m3u8 -> { Resolution: "284x160", FrameRate: 30.0 }
                                        ResolutionList: [],
                                        BackupEncodingsM3U8Cache: [],
                                        ActiveBackupPlayerType: null,
                                        IsMidroll: false,
                                        IsStrippingAdSegments: false,
                                        NumStrippedAdSegments: 0,
                                        AdPodInfo: null,
                                        MafAdInfo: null,
                                        VideoSessionId: getVideoSessionId(encodingsM3u8),
                                        BackupCooldownUntil: {}// player type -> time it may be tried again after serving ads
                                    };
                                    const lines = encodingsM3u8.replaceAll('\r', '').split('\n');
                                    for (let i = 0; i < lines.length - 1; i++) {
                                        if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1].includes('.m3u8')) {
                                            const attributes = parseAttributes(lines[i]);
                                            const resolution = attributes['RESOLUTION'];
                                            if (resolution) {
                                                const resolutionInfo = {
                                                    Resolution: resolution,
                                                    FrameRate: attributes['FRAME-RATE'],
                                                    Codecs: attributes['CODECS'],
                                                    Url: lines[i + 1]
                                                };
                                                streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                                                streamInfo.ResolutionList.push(resolutionInfo);
                                            }
                                            StreamInfosByUrl[lines[i + 1]] = streamInfo;
                                        }
                                    }
                                    const nonHevcResolutionList = streamInfo.ResolutionList.filter((element) => element.Codecs.startsWith('avc') || element.Codecs.startsWith('av0'));
                                    if (AlwaysReloadPlayerOnAd || (nonHevcResolutionList.length > 0 && streamInfo.ResolutionList.some((element) => element.Codecs.startsWith('hev') || element.Codecs.startsWith('hvc')) && !SkipPlayerReloadOnHevc)) {
                                        if (nonHevcResolutionList.length > 0) {
                                            for (let i = 0; i < lines.length - 1; i++) {
                                                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                                                    const resSettings = parseAttributes(lines[i].substring(lines[i].indexOf(':') + 1));
                                                    const codecsKey = 'CODECS';
                                                    if (resSettings[codecsKey].startsWith('hev') || resSettings[codecsKey].startsWith('hvc')) {
                                                        const oldResolution = resSettings['RESOLUTION'];
                                                        const [targetWidth, targetHeight] = oldResolution.split('x').map(Number);
                                                        const newResolutionInfo = nonHevcResolutionList.sort((a, b) => {
                                                            // TODO: Take into account 'Frame-Rate' when sorting (i.e. 1080p60 vs 1080p30)
                                                            const [streamWidthA, streamHeightA] = a.Resolution.split('x').map(Number);
                                                            const [streamWidthB, streamHeightB] = b.Resolution.split('x').map(Number);
                                                            return Math.abs((streamWidthA * streamHeightA) - (targetWidth * targetHeight)) - Math.abs((streamWidthB * streamHeightB) - (targetWidth * targetHeight));
                                                        })[0];
                                                        lines[i] = lines[i].replace(/CODECS="[^"]+"/, `CODECS="${newResolutionInfo.Codecs}"`);
                                                        lines[i + 1] = newResolutionInfo.Url + ' '.repeat(i + 1);// The stream doesn't load unless each url line is unique
                                                    }
                                                }
                                            }
                                        }
                                        if (nonHevcResolutionList.length > 0 || AlwaysReloadPlayerOnAd) {
                                            streamInfo.ModifiedM3U8 = lines.join('\n');
                                        }
                                    }
                                }
                                streamInfo.LastPlayerReload = Date.now();
                                const servedM3u8 = replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime);
                                resolve(new Response(ForceSuppressClientAds ? forceSuppressClientAds(servedM3u8) : servedM3u8));
                            } catch (err) {
                                console.error('vaft: failed to process encodings playlist', err);
                                resolve(new Response(encodingsM3u8));
                            }
                        };
                        realFetch(url, options).then(processAfter)['catch'](function(err) {
                            reject(err);
                        });
                    });
                }
            }
            return realFetch.apply(this, arguments);
        };
    }
    function getServerTimeFromM3u8(encodingsM3u8) {
        if (V2API) {
            const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
            return matches && matches.length > 1 ? matches[1] : null;
        }
        const matches = encodingsM3u8.match('SERVER-TIME="([0-9.]+)"');
        return matches && matches.length > 1 ? matches[1] : null;
    }
    function forceSuppressClientAds(encodingsM3u8) {
        // Twitch's page skips client-side ads when the player's session data has SUPPRESS="true" (from #EXT-X-TWITCH-INFO, or SESSION-DATA on the v2 API)
        const sessionDataRegex = /(#EXT-X-SESSION-DATA:DATA-ID="SUPPRESS",VALUE=")[^"]*(")/;
        if (sessionDataRegex.test(encodingsM3u8)) {
            return encodingsM3u8.replace(sessionDataRegex, '$1true$2');
        }
        const lines = encodingsM3u8.split('\n');
        const infoIndex = lines.findIndex(line => line.startsWith('#EXT-X-TWITCH-INFO:'));
        if (infoIndex >= 0) {
            lines[infoIndex] = /SUPPRESS="[^"]*"/.test(lines[infoIndex]) ? lines[infoIndex].replace(/SUPPRESS="[^"]*"/, 'SUPPRESS="true"') : lines[infoIndex].trimEnd() + ',SUPPRESS="true"';
        } else if (lines[0].startsWith('#EXTM3U')) {
            lines.splice(1, 0, '#EXT-X-SESSION-DATA:DATA-ID="SUPPRESS",VALUE="true"');
        }
        return lines.join('\n');
    }
    function getVideoSessionId(encodingsM3u8) {
        const matches = encodingsM3u8.match(/VIDEO-SESSION-ID="([^"]+)"/) || encodingsM3u8.match(/DATA-ID="VIDEO-SESSION-ID",VALUE="([^"]+)"/);
        return matches ? matches[1] : null;
    }
    function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
        if (V2API) {
            return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, `$1${newServerTime}$2`) : encodingsM3u8;
        }
        return newServerTime ? encodingsM3u8.replace(new RegExp('(SERVER-TIME=")[0-9.]+"'), `SERVER-TIME="${newServerTime}"`) : encodingsM3u8;
    }
    function stripAdSegments(textStr, stripAllSegments, streamInfo) {
        let hasStrippedAdSegments = false;
        const lines = textStr.replaceAll('\r', '').split('\n');
        const newAdUrl = 'https://twitch.tv';
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            // Remove tracking urls which appear in the overlay UI
            if (line.includes('X-TV-TWITCH-AD-')) {
                line = lines[i] = line
                    .replaceAll(/(X-TV-TWITCH-AD-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`)
                    .replaceAll(/(X-TV-TWITCH-AD-CLICK-TRACKING-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`);
            }
            if (i < lines.length - 1 && line.startsWith('#EXTINF') && (!line.includes(',live') || stripAllSegments)) {
                const segmentUrl = lines[i + 1];
                if (!AdSegmentCache.has(segmentUrl)) {
                    streamInfo.NumStrippedAdSegments++;
                }
                AdSegmentCache.set(segmentUrl, Date.now());
                hasStrippedAdSegments = true;
            }
            if (line.includes(AdSignifier)) {
                hasStrippedAdSegments = true;
            }
        }
        if (hasStrippedAdSegments) {
            for (let i = 0; i < lines.length; i++) {
                // No low latency during ads (otherwise it's possible for the player to prefetch and display ad segments)
                if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    lines[i] = '';
                }
            }
        } else {
            streamInfo.NumStrippedAdSegments = 0;
        }
        streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
        AdSegmentCache.forEach((value, key, map) => {
            if (value < Date.now() - 120000) {
                map.delete(key);
            }
        });
        return lines.join('\n');
    }
    function getPlaylistHeadTime(lines) {
        // Wall-clock time at the live edge: the last PROGRAM-DATE-TIME plus the segments after it (null if the playlist has none)
        let headTime = null;
        for (const line of lines) {
            if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
                const time = Date.parse(line.substring(line.indexOf(':') + 1));
                if (!Number.isNaN(time)) {
                    headTime = time;
                }
            } else if (line.startsWith('#EXTINF:') && headTime != null) {
                headTime += (parseFloat(line.substring(8)) || 0) * 1000;
            }
        }
        return headTime;
    }
    function stripMafAds(textStr, streamInfo) {
        // twitch-maf-ad tags make the page fetch a client-side ad (squeezeback, lower third, picture-by-picture video, ...).
        // Removing them means the player never reports the break, so Twitch never requests the ad.
        // pbyp-preflight tags make the page warm up its picture-by-picture ad player, so they go too
        if (streamInfo.MafAdInfo && streamInfo.MafAdInfo.endTime <= Date.now()) {
            streamInfo.MafAdInfo = null;
        }
        if (!textStr.includes('twitch-maf-ad') && !textStr.includes('pbyp-preflight')) {
            return textStr;
        }
        let lines = textStr.replaceAll('\r', '').split('\n');
        lines = lines.filter(line => !(line.startsWith('#EXT-X-DATERANGE:') && line.includes('pbyp-preflight')));
        const mafLines = lines.filter(line => line.startsWith('#EXT-X-DATERANGE:') && line.includes('twitch-maf-ad'));
        if (mafLines.length == 0) {
            return lines.join('\n');
        }
        const formatNames = {
            1: 'video',
            2: 'audio',
            3: 'squeezeback',
            4: 'lower third',
            5: 'vertical video',
            6: 'picture-by-picture',
            9: 'playable',
            10: 'pause'
        };
        const now = getPlaylistHeadTime(lines) ?? Date.now();
        for (const line of mafLines) {
            const attributes = parseAttributes(line.substring(line.indexOf(':') + 1));
            const duration = Number(attributes['PLANNED-DURATION'] ?? attributes['DURATION']) * 1000;
            if (!(duration > 0)) {
                continue;
            }
            const id = String(attributes['ID'] ?? attributes['X-TTV-MAF-AD-COMMERCIAL-ID'] ?? '');
            const start = Date.parse(attributes['START-DATE']);
            let endTime;
            if (!Number.isNaN(start)) {
                endTime = Date.now() + Math.min(duration, Math.max(0, start + duration - now));
            } else if (streamInfo.MafAdInfo && streamInfo.MafAdInfo.id == id) {
                endTime = streamInfo.MafAdInfo.endTime;
            } else {
                endTime = Date.now() + duration;
            }
            if (endTime <= Date.now()) {
                continue;
            }
            const format = parseInt(String(attributes['X-TTV-MAF-AD-PRIMARY-POD'] ?? '').split(',')[0], 10);
            if (!streamInfo.MafAdInfo || streamInfo.MafAdInfo.id != id) {
                console.log(`Blocking MAF ad break (${formatNames[format] || 'format ' + format}, ${duration / 1000}s)`);
            }
            streamInfo.MafAdInfo = {
                id: id,
                formatName: formatNames[format] || null,
                endTime: endTime
            };
        }
        return lines.filter(line => !mafLines.includes(line)).join('\n');
    }
    function getAdPodInfo(textStr) {
        // Reads the current ad's pod position and time left from the twitch-stitched-ad DATERANGE tags (what Twitch's own ad countdown uses)
        const lines = textStr.replaceAll('\r', '').split('\n');
        const ads = [];
        const headTime = getPlaylistHeadTime(lines);
        for (const line of lines) {
            if (line.startsWith('#EXT-X-DATERANGE:') && line.includes('twitch-stitched-ad')) {
                const attributes = parseAttributes(line.substring(line.indexOf(':') + 1));
                const start = Date.parse(attributes['START-DATE']);
                const duration = Number(attributes['DURATION']);
                if (!Number.isNaN(start) && duration > 0) {
                    ads.push({
                        start: start,
                        duration: duration * 1000,
                        position: Number(attributes['X-TV-TWITCH-AD-POD-POSITION']) || 0,
                        length: Number(attributes['X-TV-TWITCH-AD-POD-LENGTH']) || 0
                    });
                }
            }
        }
        if (ads.length == 0) {
            return null;
        }
        // No PROGRAM-DATE-TIME: fall back to the local clock
        const now = headTime ?? Date.now();
        ads.sort((a, b) => a.start - b.start);
        const started = ads.filter(ad => ad.start <= now);
        const ad = started.length > 0 ? started[started.length - 1] : ads[0];
        const remaining = Math.min(ad.duration, Math.max(0, ad.start + ad.duration - now));
        return {
            podPosition: ad.position + 1,
            podLength: Math.max(ad.length, ad.position + 1),
            endTime: Date.now() + remaining
        };
    }
    function cleanServedPlaylist(textStr, streamInfo) {
        // Runs on the playlist handed to the player during an ad:
        // - drops twitch-stitched-ad / twitch-ad-quartile tags that survive in a backup, so Twitch's ad overlay and impression beacons never start
        // - gives a backup playlist's twitch-session tag the main stream's session id, otherwise the page reports the mismatch (ads_hank)
        const hasAdTags = textStr.includes('twitch-stitched-ad') || textStr.includes('twitch-ad-quartile');
        const hasSessionTag = streamInfo.VideoSessionId && textStr.includes('X-TV-TWITCH-SESSIONID=');
        if (!hasAdTags && !hasSessionTag) {
            return textStr;
        }
        const lines = [];
        for (let line of textStr.split('\n')) {
            if (line.startsWith('#EXT-X-DATERANGE:')) {
                if (line.includes('twitch-stitched-ad') || line.includes('twitch-ad-quartile')) {
                    continue;
                }
                if (hasSessionTag) {
                    line = line.replace(/(X-TV-TWITCH-SESSIONID=")[^"]*(")/, `$1${streamInfo.VideoSessionId}$2`);
                }
            }
            lines.push(line);
        }
        return lines.join('\n');
    }
    async function getBackupAccessToken(channelName, playerType, forceNew) {
        // Tokens are cached until they expire (as Twitch's own player does); forceNew is used after a backup served ads so the next try gets a new session
        const cacheKey = channelName + '|' + playerType;
        const cached = AccessTokenCache.get(cacheKey);
        if (!forceNew && cached && cached.expires > Date.now() + 30000) {
            return cached.token;
        }
        AccessTokenCache.delete(cacheKey);
        const accessTokenResponse = await getAccessToken(channelName, playerType);
        if (accessTokenResponse.status !== 200) {
            return null;
        }
        const token = (await accessTokenResponse.json())?.data?.streamPlaybackAccessToken;
        if (!token?.value || !token?.signature) {
            return null;
        }
        let expires = 0;
        try {
            expires = JSON.parse(token.value).expires * 1000;
        } catch {}
        if (expires > Date.now()) {
            AccessTokenCache.set(cacheKey, { token: token, expires: expires });
        }
        return token;
    }
    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
        const encodingsLines = encodingsM3u8.replaceAll('\r', '').split('\n');
        const [targetWidth, targetHeight] = resolutionInfo.Resolution.split('x').map(Number);
        let matchedResolutionUrl = null;
        let matchedFrameRate = false;
        let closestResolutionUrl = null;
        let closestResolutionDifference = Infinity;
        for (let i = 0; i < encodingsLines.length - 1; i++) {
            if (encodingsLines[i].startsWith('#EXT-X-STREAM-INF') && encodingsLines[i + 1].includes('.m3u8')) {
                const attributes = parseAttributes(encodingsLines[i]);
                const resolution = attributes['RESOLUTION'];
                const frameRate = attributes['FRAME-RATE'];
                if (resolution) {
                    if (resolution == resolutionInfo.Resolution && (!matchedResolutionUrl || (!matchedFrameRate && frameRate == resolutionInfo.FrameRate))) {
                        matchedResolutionUrl = encodingsLines[i + 1];
                        matchedFrameRate = frameRate == resolutionInfo.FrameRate;
                        if (matchedFrameRate) {
                            return matchedResolutionUrl;
                        }
                    }
                    const [width, height] = resolution.split('x').map(Number);
                    const difference = Math.abs((width * height) - (targetWidth * targetHeight));
                    if (difference < closestResolutionDifference) {
                        closestResolutionUrl = encodingsLines[i + 1];
                        closestResolutionDifference = difference;
                    }
                }
            }
        }
        return closestResolutionUrl;
    }
    async function processM3U8(url, textStr, realFetch) {
        const streamInfo = StreamInfosByUrl[url];
        if (!streamInfo) {
            return textStr;
        }
        if (HasTriggeredPlayerReload) {
            HasTriggeredPlayerReload = false;
            streamInfo.LastPlayerReload = Date.now();
        }
        textStr = stripMafAds(textStr, streamInfo);
        const haveAdTags = textStr.includes(AdSignifier);
        if (haveAdTags) {
            streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
            // Keep the last known info when a playlist has no ad tags of its own (e.g. between two ads of a pod)
            streamInfo.AdPodInfo = getAdPodInfo(textStr) || streamInfo.AdPodInfo;
            if (!streamInfo.IsShowingAd) {
                streamInfo.IsShowingAd = true;
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: false,
                    adPodInfo: streamInfo.AdPodInfo
                });
            }
            if (!streamInfo.IsMidroll) {
                const lines = textStr.replaceAll('\r', '').split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                        if (!line.includes(',live') && !streamInfo.RequestedAds.has(lines[i + 1])) {
                            // Only request one .ts file per .m3u8 request to avoid making too many requests
                            streamInfo.RequestedAds.add(lines[i + 1]);
                            fetch(lines[i + 1]).then((response) => response.blob())['catch'](() => {});
                            break;
                        }
                    }
                }
            }
            const currentResolution = streamInfo.Urls[url];
            if (!currentResolution) {
                console.log('Ads will leak due to missing resolution info for ' + url);
                return textStr;
            }
            const isHevc = currentResolution.Codecs.startsWith('hev') || currentResolution.Codecs.startsWith('hvc');
            if (((isHevc && !SkipPlayerReloadOnHevc) || AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8) {
                streamInfo.IsUsingModifiedM3U8 = true;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            }
            let backupPlayerType = null;
            let backupM3u8 = null;
            let fallbackM3u8 = null;
            let startIndex = 0;
            let isDoingMinimalRequests = false;
            if (streamInfo.LastPlayerReload > Date.now() - PlayerReloadMinimalRequestsTime) {
                // When doing player reload there are a lot of requests which causes the backup stream to load in slow. Briefly prefer using a single version to prevent long delays
                startIndex = PlayerReloadMinimalRequestsPlayerIndex;
                isDoingMinimalRequests = true;
            }
            // Player types that served ads recently are skipped until their cooldown ends (if all are cooling down, all are tried)
            const cooldownNow = Date.now();
            const allPlayerTypes = BackupPlayerTypes.slice(startIndex);
            const readyPlayerTypes = allPlayerTypes.filter(playerType => !(streamInfo.BackupCooldownUntil[playerType] > cooldownNow));
            const playerTypesToTry = readyPlayerTypes.length > 0 ? readyPlayerTypes : allPlayerTypes;
            for (let tryIndex = 0; !backupM3u8 && tryIndex < playerTypesToTry.length; tryIndex++) {
                const playerType = playerTypesToTry[tryIndex];
                const playerTypeIndex = BackupPlayerTypes.indexOf(playerType);
                const isLastPlayerType = tryIndex >= playerTypesToTry.length - 1;
                const realPlayerType = playerType.replace('-CACHED', '');
                const isFullyCachedPlayerType = playerType != realPlayerType;
                let servedAds = false;
                for (let i = 0; i < 2; i++) {
                    // This caches the m3u8 if it doesn't have ads. If the already existing cache has ads it fetches a new version (second loop)
                    let isFreshM3u8 = false;
                    let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
                    if (!encodingsM3u8) {
                        isFreshM3u8 = true;
                        try {
                            // A new token after this type served ads, a cached one otherwise
                            const accessToken = await getBackupAccessToken(streamInfo.ChannelName, realPlayerType, i > 0 || streamInfo.BackupCooldownUntil[playerType] != null);
                            if (accessToken) {
                                const urlInfo = new URL('https://usher.ttvnw.net/api/' + (V2API ? 'v2/' : '') + 'channel/hls/' + streamInfo.ChannelName + '.m3u8' + streamInfo.UsherParams);
                                urlInfo.searchParams.set('sig', accessToken.signature);
                                urlInfo.searchParams.set('token', accessToken.value);
                                const encodingsM3u8Response = await realFetch(urlInfo.href);
                                if (encodingsM3u8Response.status === 200) {
                                    encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType] = await encodingsM3u8Response.text();
                                }
                            }
                        } catch (err) {}
                    }
                    if (encodingsM3u8) {
                        try {
                            const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution);
                            const streamM3u8Response = await realFetch(streamM3u8Url);
                            if (streamM3u8Response.status == 200) {
                                const m3u8Text = await streamM3u8Response.text();
                                if (m3u8Text) {
                                    if (playerType == FallbackPlayerType) {
                                        fallbackM3u8 = m3u8Text;
                                    }
                                    servedAds = m3u8Text.includes(AdSignifier);
                                    if (!servedAds || (!fallbackM3u8 && isLastPlayerType)) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                    if (isFullyCachedPlayerType) {
                                        break;
                                    }
                                    if (isDoingMinimalRequests) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                }
                            }
                        } catch (err) {}
                    }
                    streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
                    if (isFreshM3u8) {
                        break;
                    }
                }
                if (servedAds) {
                    streamInfo.BackupCooldownUntil[playerType] = Date.now() + BackupPlayerTypeCooldown;
                } else if (backupPlayerType == playerType) {
                    delete streamInfo.BackupCooldownUntil[playerType];
                }
            }
            if (!backupM3u8 && fallbackM3u8) {
                backupPlayerType = FallbackPlayerType;
                backupM3u8 = fallbackM3u8;
            }
            if (backupM3u8) {
                textStr = backupM3u8;
                if (streamInfo.ActiveBackupPlayerType != backupPlayerType) {
                    streamInfo.ActiveBackupPlayerType = backupPlayerType;
                    console.log(`Blocking${(streamInfo.IsMidroll ? ' midroll ' : ' ')}ads (${backupPlayerType})`);
                }
            }
            // TODO: Improve hevc stripping. It should always strip when there is a codec mismatch (both ways)
            const stripHevc = isHevc && streamInfo.ModifiedM3U8;
            if (IsAdStrippingEnabled || stripHevc) {
                textStr = stripAdSegments(textStr, stripHevc, streamInfo);
            }
            // The backup playlist can carry its own MAF tags
            textStr = cleanServedPlaylist(stripMafAds(textStr, streamInfo), streamInfo);
        } else if (streamInfo.IsShowingAd) {
            console.log('Finished blocking ads');
            streamInfo.IsShowingAd = false;
            streamInfo.IsStrippingAdSegments = false;
            streamInfo.NumStrippedAdSegments = 0;
            streamInfo.ActiveBackupPlayerType = null;
            streamInfo.AdPodInfo = null;
            streamInfo.RequestedAds.clear();
            if (streamInfo.IsUsingModifiedM3U8 || ReloadPlayerAfterAd) {
                streamInfo.IsUsingModifiedM3U8 = false;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            } else {
                postMessage({
                    key: 'PauseResumePlayer'
                });
            }
        }
        const bannerData = {
            key: 'UpdateAdBlockBanner',
            isMidroll: streamInfo.IsMidroll,
            hasAds: streamInfo.IsShowingAd || streamInfo.MafAdInfo != null,
            isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
            numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
            adPodInfo: streamInfo.IsShowingAd ? streamInfo.AdPodInfo : null,
            mafAdInfo: streamInfo.IsShowingAd ? null : streamInfo.MafAdInfo
        };
        // Only post when what the banner shows changes (the countdown runs on the page), plus a refresh every few seconds
        const bannerKey = JSON.stringify([bannerData.isMidroll && bannerData.hasAds, bannerData.hasAds, bannerData.isStrippingAdSegments, bannerData.adPodInfo?.podPosition, bannerData.adPodInfo?.podLength, bannerData.mafAdInfo?.id]);
        if (bannerKey != streamInfo.LastBannerKey || Date.now() - (streamInfo.LastBannerTime || 0) > 5000) {
            streamInfo.LastBannerKey = bannerKey;
            streamInfo.LastBannerTime = Date.now();
            postMessage(bannerData);
        }
        return textStr;
    }
    function parseAttributes(str) {
        return Object.fromEntries(
            str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
            .filter(Boolean)
            .map(x => {
                const idx = x.indexOf('=');
                const key = x.substring(0, idx);
                const value = x.substring(idx + 1);
                const num = Number(value);
                return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num];
            }));
    }
    function getAccessToken(channelName, playerType) {
        const body = {
            operationName: 'PlaybackAccessToken',
            variables: {
                isLive: true,
                login: channelName,
                isVod: false,
                vodID: "",
                playerType: playerType,
                platform: playerType == 'autoplay' ? 'android' : 'web'
            },
            extensions: {
                persistedQuery: {
                    version:1,
                    sha256Hash:"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"
                }
            }
        };
        return gqlRequest(body, playerType);
    }
    function gqlRequest(body, playerType) {
        if (!GQLDeviceID) {
            GQLDeviceID = '';
            const dcharacters = 'abcdefghijklmnopqrstuvwxyz0123456789';
            const dcharactersLength = dcharacters.length;
            for (let i = 0; i < 32; i++) {
                GQLDeviceID += dcharacters.charAt(Math.floor(Math.random() * dcharactersLength));
            }
        }
        let headers = {
            'Client-ID': ClientID,
            'X-Device-Id': GQLDeviceID,
            'Authorization': AuthorizationHeader,
            ...(ClientIntegrityHeader && {'Client-Integrity': ClientIntegrityHeader}),
            ...(ClientVersion && {'Client-Version': ClientVersion}),
            ...(ClientSession && {'Client-Session-Id': ClientSession})
        };
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(2, 15);
            const fetchRequest = {
                id: requestId,
                url: 'https://gql.twitch.tv/gql',
                options: {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers
                }
            };
            // A lost reply would otherwise stall the playlist that is waiting for this token
            const timeout = setTimeout(() => {
                if (pendingFetchRequests.delete(requestId)) {
                    reject(new Error('GQL request timed out'));
                }
            }, GqlRequestTimeout);
            pendingFetchRequests.set(requestId, {
                resolve: (value) => {
                    clearTimeout(timeout);
                    resolve(value);
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    reject(err);
                }
            });
            postMessage({
                key: 'FetchRequest',
                value: fetchRequest
            });
        });
    }
    let playerForMonitoringBuffering = null;
    const playerBufferState = {
        channelName: null,
        hasStreamStarted: false,
        position: 0,
        bufferedPosition: 0,
        bufferDuration: 0,
        numSame: 0,
        lastFixTime: 0,
        isLive: true
    };
    function monitorPlayerBuffering() {
        if (playerForMonitoringBuffering) {
            try {
                const player = playerForMonitoringBuffering.player;
                const state = playerForMonitoringBuffering.state;
                if (!player.core) {
                    playerForMonitoringBuffering = null;
                } else if (state.props?.content?.type === 'live' && !player.isPaused() && !player.getHTMLVideoElement()?.ended && playerBufferState.lastFixTime <= Date.now() - PlayerBufferingMinRepeatDelay && !isActivelyStrippingAds) {
                    const m3u8Url = player.core?.state?.path;
                    if (m3u8Url) {
                      const fileName = new URL(m3u8Url).pathname.split('/').pop();
                      if (fileName?.endsWith('.m3u8')) {
                          const channelName = fileName.slice(0, -5);
                          if (playerBufferState.channelName != channelName) {
                              playerBufferState.channelName = channelName;
                              playerBufferState.hasStreamStarted = false;
                              playerBufferState.numSame = 0;
                          }
                      }
                    }
                    if (player.getState() === 'Playing') {
                        playerBufferState.hasStreamStarted = true;
                    }
                    const position = player.core?.state?.position;
                    const bufferedPosition = player.core?.state?.bufferedPosition;
                    const bufferDuration = player.getBufferDuration();
                    if (position !== undefined && bufferedPosition !== undefined) {
                        // NOTE: This could be improved. It currently lets the player fully eat the full buffer before it triggers pause/play
                        if (playerBufferState.hasStreamStarted &&
                            (!PlayerBufferingPrerollCheckEnabled || position > PlayerBufferingPrerollCheckOffset) &&
                            (playerBufferState.position == position || bufferDuration < PlayerBufferingDangerZone)  &&
                            playerBufferState.bufferedPosition == bufferedPosition &&
                            playerBufferState.bufferDuration >= bufferDuration &&
                            (position != 0 || bufferedPosition != 0 || bufferDuration != 0)
                        ) {
                            playerBufferState.numSame++;
                            if (playerBufferState.numSame == PlayerBufferingSameStateCount) {
                                console.log('Attempt to fix buffering position:' + playerBufferState.position + ' bufferedPosition:' + playerBufferState.bufferedPosition + ' bufferDuration:' + playerBufferState.bufferDuration);
                                const isPausePlay = !PlayerBufferingDoPlayerReload;
                                const isReload = PlayerBufferingDoPlayerReload;
                                doTwitchPlayerTask(isPausePlay, isReload);
                                playerBufferState.lastFixTime = Date.now();
                                playerBufferState.numSame = 0;
                            }
                        } else {
                            playerBufferState.numSame = 0;
                        }
                        playerBufferState.position = position;
                        playerBufferState.bufferedPosition = bufferedPosition;
                        playerBufferState.bufferDuration = bufferDuration;
                    } else {
                        playerBufferState.numSame = 0;
                    }
                }
            } catch (err) {
                console.error('error when monitoring player for buffering: ' + err);
                playerForMonitoringBuffering = null;
            }
        }
        // Walking the React tree is the expensive part, so only do it when the page has a video element
        if (!playerForMonitoringBuffering && document.querySelector('video')) {
            const playerAndState = getPlayerAndState();
            if (playerAndState && playerAndState.player && playerAndState.state) {
                playerForMonitoringBuffering = {
                    player: playerAndState.player,
                    state: playerAndState.state
                };
            }
        }
        const isLive = playerForMonitoringBuffering?.state?.props?.content?.type === 'live';
        if (playerBufferState.isLive && !isLive) {
            updateAdblockBanner({
                hasAds: false
            });
        }
        const becameLive = !playerBufferState.isLive && isLive;
        playerBufferState.isLive = isLive;
        if (becameLive && lastAdBannerData) {
            // The worker only re-sends the banner when it changes, so redraw the last one once the live player is found (e.g. a preroll right after page load)
            updateAdblockBanner(lastAdBannerData);
        }
        // Check less often while there's no player to watch (directory, settings, ...)
        setTimeout(monitorPlayerBuffering, playerForMonitoringBuffering ? PlayerBufferingDelay : PlayerBufferingIdleDelay);
    }
    function updateAdblockBanner(data) {
        // Set even without a player element, otherwise a stale true would keep the buffering fix switched off
        isActivelyStrippingAds = !!data.isStrippingAdSegments;
        const playerRootDiv = document.querySelector('.video-player');
        if (playerRootDiv != null) {
            let adBlockDiv = playerRootDiv.querySelector('.adblock-overlay');
            if (adBlockDiv == null) {
                adBlockDiv = document.createElement('div');
                adBlockDiv.className = 'adblock-overlay';
                adBlockDiv.innerHTML = '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
                adBlockDiv.style.display = 'none';
                adBlockDiv.P = adBlockDiv.querySelector('p');
                playerRootDiv.appendChild(adBlockDiv);
            }
            const isVisible = data.hasAds && playerBufferState.isLive;
            const formatTimeLeft = function(endTime) {
                const secondsLeft = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
                return ` · ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
            };
            const getText = function() {
                const adPodInfo = data.adPodInfo;
                const mafAdInfo = data.mafAdInfo;
                if (mafAdInfo) {
                    return 'Blocking ' + (mafAdInfo.formatName ? mafAdInfo.formatName + ' ad' : 'ads') + formatTimeLeft(mafAdInfo.endTime);
                }
                let adText = '';
                if (adPodInfo) {
                    adText = (adPodInfo.podLength > 1 ? ` · Ad ${adPodInfo.podPosition} of ${adPodInfo.podLength}` : '') + formatTimeLeft(adPodInfo.endTime);
                }
                return 'Blocking' + (data.isMidroll ? ' midroll' : '') + ' ads' + adText + (data.isStrippingAdSegments ? ' (stripping)' : '');
            };
            const renderText = function() {
                if (!adBlockDiv.isConnected) {
                    // The player was replaced: stop ticking for the old banner
                    clearInterval(adBlockDiv.CountdownTimer);
                    adBlockDiv.CountdownTimer = null;
                    return;
                }
                const text = getText();
                if (adBlockDiv.P.textContent !== text) {
                    adBlockDiv.P.textContent = text;
                }
            };
            renderText();
            clearInterval(adBlockDiv.CountdownTimer);
            adBlockDiv.CountdownTimer = isVisible && (data.adPodInfo || data.mafAdInfo) ? setInterval(renderText, 1000) : null;
            adBlockDiv.style.display = isVisible ? 'block' : 'none';
        }
    }
    function getPlayerAndState() {
        function findReactNode(root, constraint) {
            if (root.stateNode && constraint(root.stateNode)) {
                return root.stateNode;
            }
            let node = root.child;
            while (node) {
                const result = findReactNode(node, constraint);
                if (result) {
                    return result;
                }
                node = node.sibling;
            }
            return null;
        }
        function findReactRootNode() {
            let reactRootNode = null;
            const rootNode = document.querySelector('#root');
            if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
                reactRootNode = rootNode._reactRootContainer._internalRoot.current;
            }
            if (reactRootNode == null && rootNode != null) {
                const containerName = Object.keys(rootNode).find(x => x.startsWith('__reactContainer'));
                if (containerName != null) {
                    reactRootNode = rootNode[containerName];
                }
            }
            return reactRootNode;
        }
        const reactRootNode = findReactRootNode();
        if (!reactRootNode) {
            return null;
        }
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        if (player?.playerInstance) {
            player = player.playerInstance;
        }
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        return  {
            player: player,
            state: playerState
        };
    }
    function doTwitchPlayerTask(isPausePlay, isReload) {
        const playerAndState = getPlayerAndState();
        if (!playerAndState) {
            console.log('Could not find react root');
            return;
        }
        const player = playerAndState.player;
        const playerState = playerAndState.state;
        if (!player) {
            console.log('Could not find player');
            return;
        }
        if (!playerState) {
            console.log('Could not find player state');
            return;
        }
        if (player.isPaused() || player.core?.paused) {
            return;
        }
        playerBufferState.lastFixTime = Date.now();
        playerBufferState.numSame = 0;
        if (isPausePlay) {
            player.pause();
            player.play();
            return;
        }
        if (isReload) {
            const lsKeyQuality = 'video-quality';
            const lsKeyMuted = 'video-muted';
            const lsKeyVolume = 'volume';
            let currentQualityLS = null;
            let currentMutedLS = null;
            let currentVolumeLS = null;
            try {
                currentQualityLS = localStorage.getItem(lsKeyQuality);
                currentMutedLS = localStorage.getItem(lsKeyMuted);
                currentVolumeLS = localStorage.getItem(lsKeyVolume);
                if (localStorageHookFailed && player?.core?.state) {
                    localStorage.setItem(lsKeyMuted, JSON.stringify({default:player.core.state.muted}));
                    localStorage.setItem(lsKeyVolume, player.core.state.volume);
                }
                if (localStorageHookFailed && player?.core?.state?.quality?.group) {
                    localStorage.setItem(lsKeyQuality, JSON.stringify({default:player.core.state.quality.group}));
                }
            } catch {}
            playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
            // The reload makes a new media player instance; let the buffering monitor find it again
            playerForMonitoringBuffering = null;
            postTwitchWorkerMessage('TriggeredPlayerReload');
            player.play();
            if (localStorageHookFailed && (currentQualityLS || currentMutedLS || currentVolumeLS)) {
                setTimeout(() => {
                    try {
                        if (currentQualityLS) {
                            localStorage.setItem(lsKeyQuality, currentQualityLS);
                        }
                        if (currentMutedLS) {
                            localStorage.setItem(lsKeyMuted, currentMutedLS);
                        }
                        if (currentVolumeLS) {
                            localStorage.setItem(lsKeyVolume, currentVolumeLS);
                        }
                    } catch {}
                }, 3000);
            }
        }
    }
    function postTwitchWorkerMessage(key, value) {
        twitchWorkers.forEach((worker) => {
            worker.postMessage({key: key, value: value});
        });
    }
    async function handleWorkerFetchRequest(fetchRequest) {
        try {
            const response = await window.realFetch(fetchRequest.url, fetchRequest.options);
            const responseBody = await response.text();
            const responseObject = {
                id: fetchRequest.id,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody
            };
            return responseObject;
        } catch (error) {
            return {
                id: fetchRequest.id,
                error: error.message
            };
        }
    }
    function getAdGqlResponse(operation) {
        // Local "no ad" answers for Twitch's client-side ad queries (they go to gql.twitch.tv, which an ad blocker can't block by host)
        if (operation?.operationName === 'VideoAdRequestDecline') {
            return { data: { adContext: { __typename: 'AdContext', id: 'vaft', radToken: null, declineState: { __typename: 'AdDeclineState', reason: 'vaft', shouldDecline: true } } } };
        }
        if (operation?.operationName === 'FetchAdsService_FetchAds') {
            return { data: { fetchAds: null } };
        }
        return null;
    }
    function shortCircuitAdGqlRequests(realFetch, thisArg, url, init, args) {
        // Returns a response promise when the request held ad queries, otherwise null
        if (!ShortCircuitAdGqlRequests || typeof init?.body !== 'string' || (!init.body.includes('VideoAdRequestDecline') && !init.body.includes('FetchAdsService_FetchAds'))) {
            return null;
        }
        let body;
        try {
            body = JSON.parse(init.body);
        } catch {
            return null;
        }
        const jsonResponse = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (!Array.isArray(body)) {
            const adResponse = getAdGqlResponse(body);
            return adResponse ? Promise.resolve(jsonResponse(adResponse)) : null;
        }
        const adResponses = body.map(getAdGqlResponse);
        if (!adResponses.some(Boolean)) {
            return null;
        }
        const otherOperations = body.filter((operation, index) => !adResponses[index]);
        if (otherOperations.length == 0) {
            return Promise.resolve(jsonResponse(adResponses));
        }
        // Mixed batch: send the other queries and put the local answers back in their places
        return realFetch.call(thisArg, url, { ...init, body: JSON.stringify(otherOperations) }, ...args).then(async (response) => {
            const otherResults = await response.json();
            let next = 0;
            return jsonResponse(adResponses.map(adResponse => adResponse || otherResults[next++]));
        });
    }
    function getHeader(headers, name) {
        if (!headers) {
            return undefined;
        }
        if (typeof headers.get === 'function') {
            return headers.get(name) ?? undefined;
        }
        return headers[name];
    }
    function hookFetch() {
        const realFetch = window.fetch;
        window.realFetch = realFetch;
        window.fetch = function(url, init, ...args) {
            if (typeof url === 'string') {
                if (url.includes('gql.twitch.tv') && init) {
                    let deviceId = getHeader(init.headers, 'X-Device-Id');
                    if (typeof deviceId !== 'string') {
                        deviceId = getHeader(init.headers, 'Device-ID');
                    }
                    if (typeof deviceId === 'string' && GQLDeviceID != deviceId) {
                        GQLDeviceID = deviceId;
                        postTwitchWorkerMessage('UpdateDeviceId', GQLDeviceID);
                    }
                    const clientVersion = getHeader(init.headers, 'Client-Version');
                    if (typeof clientVersion === 'string' && clientVersion !== ClientVersion) {
                        postTwitchWorkerMessage('UpdateClientVersion', ClientVersion = clientVersion);
                    }
                    const clientSession = getHeader(init.headers, 'Client-Session-Id');
                    if (typeof clientSession === 'string' && clientSession !== ClientSession) {
                        postTwitchWorkerMessage('UpdateClientSession', ClientSession = clientSession);
                    }
                    const clientIntegrity = getHeader(init.headers, 'Client-Integrity');
                    if (typeof clientIntegrity === 'string' && clientIntegrity !== ClientIntegrityHeader) {
                        postTwitchWorkerMessage('UpdateClientIntegrityHeader', ClientIntegrityHeader = clientIntegrity);
                    }
                    const authorization = getHeader(init.headers, 'Authorization');
                    if (typeof authorization === 'string' && authorization !== AuthorizationHeader) {
                        postTwitchWorkerMessage('UpdateAuthorizationHeader', AuthorizationHeader = authorization);
                    }
                    const adGqlResponse = shortCircuitAdGqlRequests(realFetch, this, url, init, args);
                    if (adGqlResponse) {
                        return adGqlResponse;
                    }
                    // Get rid of mini player above chat - TODO: Reject this locally instead of having server reject it
                    if (init && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken') && init.body.includes('picture-by-picture')) {
                        init.body = '';
                    }
                    if (ForceAccessTokenPlayerType && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken')) {
                        let replacedPlayerType = '';
                        const newBody = JSON.parse(init.body);
                        if (Array.isArray(newBody)) {
                            for (let i = 0; i < newBody.length; i++) {
                                if (newBody[i]?.variables?.playerType && newBody[i]?.variables?.playerType !== ForceAccessTokenPlayerType) {
                                    replacedPlayerType = newBody[i].variables.playerType;
                                    newBody[i].variables.playerType = ForceAccessTokenPlayerType;
                                }
                            }
                        } else {
                            if (newBody?.variables?.playerType && newBody?.variables?.playerType !== ForceAccessTokenPlayerType) {
                                replacedPlayerType = newBody.variables.playerType;
                                newBody.variables.playerType = ForceAccessTokenPlayerType;
                            }
                        }
                        if (replacedPlayerType) {
                            init.body = JSON.stringify(newBody);
                        }
                    }
                }
            }
            return realFetch.apply(this, arguments);
        };
    }
    function onContentLoaded() {
        // This stops Twitch from pausing the player when in another tab and an ad shows.
        // Taken from https://github.com/saucettv/VideoAdBlockForTwitch/blob/cefce9d2b565769c77e3666ac8234c3acfe20d83/chrome/content.js#L30
        try {
            Object.defineProperty(document, 'visibilityState', {
                get() {
                    return 'visible';
                }
            });
        }catch{}
        let hidden = document.__lookupGetter__('hidden');
        let webkitHidden = document.__lookupGetter__('webkitHidden');
        try {
            Object.defineProperty(document, 'hidden', {
                get() {
                    return false;
                }
            });
        }catch{}
        const block = e => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };
        let wasVideoPlaying = true;
        const visibilityChange = e => {
            const isChrome = typeof chrome !== 'undefined';
            const videos = document.getElementsByTagName('video');
            if (videos.length > 0) {
                if (hidden.apply(document) === true || (webkitHidden && webkitHidden.apply(document) === true)) {
                    wasVideoPlaying = !videos[0].paused && !videos[0].ended;
                } else {
                    if (!playerBufferState.hasStreamStarted) {
                        playerBufferState.hasStreamStarted = true;
                    }
                    if (isChrome && wasVideoPlaying && !videos[0].ended && videos[0].paused && videos[0].muted) {
                        videos[0].play();
                    }
                }
            }
            block(e);
        };
        document.addEventListener('visibilitychange', visibilityChange, true);
        document.addEventListener('webkitvisibilitychange', visibilityChange, true);
        document.addEventListener('mozvisibilitychange', visibilityChange, true);
        document.addEventListener('hasFocus', block, true);
        try {
            if (/Firefox/.test(navigator.userAgent)) {
                Object.defineProperty(document, 'mozHidden', {
                    get() {
                        return false;
                    }
                });
            } else {
                Object.defineProperty(document, 'webkitHidden', {
                    get() {
                        return false;
                    }
                });
            }
        }catch{}
        // Hooks for preserving volume / resolution
        try {
            const keysToCache = [
                'video-quality',
                'video-muted',
                'volume',
                'lowLatencyModeEnabled',// Low Latency
                'persistenceEnabled',// Mini Player
            ];
            const cachedValues = new Map();
            for (let i = 0; i < keysToCache.length; i++) {
                cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
            }
            const realSetItem = localStorage.setItem;
            localStorage.setItem = function(key, value) {
                if (cachedValues.has(key)) {
                    cachedValues.set(key, value);
                }
                realSetItem.apply(this, arguments);
            };
            const realGetItem = localStorage.getItem;
            localStorage.getItem = function(key) {
                if (cachedValues.has(key)) {
                    return cachedValues.get(key);
                }
                return realGetItem.apply(this, arguments);
            };
            if (!localStorage.getItem.toString().includes(Object.keys({cachedValues})[0])) {
                // These hooks are useful to preserve player state on player reload
                // Firefox doesn't allow hooking of localStorage functions but chrome does
                localStorageHookFailed = true;
            }
        } catch (err) {
            console.log('localStorageHooks failed ' + err)
            localStorageHookFailed = true;
        }
    }
    declareOptions(window);
    hookWindowWorker();
    hookFetch();
    if (PlayerBufferingFix) {
        monitorPlayerBuffering();
    }
    if (document.readyState === "complete" || document.readyState === "loaded" || document.readyState === "interactive") {
        onContentLoaded();
    } else {
        window.addEventListener("DOMContentLoaded", function() {
            onContentLoaded();
        });
    }
};

export default vaftTimer;
