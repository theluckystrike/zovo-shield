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

    Popup additions: per-site privacy score card, one-click cookie-banner
    auto-decline, weekly-digest shortcut, and the supporter unlock link.

*/

import { browser, runtime, sendMessage } from './ext.js';
import { dom, qs$ } from './dom.js';
import { i18n$ } from './i18n.js';
import punycode from './punycode.js';

/******************************************************************************/

async function currentTabHostname() {
    const [ tab ] = await browser.tabs.query({ active: true, currentWindow: true });
    if ( tab instanceof Object === false ) { return {}; }
    let url;
    try {
        const strictBlockURL = runtime.getURL('/strictblock.');
        url = new URL(tab.url);
        if ( url.href.startsWith(strictBlockURL) ) {
            url = new URL(url.hash.slice(1));
        }
    } catch {
        return {};
    }
    const isHTTP = url.protocol === 'http:' || url.protocol === 'https:';
    return { tab, url, hostname: isHTTP ? url.hostname : '' };
}

/******************************************************************************/

function renderScoreCard(stats) {
    const card = qs$('#xzov0efe-scorecard');
    if ( card === null ) { return; }
    const gradeEl = qs$('#xzov0efe-grade');
    const detailEl = qs$('#xzov0efe-score-detail');
    const trackersEl = qs$('#xzov0efe-toptrackers');
    if ( stats instanceof Object === false || stats.live !== true ) {
        card.dataset.state = 'unavailable';
        gradeEl.textContent = '–';
        gradeEl.dataset.grade = '';
        detailEl.textContent = i18n$('xzScoreUnavailable') || 'No data yet';
        dom.text(trackersEl, '');
        return;
    }
    card.dataset.state = 'ready';
    gradeEl.textContent = stats.grade;
    gradeEl.dataset.grade = stats.grade.replace('+', 'plus');
    const detail = (i18n$('xzScoreDetail') || '{{seen}} seen · {{blocked}} blocked')
        .replace('{{seen}}', `${stats.seen}`)
        .replace('{{blocked}}', `${stats.blocked}`);
    detailEl.textContent = detail;
    detailEl.setAttribute('title',
        (i18n$('xzScoreDomains') || '{{count}} third-party domains on this site today')
            .replace('{{count}}', `${stats.distinctDomains}`)
    );
    if ( Array.isArray(stats.topTrackers) && stats.topTrackers.length !== 0 ) {
        const parts = stats.topTrackers.map(t =>
            `${t.domain} (${t.count})`
        );
        dom.text(trackersEl, parts.join('  ·  '));
    } else {
        dom.text(trackersEl, '');
    }
}

async function initScoreCard(hostname) {
    if ( typeof hostname !== 'string' || hostname === '' ) {
        // Non-http page (or no tab access): show a friendly empty state
        // rather than hiding the card outright. Also soften two upstream
        // regions that otherwise render as blanks in this state: the
        // hostname header (falls back to the extension name) and the
        // filtering-mode caption (which would show a bare "-").
        const hostSpan = qs$('#hostname > span:first-of-type');
        if ( hostSpan !== null && hostSpan.textContent === '' ) {
            dom.text(hostSpan, i18n$('extName'));
        }
        const modeText = qs$('#filteringModeText');
        if ( modeText !== null ) { modeText.style.display = 'none'; }
        renderScoreCard({ live: false });
        return;
    }
    const stats = await sendMessage({ what: 'zsSiteStats', hostname });
    renderScoreCard(stats);
}

/******************************************************************************/

async function initCookieDecline() {
    const tool = qs$('#xzov0efe-cookiedecline');
    if ( tool === null ) { return; }
    const toggle = tool.querySelector('.xzov0efe-toggle');
    const render = state => {
        toggle.dataset.state = state ? 'on' : 'off';
        toggle.textContent = state
            ? (i18n$('xzToggleOn') || 'On')
            : (i18n$('xzToggleOff') || 'Off');
    };
    const current = await sendMessage({ what: 'zsCookieDeclineGet' });
    render(current?.state === true);
    dom.on(tool, 'click', async ev => {
        if ( ev.isTrusted !== true ) { return; }
        const next = toggle.dataset.state !== 'on';
        render(next);
        const result = await sendMessage({ what: 'zsCookieDeclineSet', state: next });
        render(result?.state === true);
    });
}

/******************************************************************************/

function initDigestShortcut() {
    dom.on('#xzov0efe-gotoDigest', 'click', ev => {
        if ( ev.isTrusted !== true ) { return; }
        sendMessage({
            what: 'gotoURL',
            url: '/dashboard.html?pane=digest',
            type: 'tab',
        });
        self.close();
    });
}

/******************************************************************************/

function initProCta() {
    dom.on('#xzov0efe-gotoPro', 'click', ev => {
        if ( ev.isTrusted !== true ) { return; }
        sendMessage({
            what: 'gotoURL',
            url: '/dashboard.html?pane=pro',
            type: 'tab',
        });
        self.close();
    });
}

/******************************************************************************/

async function init() {
    const { hostname } = await currentTabHostname();
    initScoreCard(hostname);
    initCookieDecline();
    initDigestShortcut();
    initProCta();
}

init().catch(( ) => {
    // The popup must never wedge on extras; upstream UI stays functional.
});

/******************************************************************************/
