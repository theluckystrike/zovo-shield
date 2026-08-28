/*******************************************************************************

    Zovo Shield - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2026-present Zovo

    This file is part of Zovo Shield, a fork of uBlock Origin Lite
    (https://github.com/gorhill/uBlock), and is a modification of the
    upstream project. See ZOVONOTICE.md for the statement of changes.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    ---

    Local-only browsing statistics: per-site third-party request counts
    (observed, never blocked by this module) and per-site blocked-tracker
    counts (from declarativeNetRequest match events). All data stays on
    the user's device in chrome.storage.local, sharded per UTC day and
    pruned after RETENTION_DAYS. Nothing is transmitted anywhere.

*/

import {
    browser,
    localKeys,
    localRead,
    localRemove,
    localWrite,
} from './ext.js';

import { dnr } from './ext-compat.js';
import { ubolErr } from './debug.js';

/******************************************************************************/

const NS = 'xzov0efe';
const DAY_PREFIX = `${NS}.stats.`;
const DIGEST_LATEST_KEY = `${NS}.digest.latest`;
const DIGEST_HISTORY_KEY = `${NS}.digest.history`;

const RETENTION_DAYS = 14;
const DIGEST_WINDOW_DAYS = 7;
const DIGEST_HISTORY_MAX = 52;

const MAX_SITES_PER_DAY = 200;
const MAX_DOMAINS_PER_SITE = 12;
const MAX_TRACKERS_PER_DAY = 60;
const OTHER_DOMAIN = '(other)';

const FLUSH_EVENT_THRESHOLD = 25;
const HOUSEKEEP_ALARM = `${NS}.housekeep`;
const HOUSEKEEP_PERIOD_MIN = 15;

const COUNTED_TYPES = new Set([
    'csp_report', 'font', 'image', 'imageset', 'media', 'object',
    'other', 'ping', 'script', 'stylesheet', 'sub_frame', 'web_manifest',
    'websocket', 'xmlhttprequest',
]);

// Common multi-label public suffixes; good enough for a third-party
// heuristic without shipping a full public-suffix list.
const SECOND_LEVEL_TLDS = new Set([
    'ac', 'co', 'com', 'edu', 'gov', 'net', 'org',
]);

/******************************************************************************/

const dayString = ( ) => {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = `${now.getUTCMonth()+1}`.padStart(2, '0');
    const d = `${now.getUTCDate()}`.padStart(2, '0');
    return `${y}-${m}-${d}`;
};

const dayShardKey = day => `${DAY_PREFIX}${day}`;

const hostnameFromURL = url => {
    try {
        return (new URL(url)).hostname;
    } catch {
        return '';
    }
};

// Approximate registrable domain: last two labels, or last three when the
// second-to-last label is a known second-level tld (co.uk style).
const baseDomain = hostname => {
    if ( hostname === '' ) { return ''; }
    const labels = hostname.split('.');
    if ( labels.length <= 2 ) { return hostname; }
    const tld = labels.at(-1);
    const sld = labels.at(-2);
    if ( SECOND_LEVEL_TLDS.has(sld) && tld.length === 2 && labels.length >= 3 ) {
        return labels.slice(-3).join('.');
    }
    return labels.slice(-2).join('.');
};

const isThirdParty = (requestHostname, siteHostname) => {
    if ( requestHostname === '' || siteHostname === '' ) { return false; }
    if ( requestHostname === siteHostname ) { return false; }
    return baseDomain(requestHostname) !== baseDomain(siteHostname);
};

/******************************************************************************/

// In-memory accumulator for the current UTC day. Flushed to a per-day
// storage shard. The service worker can be evicted at any time; listeners
// are registered at module evaluation so the browser wakes us on events,
// and unflushed counts are at most FLUSH_EVENT_THRESHOLD events stale.

const mem = {
    day: '',
    sites: new Map(),     // hostname => { s, b, tp: Map, bt: Map }
    trackers: new Map(),  // tracker domain => blocked count
    seen: 0,
    blocked: 0,
    pendingEvents: 0,
    flushTimer: undefined,
};

const tabSiteCache = new Map(); // tabId => { hostname, at }

const resetMemForToday = ( ) => {
    mem.day = dayString();
    mem.sites.clear();
    mem.trackers.clear();
    mem.seen = 0;
    mem.blocked = 0;
    mem.pendingEvents = 0;
};

