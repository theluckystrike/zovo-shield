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

    Zap library pane: curated cosmetic-filter preset packs layered on the
    upstream element zapper storage (site.<hostname> custom filters), plus
    JSON export/import of the user's own zap rules. Applying a pack writes
    ordinary custom filters through the same background endpoints the
    picker uses, so presets behave exactly like hand-zapped rules.

*/

import {
    localRead,
    localWrite,
    runtime,
    sendMessage,
} from './ext.js';

import { dom, qs$ } from './dom.js';
import { faIconsInit } from './fa-icons.js';
import { i18n$ } from './i18n.js';

/******************************************************************************/

const APPLIED_KEY = 'xzov0efe.presets.applied';
const PRO_URL = 'https://zovo.one/pricing?utm_source=zovo-shield&utm_medium=extension&utm_campaign=upgrade&utm_content=zaplib';

/******************************************************************************/

const el = (tag, className, textContent) => {
    const node = document.createElement(tag);
    if ( className !== undefined ) { node.className = className; }
    if ( textContent !== undefined ) { node.textContent = textContent; }
    return node;
};

const readApplied = ( ) =>
    localRead(APPLIED_KEY).then(v => v instanceof Object ? v : {});

/******************************************************************************/

async function applyPack(pack) {
    const entries = Object.entries(pack.sites);
    await sendMessage({ what: 'addManyCustomFilters', entries });
    const applied = await readApplied();
    applied[pack.id] = Object.fromEntries(entries);
    await localWrite(APPLIED_KEY, applied);
}

async function removePack(pack) {
    const applied = await readApplied();
    const sites = applied[pack.id];
    if ( sites instanceof Object === false ) { return; }
    for ( const [ hostname, selectors ] of Object.entries(sites) ) {
        await sendMessage({ what: 'removeCustomFilters', hostname, selectors });
    }
    delete applied[pack.id];
    await localWrite(APPLIED_KEY, applied);
}

/******************************************************************************/

function packCard(pack, state) {
    const card = el('div', 'xzov0efe-pack');
    const head = el('div', 'pack-head');
    head.append(el('span', 'pack-name', pack.name));
    if ( pack.pro ) {
        head.append(el('span', 'xzov0efe-badge-pro', 'Pro'));
    }
    head.append(el('span', 'pack-sites',
        (i18n$('xzZapSiteCount') || '{{count}} sites')
            .replace('{{count}}', `${Object.keys(pack.sites).length}`)
    ));
    card.append(head);
    card.append(el('p', 'pack-desc', pack.desc));
    const actions = el('div', 'pack-actions');
    if ( pack.pro && state.pro !== true ) {
        // Locked Pro pack: a quiet inline affordance, not a full button —
        // a column of identical gray buttons reads as disabled controls.
        // The single gold action lives in the upsell row below the list.
        const locked = el('span', 'xzov0efe-prolock');
        locked.append(
            el('span', 'fa-icon', 'unlock-alt'),
            el('span', undefined,
                i18n$('xzZapLocked') || 'Included with Pro'),
        );
        actions.append(locked);
    } else if ( state.applied[pack.id] !== undefined ) {
        const remove = el('button', 'iconified dontshrink');
        remove.append(
            el('span', 'fa-icon', 'trash-o'),
            el('span', undefined, i18n$('xzZapRemove') || 'Remove pack'),
            el('span', 'hover'),
        );
        remove.addEventListener('click', async ( ) => {
            await removePack(pack);
            render();
        });
        actions.append(remove);
        actions.append(el('span', 'pack-applied',
            `✓ ${i18n$('xzZapApplied') || 'applied'}`));
    } else {
        const apply = el('button', 'iconified dontshrink preferred');
        apply.append(
            el('span', 'fa-icon', 'bolt'),
            el('span', undefined, i18n$('xzZapApply') || 'Apply pack'),
            el('span', 'hover'),
        );
        apply.addEventListener('click', async ( ) => {
            await applyPack(pack);
            render();
        });
        actions.append(apply);
    }
    card.append(actions);
    return card;
}

/******************************************************************************/

