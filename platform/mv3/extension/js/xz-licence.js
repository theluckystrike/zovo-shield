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

    Optional supporter unlock (licence layer 5.95).

    The filtering core is NEVER gated by this module; it only unlocks
    convenience extras. As required by the GPL, anyone may rebuild this
    source without the supporter check.

    Rules (fleet doctrine):
    - Keys are shape-checked against ZOVO-XXXX-XXXX-XXXX-XXXX before any
      network call; the server is the sole authority on authenticity.
    - A grant happens ONLY on a server response of { valid: true }.
      The returned tier is stored for display but is NEVER a grant
      condition (gating on tier === 'pro' once locked out lifetime
      buyers; do not reintroduce tier checks here).
    - The Supabase anon key below is a publishable, RLS-scoped key and
      is safe to ship; it is hardcoded inline on purpose (placeholder
      injection historically shipped unsubstituted and silently killed
      the paid tier). Privileged keys are banned fleet-wide.

*/

import {
    browser,
    localRead,
    localRemove,
    localWrite,
} from './ext.js';

import { ubolErr } from './debug.js';

/******************************************************************************/

export const PRO_KEY_PATTERN = /^ZOVO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i;
export const SUPABASE_ANON_KEY = 'sb_publishable_RG4IVO9Qm23_xPzdQjdFPQ_QHBwbOLv';
export const LICENSE_VERIFY_URL = 'https://zgubxqomnbmxgbdhvwja.supabase.co/functions/v1/verify-extension-license';
export const EXTENSION_KEY = 'shield';

const CACHE_KEY = 'xzov0efe.license';
const RL_KEY = 'xzov0efe.license.rl';
const VERIFY_TTL = 30 * 60 * 1000;
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 10 * 1000;
const RL_MAX = 6;
const RL_WINDOW = 60 * 1000;
const LICENSE_ALARM = 'xzov0efe.license.reverify';

/******************************************************************************/

const readCache = ( ) =>
    localRead(CACHE_KEY).then(cache =>
        cache instanceof Object &&
        typeof cache.key === 'string' &&
        cache.valid === true &&
        typeof cache.verifiedAt === 'number'
            ? cache
            : undefined
    );

const rateOk = async ( ) => {
    const hits = await localRead(RL_KEY);
    const now = Date.now();
    const recent = (Array.isArray(hits) ? hits : []).filter(t => now - t < RL_WINDOW);
    if ( recent.length >= RL_MAX ) { return false; }
    recent.push(now);
    await localWrite(RL_KEY, recent);
    return true;
};

/******************************************************************************/

async function verifyWithServer(key) {
    if ( LICENSE_VERIFY_URL.startsWith('https://') === false ) {
        return { ok: false, reason: 'insecure' };
    }
    if ( await rateOk() === false ) {
        return { ok: false, reason: 'rate-limited' };
    }
    const controller = new AbortController();
    const timer = self.setTimeout(( ) => controller.abort(), REQUEST_TIMEOUT);
    try {
        const response = await fetch(LICENSE_VERIFY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'apikey': SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ license_key: key, extension: EXTENSION_KEY }),
            signal: controller.signal,
        });
        if ( response.ok === false ) {
            return { ok: false, reason: `http-${response.status}` };
        }
        const data = await response.json().catch(( ) => undefined);
        if ( data instanceof Object === false || typeof data.valid !== 'boolean' ) {
            return { ok: false, reason: 'bad-schema' };
        }
        // Grant on valid:true ONLY. Tier is informational, never a condition.
        if ( data.valid !== true ) {
            return { ok: false, reason: 'invalid-key' };
        }
        const cache = {
            key,
            valid: true,
            tier: typeof data.tier === 'string' ? data.tier : 'pro',
            verifiedAt: Date.now(),
        };
        await localWrite(CACHE_KEY, cache);
        return { ok: true, tier: cache.tier };
    } catch (error) {
        const reason = error?.name === 'AbortError' ? 'timeout' : 'network';
        return { ok: false, reason };
    } finally {
        self.clearTimeout(timer);
    }
}

/******************************************************************************/

export async function getLicenseStatus() {
    const cache = await readCache();
    if ( cache === undefined ) { return { pro: false }; }
    if ( Date.now() - cache.verifiedAt > GRACE_MS ) {
        return { pro: false };
    }
    if ( Date.now() - cache.verifiedAt > VERIFY_TTL ) {
        // Refresh opportunistically; an offline failure keeps the grant
        // until the grace window expires.
        verifyWithServer(cache.key).then(result => {
            if ( result.ok === false && result.reason !== 'timeout' &&
                 result.reason !== 'network' && result.reason !== 'rate-limited' ) {
                return localRemove(CACHE_KEY);
            }
        }).catch(( ) => {
        });
    }
    return {
        pro: true,
        tier: cache.tier,
        keyTail: cache.key.slice(-4),
        verifiedAt: cache.verifiedAt,
    };
}

export async function applyLicenseKey(rawKey) {
    const key = `${rawKey ?? ''}`.trim().toUpperCase();
    if ( PRO_KEY_PATTERN.test(key) === false ) {
        return { ok: false, reason: 'invalid-format' };
    }
    const result = await verifyWithServer(key);
    if ( result.ok !== true ) { return result; }
    return { ok: true, tier: result.tier };
}

export async function clearLicense() {
    return localRemove(CACHE_KEY);
}

/******************************************************************************/

export function registerLicenseAlarm() {
    if ( browser.alarms?.create instanceof Function === false ) { return; }
    browser.alarms.onAlarm.addListener(alarm => {
        if ( alarm.name !== LICENSE_ALARM ) { return; }
        readCache().then(cache => {
            if ( cache === undefined ) { return; }
            verifyWithServer(cache.key).then(result => {
                if ( result.ok === false && result.reason !== 'timeout' &&
                     result.reason !== 'network' && result.reason !== 'rate-limited' ) {
                    return localRemove(CACHE_KEY);
                }
            }).catch(reason => {
                ubolErr(`licenseReverify/${reason}`);
            });
        });
    });
    browser.alarms.get(LICENSE_ALARM).then(existing => {
        if ( existing !== undefined ) { return; }
        browser.alarms.create(LICENSE_ALARM, { periodInMinutes: 720 });
    });
}

/******************************************************************************/