const siteEntry = hostname => {
    let entry = mem.sites.get(hostname);
    if ( entry === undefined ) {
        if ( mem.sites.size >= MAX_SITES_PER_DAY ) {
            // Evict the least active site to keep the shard bounded.
            let minKey, minCount = Infinity;
            for ( const [ k, v ] of mem.sites ) {
                const count = v.s + v.b;
                if ( count < minCount ) { minCount = count; minKey = k; }
            }
            if ( minKey !== undefined ) { mem.sites.delete(minKey); }
        }
        entry = { s: 0, b: 0, tp: new Map(), bt: new Map() };
        mem.sites.set(hostname, entry);
    }
    return entry;
};

const bumpDomainMap = (map, domain) => {
    if ( domain === '' ) { return; }
    if ( map.has(domain) === false && map.size >= MAX_DOMAINS_PER_SITE ) {
        domain = OTHER_DOMAIN;
    }
    map.set(domain, (map.get(domain) ?? 0) + 1);
};

const bumpGlobalTracker = domain => {
    if ( domain === '' ) { return; }
    if ( mem.trackers.has(domain) === false &&
         mem.trackers.size >= MAX_TRACKERS_PER_DAY ) {
        domain = OTHER_DOMAIN;
    }
    mem.trackers.set(domain, (mem.trackers.get(domain) ?? 0) + 1);
};

/******************************************************************************/

const siteFromTabId = async tabId => {
    if ( typeof tabId !== 'number' || tabId < 0 ) { return ''; }
    const cached = tabSiteCache.get(tabId);
    if ( cached && Date.now() - cached.at < 60 * 1000 ) {
        return cached.hostname;
    }
    const tab = await browser.tabs.get(tabId).catch(( ) => undefined);
    const hostname = hostnameFromURL(tab?.url ?? '');
    if ( hostname !== '' ) {
        tabSiteCache.set(tabId, { hostname, at: Date.now() });
        if ( tabSiteCache.size > 500 ) {
            tabSiteCache.delete(tabSiteCache.keys().next().value);
        }
    }
    return hostname;
};

const recordSeen = (siteHostname, requestHostname) => {
    if ( siteHostname === '' ) { return; }
    if ( mem.day !== dayString() ) { resetMemForToday(); }
    const entry = siteEntry(siteHostname);
    entry.s += 1;
    mem.seen += 1;
    bumpDomainMap(entry.tp, baseDomain(requestHostname));
    mem.pendingEvents += 1;
};

const recordBlocked = (siteHostname, requestHostname) => {
    if ( siteHostname === '' ) { return; }
    if ( mem.day !== dayString() ) { resetMemForToday(); }
    const entry = siteEntry(siteHostname);
    entry.b += 1;
    mem.blocked += 1;
    const trackerDomain = baseDomain(requestHostname);
    bumpDomainMap(entry.bt, trackerDomain);
    bumpGlobalTracker(trackerDomain);
    mem.pendingEvents += 1;
};

/******************************************************************************/

const mergeDomainMaps = (target, source) => {
    for ( const [ domain, count ] of source ) {
        target[domain] = (target[domain] ?? 0) + count;
    }
};

const serializeMem = ( ) => {
    const sites = {};
    for ( const [ hostname, entry ] of mem.sites ) {
        sites[hostname] = {
            s: entry.s,
            b: entry.b,
            tp: Object.fromEntries(entry.tp),
            bt: Object.fromEntries(entry.bt),
        };
    }
    return {
        v: 1,
        day: mem.day,
        seen: mem.seen,
        blocked: mem.blocked,
        sites,
        trackers: Object.fromEntries(mem.trackers),
    };
};