async function render() {
    const host = qs$('#xzov0efe-packlist');
    if ( host === null ) { return; }
    const [ response, applied, license ] = await Promise.all([
        fetch(runtime.getURL('/xzov0efe-presets.json')).catch(( ) => undefined),
        readApplied(),
        sendMessage({ what: 'zsLicenseStatus' }),
    ]);
    if ( response === undefined || response.ok === false ) {
        dom.text(host, i18n$('xzZapLoadError') || 'Could not load preset packs.');
        return;
    }
    const data = await response.json().catch(( ) => undefined);
    if ( data instanceof Object === false ) { return; }
    const state = { applied, pro: license?.pro === true };
    dom.clear(host);
    const free = data.packs.filter(p => p.pro !== true);
    const pro = data.packs.filter(p => p.pro === true);
    for ( const pack of [ ...free, ...pro ] ) {
        host.append(packCard(pack, state));
    }
    // One upsell row for the whole Pro section: the pane's single gold
    // action, instead of a gray "Unlock" button repeated per pack.
    if ( state.pro !== true && pro.length !== 0 ) {
        const upsell = el('div', 'xzov0efe-upsell');
        upsell.append(el('span', 'upsell-note',
            (i18n$('xzZapUpsellNote') || '{{count}} preset packs included with Pro')
                .replace('{{count}}', `${pro.length}`)
        ));
        const cta = el('button', 'xzov0efe-goldbtn iconified dontshrink');
        cta.append(
            el('span', 'fa-icon', 'unlock-alt'),
            el('span', undefined, i18n$('xzZapUpgrade') || 'Unlock with Pro'),
            el('span', 'hover'),
        );
        cta.addEventListener('click', ( ) => {
            sendMessage({ what: 'gotoURL', url: PRO_URL, type: 'tab' });
        });
        upsell.append(cta);
        host.append(upsell);
    }
    // Pack cards are created after the document-level icon pass ran, so
    // substitute their .fa-icon glyphs explicitly.
    faIconsInit(host);
}

/******************************************************************************/

function statusLine(message) {
    const node = qs$('#xzov0efe-zapIoStatus');
    if ( node !== null ) { dom.text(node, message); }
}

async function exportZapRules() {
    const all = await sendMessage({ what: 'getAllCustomFilters' });
    if ( Array.isArray(all) === false ) {
        statusLine(i18n$('xzZapExportEmpty') || 'No zap rules to export yet.');
        return;
    }
    const payload = {
        format: 'xzov0efe-zaps-v1',
        version: 1,
        exportedAt: (new Date()).toISOString(),
        rules: Object.fromEntries(all),
    };
    const blob = new Blob([ JSON.stringify(payload, null, 2) ], {
        type: 'application/json',
    });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'zovo-shield-zap-rules.json';
    a.click();
    self.setTimeout(( ) => URL.revokeObjectURL(a.href), 10 * 1000);
    statusLine(
        (i18n$('xzZapExported') || 'Exported {{count}} site rule sets.')
            .replace('{{count}}', `${all.length}`)
    );
}

async function importZapRules(file) {
    const text = await file.text();
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        statusLine(i18n$('xzZapImportBad') || 'Not a valid zap-rules file.');
        return;
    }
    if ( payload?.format !== 'xzov0efe-zaps-v1' ||
         payload.rules instanceof Object === false ) {
        statusLine(i18n$('xzZapImportBad') || 'Not a valid zap-rules file.');
        return;
    }
    const entries = Object.entries(payload.rules).filter(([ hostname, selectors ]) =>
        typeof hostname === 'string' && hostname !== '' &&
        Array.isArray(selectors) && selectors.every(s => typeof s === 'string')
    );
    if ( entries.length === 0 ) {
        statusLine(i18n$('xzZapImportBad') || 'Not a valid zap-rules file.');
        return;
    }
    await sendMessage({ what: 'addManyCustomFilters', entries });
    statusLine(
        (i18n$('xzZapImported') || 'Imported rules for {{count}} sites.')
            .replace('{{count}}', `${entries.length}`)
    );
}

/******************************************************************************/

function init() {
    if ( qs$('#xzov0efe-packlist') === null ) { return; }
    render();
    dom.on('#xzov0efe-zapExport', 'click', ev => {
        if ( ev.isTrusted !== true ) { return; }
        exportZapRules();
    });
    const fileInput = qs$('#xzov0efe-zapImportFile');
    dom.on('#xzov0efe-zapImport', 'click', ev => {
        if ( ev.isTrusted !== true ) { return; }
        fileInput.click();
    });
    fileInput.addEventListener('change', ( ) => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if ( file === undefined ) { return; }
        importZapRules(file);
    });
    const observer = new MutationObserver(( ) => {
        if ( document.body.dataset.pane === 'zaplib' ) {
            render();
        }
    });
    observer.observe(document.body, {
        attributes: true,
        attributeFilter: [ 'data-pane' ],
    });
}

init();

/******************************************************************************/
