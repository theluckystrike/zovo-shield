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

    Pro pane: supporter-key entry wired to the licence layer 5.95
    handlers in the background script (zsLicenseStatus/zsLicenseApply/
    zsLicenseClear). The filtering core is never gated; this pane only
    unlocks convenience extras.

*/

import { sendMessage } from './ext.js';
import { dom, qs$ } from './dom.js';
import { i18n$ } from './i18n.js';

/******************************************************************************/

const reasonToMessage = reason => {
    const key = {
        'invalid-format': 'xzProMsgBadShape',
        'invalid-key': 'xzProMsgInvalid',
        'rate-limited': 'xzProMsgRateLimited',
        'timeout': 'xzProMsgOffline',
        'network': 'xzProMsgOffline',
        'insecure': 'xzProMsgOffline',
        'bad-schema': 'xzProMsgOffline',
    }[reason];
    return i18n$(key || 'xzProMsgError') || i18n$('xzProMsgError') || 'Could not verify the key';
};

/******************************************************************************/

function renderStatus(status) {
    const badge = qs$('#xzov0efe-proBadge');
    const statusText = qs$('#xzov0efe-proStatusText');
    const keyRow = qs$('#xzov0efe-proKeyRow');
    const keyInput = qs$('#xzov0efe-proKey');
    const clearBtn = qs$('#xzov0efe-proClear');
    if ( badge === null ) { return; }
    const pro = status instanceof Object && status.pro === true;
    badge.dataset.state = pro ? 'pro' : 'free';
    badge.textContent = pro
        ? (i18n$('xzProBadgePro') || 'Pro')
        : (i18n$('xzProBadgeFree') || 'Free');
    if ( pro ) {
        const tier = typeof status.tier === 'string' ? status.tier : 'pro';
        statusText.textContent = (i18n$('xzProStatusPro') ||
            'Supporter unlock active ({{tier}}, key ····{{tail}}). Thank you!')
            .replace('{{tier}}', tier)
            .replace('{{tail}}', status.keyTail || '');
        keyInput.hidden = true;
        qs$('#xzov0efe-proApply').hidden = true;
        clearBtn.hidden = false;
    } else {
        statusText.textContent = i18n$('xzProStatusFree') ||
            'You are on the free tier — everything below stays free forever.';
        keyInput.hidden = false;
        qs$('#xzov0efe-proApply').hidden = false;
        clearBtn.hidden = true;
    }
    dom.cl.toggle(keyRow, 'pro', pro);
}

async function refreshStatus() {
    const status = await sendMessage({ what: 'zsLicenseStatus' }).catch(( ) => undefined);
    renderStatus(status);
}

/******************************************************************************/

function initApply() {
    const applyBtn = qs$('#xzov0efe-proApply');
    const keyInput = qs$('#xzov0efe-proKey');
    const msg = qs$('#xzov0efe-proMsg');
    dom.on(applyBtn, 'click', async ev => {
        if ( ev.isTrusted !== true ) { return; }
        const key = keyInput.value.trim();
        if ( key === '' ) {
            msg.textContent = i18n$('xzProMsgEmpty') || 'Paste your key first';
            return;
        }
        applyBtn.disabled = true;
        msg.textContent = i18n$('xzProMsgVerifying') || 'Verifying…';
        const result = await sendMessage({ what: 'zsLicenseApply', key }).catch(( ) => undefined);
        applyBtn.disabled = false;
        if ( result instanceof Object && result.ok === true ) {
            keyInput.value = '';
            msg.textContent = i18n$('xzProMsgOk') || 'Unlocked — thank you for supporting Zovo Shield!';
        } else {
            msg.textContent = reasonToMessage(result?.reason);
        }
        await refreshStatus();
    });
    dom.on(keyInput, 'keydown', ev => {
        if ( ev.isTrusted !== true ) { return; }
        if ( ev.key !== 'Enter' ) { return; }
        ev.preventDefault();
        applyBtn.click();
    });
}

function initClear() {
    const clearBtn = qs$('#xzov0efe-proClear');
    const msg = qs$('#xzov0efe-proMsg');
    dom.on(clearBtn, 'click', async ev => {
        if ( ev.isTrusted !== true ) { return; }
        await sendMessage({ what: 'zsLicenseClear' }).catch(( ) => undefined);
        msg.textContent = i18n$('xzProMsgCleared') || 'Key removed from this browser';
        await refreshStatus();
    });
}

/******************************************************************************/

refreshStatus().then(( ) => {
    initApply();
    initClear();
}).catch(( ) => {
});

/******************************************************************************/