const flushStats = async ( ) => {
    if ( mem.flushTimer !== undefined ) {
        self.clearTimeout(mem.flushTimer);
        mem.flushTimer = undefined;
    }
    if ( mem.pendingEvents === 0 ) { return; }
    mem.pendingEvents = 0;
    if ( mem.day === '' ) { return; }
    const key = dayShardKey(mem.day);
    try {
        const before = await localRead(key);
        const current = serializeMem();
        if ( before instanceof Object && before.day === current.day ) {
            current.seen += before.seen ?? 0;
            current.blocked += before.blocked ?? 0;
            for ( const [ hostname, entry ] of Object.entries(before.sites ?? {}) ) {
                const existing = current.sites[hostname];
                if ( existing === undefined ) {
                    current.sites[hostname] = entry;
                } else {
                    existing.s += entry.s ?? 0;
                    existing.b += entry.b ?? 0;
                    mergeDomainMaps(existing.tp, Object.entries(entry.tp ?? {}));
                    mergeDomainMaps(existing.bt, Object.entries(entry.bt ?? {}));
                }
            }
            mergeDomainMaps(current.trackers, Object.entries(before.trackers ?? {}));
        }
        await localWrite(key, current);
    } catch (reason) {
        ubolErr(`flushStats/${reason}`);
    }
};

const scheduleFlush = ( ) => {
    if ( mem.pendingEvents < FLUSH_EVENT_THRESHOLD ) { return; }
    if ( mem.flushTimer !== undefined ) { return; }
    mem.flushTimer = self.setTimeout(( ) => {
        mem.flushTimer = undefined;
        flushStats();
    }, 4000);
};

/******************************************************************************/

const pruneOldShards = async ( ) => {
    const keys = await localKeys();
    if ( Array.isArray(keys) === false ) { return; }
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400 * 1000);
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    const stale = keys.filter(k =>
        k.startsWith(DAY_PREFIX) && k.slice(DAY_PREFIX.length) < cutoffDay
    );
    if ( stale.length === 0 ) { return; }
    return localRemove(stale);
};

/******************************************************************************/

// Observed (never blocked by us) third-party request counting.

const onObservedRequest = details => {
    const { tabId, url, initiator, type, frameId } = details;
    if ( COUNTED_TYPES.has(type) === false ) { return; }
    const requestHostname = hostnameFromURL(url);
    if ( requestHostname === '' ) { return; }
    if ( frameId === 0 && type === 'sub_frame' ) { return; }
    const done = siteHostname => {
        if ( isThirdParty(requestHostname, siteHostname) === false ) { return; }
        recordSeen(siteHostname, requestHostname);
        scheduleFlush();
    };
    if ( typeof initiator === 'string' && initiator !== '' ) {
        done(hostnameFromURL(`${initiator}/`));
    } else {
        siteFromTabId(tabId).then(done);
    }
};

// Blocked-request counting from DNR match events.

const onMatchedRule = info => {
    const { request } = info ?? {};
    if ( request instanceof Object === false ) { return; }
    const requestHostname = hostnameFromURL(request.url ?? '');
    if ( requestHostname === '' ) { return; }
    const done = siteHostname => {
        if ( siteHostname === '' ) { return; }
        if ( isThirdParty(requestHostname, siteHostname) === false ) {
            // First-party blocks (strict-block, popup rules) still count.
            recordBlocked(siteHostname, requestHostname);
            scheduleFlush();
            return;
        }
        recordBlocked(siteHostname, requestHostname);
        scheduleFlush();
    };
    if ( typeof request.initiator === 'string' && request.initiator !== '' ) {
        done(hostnameFromURL(`${request.initiator}/`));
    } else {
        siteFromTabId(request.tabId).then(done);
    }
};

let listenersAttached = false;

const attachListeners = ( ) => {
    if ( listenersAttached ) { return; }
    listenersAttached = true;
    if ( browser.webRequest?.onBeforeRequest instanceof Object ) {
        browser.webRequest.onBeforeRequest.addListener(
            onObservedRequest,
            { urls: [ 'http://*/*', 'https://*/*' ] }
        );
    }
    if ( dnr.onRuleMatchedDebug instanceof Object ) {
        try {
            dnr.onRuleMatchedDebug.addListener(onMatchedRule);
        } catch (reason) {
            ubolErr(`onRuleMatchedDebug/${reason}`);
        }
    }
};

// Register listeners at module evaluation time so the browser wakes the
// service worker for these events.
attachListeners();

/******************************************************************************/

