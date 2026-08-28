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

    Weekly tracker digest pane: KPIs, per-day bars, per-tracker and
    per-site analytics tables, and week history. All data is local
    (collected by js/xz-stats.js); nothing leaves the device.

*/

import { sendMessage } from './ext.js';
import { dom, qs$ } from './dom.js';
import { i18n$ } from './i18n.js';

/******************************************************************************/

const FREE_HISTORY_WEEKS = 2;

/******************************************************************************/

const text = (selector, value) => {
    const node = qs$(selector);
    if ( node !== null ) { dom.text(node, value); }
};

const el = (tag, className, textContent) => {
    const node = document.createElement(tag);
    if ( className !== undefined ) { node.className = className; }
    if ( textContent !== undefined ) { node.textContent = textContent; }
    return node;
};

/******************************************************************************/

function renderKpis(latest) {
    const host = qs$('#xzov0efe-digest-kpis');
    dom.clear(host);
    const kpis = [
        [ latest.blocked, i18n$('xzDigestKpiBlocked') || 'trackers blocked' ],
        [ latest.seen, i18n$('xzDigestKpiSeen') || 'third-party requests seen' ],
        [ latest.topSites.length, i18n$('xzDigestKpiSites') || 'sites tracked' ],
    ];
    for ( const [ value, label ] of kpis ) {
        const kpi = el('div', 'xzov0efe-kpi');
        kpi.append(
            el('span', 'value', `${value}`),
            el('span', 'label', label),
        );
        host.append(kpi);
    }
}

function renderSeries(latest) {
    const host = qs$('#xzov0efe-digest-series');
    dom.clear(host);
    const total = latest.series.reduce((sum, day) => sum + day.blocked, 0);
    if ( latest.series.length === 0 || total === 0 ) {
        const frame = el('div', 'xzov0efe-emptychart');
        frame.append(
            el('span', 'empty-title',
                i18n$('xzDigestEmptySeriesTitle') || 'Nothing to chart yet'),
            el('span', 'empty-body',
                i18n$('xzDigestEmptySeries') || 'No blocks recorded yet — the chart fills in as you browse.'),
        );
        host.append(frame);
        return;
    }
    const max = Math.max(1, ...latest.series.map(a => a.blocked));
    for ( const day of latest.series ) {
        const row = el('div', 'xzov0efe-bar-row');
        const width = Math.round(day.blocked / max * 100);
        row.append(
            el('span', 'day', day.day.slice(5)),
            el('span', 'bar'),
            el('span', 'count', `${day.blocked}`),
        );
        row.querySelector('.bar').style.width = `${Math.max(width, 1)}%`;
        host.append(row);
    }
}

const emptyTableRow = (table, cols, key, fallback) => {
    const row = el('tr');
    const cell = el('td', 'xzov0efe-note', i18n$(key) || fallback);
    cell.colSpan = cols;
    row.append(cell);
    table.append(row);
};

function renderTrackers(latest) {
    const table = qs$('#xzov0efe-digest-trackers');
    dom.clear(table);
    const head = el('tr');
    head.append(el('th', undefined, i18n$('xzDigestColTracker') || 'Tracker domain'));
    head.append(el('th', 'numeric', i18n$('xzDigestColBlocked') || 'Blocked'));
    table.append(head);
    if ( latest.topTrackers.length === 0 ) {
        emptyTableRow(table, 2, 'xzDigestEmptyTrackers', 'No tracker domains seen yet.');
        return;
    }
    for ( const t of latest.topTrackers ) {
        const row = el('tr');
        row.append(el('td', undefined, t.domain));
        row.append(el('td', 'numeric', `${t.count}`));
        table.append(row);
    }
}

function renderSites(latest) {
    const table = qs$('#xzov0efe-digest-sites');
    dom.clear(table);
    const head = el('tr');
    head.append(el('th', undefined, i18n$('xzDigestColSite') || 'Site'));
    head.append(el('th', 'numeric', i18n$('xzDigestColSeen') || 'Seen'));
    head.append(el('th', 'numeric', i18n$('xzDigestColBlocked') || 'Blocked'));
    head.append(el('th', 'numeric', i18n$('xzDigestColDomains') || 'Tracker domains'));
    table.append(head);
    if ( latest.topSites.length === 0 ) {
        emptyTableRow(table, 4, 'xzDigestEmptySites', 'No per-site data yet.');
        return;
    }
    for ( const s of latest.topSites ) {
        const row = el('tr');
        row.append(el('td', undefined, s.hostname));
        row.append(el('td', 'numeric', `${s.seen}`));
        row.append(el('td', 'numeric', `${s.blocked}`));
        row.append(el('td', 'numeric', `${s.distinctTrackers}`));
        table.append(row);
    }
}

function renderHistory(history, pro) {
    const table = qs$('#xzov0efe-digest-history');
    dom.clear(table);
    const head = el('tr');
    head.append(el('th', undefined, i18n$('xzDigestColWeek') || 'Week'));
    head.append(el('th', 'numeric', i18n$('xzDigestColBlocked') || 'Blocked'));
    head.append(el('th', undefined, i18n$('xzDigestColTopTracker') || 'Top tracker'));
    table.append(head);
    const shown = pro ? history : history.slice(0, FREE_HISTORY_WEEKS);
    for ( const week of shown ) {
        const row = el('tr');
        row.append(el('td', undefined, `${week.weekStart} → ${week.weekEnd}`));
        row.append(el('td', 'numeric', `${week.blocked}`));
        row.append(el('td', undefined, week.topTrackers?.[0]?.domain ?? '—'));
        table.append(row);
    }
    if ( pro === false && history.length > FREE_HISTORY_WEEKS ) {
        const row = el('tr');
        const cell = el('td', undefined,
            (i18n$('xzDigestHistoryLocked') || '{{count}} more weeks with Zovo Shield Pro')
                .replace('{{count}}', `${history.length - FREE_HISTORY_WEEKS}`)
        );
        cell.colSpan = 3;
        row.append(cell);
        table.append(row);
    }
}

/******************************************************************************/

async function renderDigest(regenerate = false) {
    const what = regenerate ? 'zsDigestRegenerate' : 'zsDigestData';
    const [ data, license ] = await Promise.all([
        sendMessage({ what }),
        sendMessage({ what: 'zsLicenseStatus' }),
    ]);
    if ( data instanceof Object === false || data.latest === undefined ) {
        text('#xzov0efe-digest-note',
            i18n$('xzDigestEmpty') || 'No data yet — the digest fills in as you browse.');
        return;
    }
    renderKpis(data.latest);
    renderSeries(data.latest);
    renderTrackers(data.latest);
    renderSites(data.latest);
    renderHistory(data.history ?? [], license?.pro === true);
    text('#xzov0efe-digest-note',
        (i18n$('xzDigestRange') || 'Week of {{start}} → {{end}}')
            .replace('{{start}}', data.latest.weekStart)
            .replace('{{end}}', data.latest.weekEnd)
    );
}

/******************************************************************************/

function init() {
    if ( qs$('#xzov0efe-digest-kpis') === null ) { return; }
    renderDigest();
    dom.on('#xzov0efe-digest-refresh', 'click', ev => {
        if ( ev.isTrusted !== true ) { return; }
        renderDigest(true);
    });
    // Refresh when the pane becomes visible.
    const observer = new MutationObserver(( ) => {
        if ( document.body.dataset.pane === 'digest' ) {
            renderDigest();
        }
    });
    observer.observe(document.body, {
        attributes: true,
        attributeFilter: [ 'data-pane' ],
    });
}

init();

/******************************************************************************/