const mergeShardsIntoSite = (shards, hostname) => {
    let seen = 0;
    let blocked = 0;
    const trackers = new Map();
    for ( const shard of shards ) {
        const entry = shard?.sites?.[hostname];
        if ( entry === undefined ) { continue; }
        seen += entry.s ?? 0;
        blocked += entry.b ?? 0;
        for ( const [ domain, count ] of Object.entries(entry.bt ?? {}) ) {
            trackers.set(domain, (trackers.get(domain) ?? 0) + count);
        }
        for ( const [ domain, count ] of Object.entries(entry.tp ?? {}) ) {
            if ( (entry.bt ?? {})[domain] === undefined ) {
                trackers.set(domain, (trackers.get(domain) ?? 0) + 0);
            }
        }
    }
    return { seen, blocked, trackers };
};

const GRADES = [
    [ 0, 'A+' ], [ 2, 'A' ], [ 5, 'B' ], [ 9, 'C' ], [ 15, 'D' ],
];

const gradeFromDomainCount = count => {
    let grade = 'F';
    for ( const [ max, letter ] of GRADES ) {
        if ( count <= max ) { grade = letter; break; }
    }
    return grade;
};

export async function getSiteStats(hostname) {
    if ( typeof hostname !== 'string' || hostname === '' ) { return; }
    const today = dayString();
    const shards = [];
    const stored = await localRead(dayShardKey(today));
    if ( stored instanceof Object ) { shards.push(stored); }
    if ( mem.day === today && mem.pendingEvents !== 0 ) {
        shards.push(serializeMem());
    } else if ( mem.day === today ) {
        shards.push(serializeMem());
    }
    const { seen, blocked, trackers } = mergeShardsIntoSite(shards, hostname);
    const distinct = trackers.size;
    const topTrackers = Array.from(trackers.entries())
        .filter(([ domain ]) => domain !== OTHER_DOMAIN)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([ domain, count ]) => ({ domain, count }));
    return {
        hostname,
        seen,
        blocked,
        distinctDomains: distinct,
        grade: gradeFromDomainCount(distinct),
        topTrackers,
        live: listenersAttached,
    };
}

/******************************************************************************/

const recentDays = count => {
    const days = [];
    const now = Date.now();
    for ( let i = 0; i < count; i++ ) {
        days.push((new Date(now - i * 86400 * 1000)).toISOString().slice(0, 10));
    }
    return days;
};

const readDayShards = async days => {
    const shards = await Promise.all(days.map(day => localRead(dayShardKey(day))));
    // Fold in unflushed in-memory counts for today.
    const today = dayString();
    if ( mem.day === today && days.includes(today) ) {
        const serialized = serializeMem();
        const i = days.indexOf(today);
        if ( shards[i] instanceof Object ) {
            const merged = shards[i];
            merged.seen += serialized.seen;
            merged.blocked += serialized.blocked;
            for ( const [ hn, entry ] of Object.entries(serialized.sites) ) {
                const existing = merged.sites[hn];
                if ( existing === undefined ) {
                    merged.sites[hn] = entry;
                } else {
                    existing.s += entry.s;
                    existing.b += entry.b;
                    mergeDomainMaps(existing.tp, Object.entries(entry.tp));
                    mergeDomainMaps(existing.bt, Object.entries(entry.bt));
                }
            }
            mergeDomainMaps(merged.trackers, Object.entries(serialized.trackers));
        } else {
            shards[i] = serialized;
        }
    }
    return shards.filter(shard => shard instanceof Object);
};

const aggregateDigest = (days, shards) => {
    let seen = 0;
    let blocked = 0;
    const sites = new Map();
    const trackers = new Map();
    const series = [];
    for ( const shard of shards ) {
        seen += shard.seen ?? 0;
        blocked += shard.blocked ?? 0;
        series.push({
            day: shard.day,
            seen: shard.seen ?? 0,
            blocked: shard.blocked ?? 0,
        });
        for ( const [ hn, entry ] of Object.entries(shard.sites ?? {}) ) {
            const site = sites.get(hn) ?? { s: 0, b: 0, t: new Map() };
            site.s += entry.s ?? 0;
            site.b += entry.b ?? 0;
            for ( const [ domain, count ] of Object.entries(entry.bt ?? {}) ) {
                site.t.set(domain, (site.t.get(domain) ?? 0) + count);
            }
            sites.set(hn, site);
        }
        for ( const [ domain, count ] of Object.entries(shard.trackers ?? {}) ) {
            trackers.set(domain, (trackers.get(domain) ?? 0) + count);
        }
    }
    const topSites = Array.from(sites.entries())
        .map(([ hostname, v ]) => ({
            hostname,
            seen: v.s,
            blocked: v.b,
            distinctTrackers: v.t.size,
        }))
        .sort((a, b) => b.blocked - a.blocked || b.seen - a.seen)
        .slice(0, 25);
    const topTrackers = Array.from(trackers.entries())
        .filter(([ domain ]) => domain !== OTHER_DOMAIN)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([ domain, count ]) => ({ domain, count }));
    series.sort((a, b) => a.day < b.day ? -1 : 1);
    return {
        weekStart: days.at(-1),
        weekEnd: days[0],
        generatedAt: Date.now(),
        seen,
        blocked,
        topSites,
        topTrackers,
        series,
    };
};

export async function getDigestData(regenerate = false) {
    if ( regenerate === false ) {
        const latest = await localRead(DIGEST_LATEST_KEY);
        if ( latest instanceof Object ) {
            const age = Date.now() - (latest.generatedAt ?? 0);
            if ( age < DIGEST_WINDOW_DAYS * 86400 * 1000 ) {
                const history = await localRead(DIGEST_HISTORY_KEY);
                return { latest, history: Array.isArray(history) ? history : [] };
            }
        }
    }
    const days = recentDays(DIGEST_WINDOW_DAYS);
    const shards = await readDayShards(days);
    const latest = aggregateDigest(days, shards);
    await localWrite(DIGEST_LATEST_KEY, latest);
    const before = await localRead(DIGEST_HISTORY_KEY);
    const history = Array.isArray(before) ? before : [];
    if ( history.length === 0 || history[0].weekStart !== latest.weekStart ) {
        history.unshift({
            weekStart: latest.weekStart,
            weekEnd: latest.weekEnd,
            seen: latest.seen,
            blocked: latest.blocked,
            topTrackers: latest.topTrackers.slice(0, 5),
        });
        history.length = Math.min(history.length, DIGEST_HISTORY_MAX);
        await localWrite(DIGEST_HISTORY_KEY, history);
    }
    return { latest, history };
}

/******************************************************************************/

export async function weeklyDigestDue() {
    const digest = await getDigestData(true);
    const { latest } = digest;
    if ( browser.notifications?.create instanceof Function === false ) {
        return;
    }
    if ( latest.blocked === 0 && latest.seen === 0 ) { return; }
    const title = 'Your weekly privacy digest is ready';
    const message = `${latest.blocked.toLocaleString()} trackers blocked across ` +
        `${latest.topSites.length} sites this week. Tap to review.`;
    await browser.notifications.create(`${NS}-digest`, {
        type: 'basic',
        iconUrl: '/img/icon_128.png',
        title,
        message,
        priority: 0,
    }).catch(reason => {
        ubolErr(`notifications/${reason}`);
    });
}

export function initStatsNotifications(gotoURL) {
    if ( browser.notifications?.onClicked instanceof Object === false ) { return; }
    browser.notifications.onClicked.addListener(notificationId => {
        if ( notificationId !== `${NS}-digest` ) { return; }
        browser.notifications.clear(notificationId);
        gotoURL('/dashboard.html?pane=digest', 'tab');
    });
}

/******************************************************************************/

export async function housekeeping() {
    await flushStats();
    await pruneOldShards();
}

export function initStatsHousekeeping(onMessage) {
    browser.alarms.onAlarm.addListener(alarm => {
        if ( alarm.name !== HOUSEKEEP_ALARM ) { return; }
        housekeeping();
    });
    browser.alarms.get(HOUSEKEEP_ALARM).then(existing => {
        if ( existing !== undefined ) { return; }
        browser.alarms.create(HOUSEKEEP_ALARM, {
            periodInMinutes: HOUSEKEEP_PERIOD_MIN,
        });
    });
    // Register the weekly digest as a deferred job, re-armed every firing.
    return localRead('deferredJobs').then(jobs => {
        if ( Array.isArray(jobs) && jobs.some(a => a.name === 'zsWeeklyDigestDue') ) {
            return;
        }
        onMessage({ what: 'zsRearmWeeklyDigest' });
    });
}

export async function rearmWeeklyDigest(registerJob) {
    const next = Date.now() + DIGEST_WINDOW_DAYS * 86400 * 1000;
    return registerJob('zsWeeklyDigestDue', next);
}

/******************************************************************************/
