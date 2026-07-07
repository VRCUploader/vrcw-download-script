// ==UserScript==
// @name         VRChat World Search — Download Button
// @namespace    https://vrchat.com/
// @version      1.4
// @description  Adds a download button inside each world card in VRChat search results. Resolves the newest PC (standalonewindows) bundle and downloads the .vrcw.
// @author       VRCUploader Team
// @match        https://vrchat.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/VRCUploader/vrcw-download-script/main/vrcwDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/VRCUploader/vrcw-download-script/main/vrcwDownloader.user.js
// ==/UserScript==

(function () {
    'use strict';

    const WORLD_LINK_SELECTOR = 'a[href*="/home/world/wrld_"]';
    const THUMB_SELECTOR = 'a[href*="/home/world/wrld_"] img';
    const WORLD_ID_RE = /(wrld_[0-9a-fA-F-]{36})/;
    const VERSION_RE = /\/file\/[^/]+\/(\d+)\//;

    // ---- styling -----------------------------------------------------------
    const style = document.createElement('style');
    style.textContent = `
        .vrcw-dl-btn {
            display: block;
            width: calc(100% - 24px);
            margin: 12px;
            padding: 10px 12px;
            box-sizing: border-box;
            font: 600 14px/1 system-ui, sans-serif;
            text-align: center;
            color: #fff;
            background: rgba(50, 120, 220, 0.9);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            transition: background .15s ease;
        }
        .vrcw-dl-btn:hover  { background: rgba(60, 140, 240, 1); }
        .vrcw-dl-btn[disabled] { opacity: .7; cursor: default; }
        .vrcw-dl-btn.err { background: rgba(190, 40, 40, 0.95); }
        .vrcw-dl-btn.ok  { background: rgba(40, 150, 70, 0.95); }
    `;
    document.head.appendChild(style);

    // ---- API + download logic ---------------------------------------------

    async function getUnityPackages(worldId) {
        const endpoints = [
            `https://vrchat.com/api/1/worlds/${worldId}/files`,
            `https://vrchat.com/api/1/worlds/${worldId}`,
        ];
        for (const url of endpoints) {
            try {
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) continue;
                const data = await res.json();
                const pkgs = extractPackages(data);
                if (pkgs && pkgs.length) return pkgs;
            } catch (e) { /* try next */ }
        }
        return null;
    }

    function extractPackages(data) {
        if (!data) return null;
        if (Array.isArray(data.unityPackages)) return data.unityPackages;
        if (Array.isArray(data)) {
            const flat = [];
            for (const item of data) {
                if (item && Array.isArray(item.unityPackages)) flat.push(...item.unityPackages);
            }
            if (flat.length) return flat;
        }
        return null;
    }

    function pickBestUrl(packages) {
        let best = null, bestVersion = -1;
        for (const p of packages) {
            if (!p || p.platform !== 'standalonewindows') continue;   // PC only
            const asset = p.assetUrl;
            if (!asset) continue;                                     // skip empty
            if (asset.includes('/variant/')) continue;                // skip security variant
            const m = asset.match(VERSION_RE);
            const version = m ? parseInt(m[1], 10) : (p.assetVersion || 0);
            if (version > bestVersion) { bestVersion = version; best = asset; }
        }
        if (!best) return null;
        return best.replace('api.vrchat.cloud', 'vrchat.com');
    }

    function triggerDownload(url) {
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    async function handleClick(worldId, btn, ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (btn.dataset.busy) return;
        btn.dataset.busy = '1';
        btn.disabled = true;
        btn.classList.remove('err', 'ok');
        const label = btn.querySelector('.vrcw-lbl');
        const restore = () => { btn.disabled = false; delete btn.dataset.busy; };

        try {
            label.textContent = 'Fetching…';
            const pkgs = await getUnityPackages(worldId);
            if (!pkgs) throw new Error('no packages (are you logged in?)');
            const url = pickBestUrl(pkgs);
            if (!url) throw new Error('no PC bundle found');
            triggerDownload(url);
            btn.classList.add('ok');
            label.textContent = 'Downloading ✓';
            setTimeout(() => { btn.classList.remove('ok'); label.textContent = '⬇ Download VRCW'; restore(); }, 2500);
        } catch (err) {
            console.error('[VRCW] ', err);
            btn.classList.add('err');
            label.textContent = 'Error — tap to retry';
            btn.title = String(err.message || err);
            setTimeout(() => { btn.classList.remove('err'); label.textContent = '⬇ Download VRCW'; restore(); }, 3000);
        }
    }

    // ---- DOM injection -----------------------------------------------------

    function makeButton(worldId) {
        const btn = document.createElement('button');
        btn.className = 'vrcw-dl-btn';
        btn.type = 'button';
        btn.title = 'Download PC (.vrcw) bundle';
        btn.innerHTML = '<span class="vrcw-lbl">⬇ Download VRCW</span>';
        const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
        btn.addEventListener('mousedown', stop);
        btn.addEventListener('click', (e) => handleClick(worldId, btn, e));
        return btn;
    }

    function hasVisibleFrame(el) {
        const cs = getComputedStyle(el);
        const bw = parseFloat(cs.borderTopWidth) || 0;
        const ow = parseFloat(cs.outlineWidth) || 0;
        return (bw > 0 && cs.borderTopStyle !== 'none') ||
               (ow > 0 && cs.outlineStyle !== 'none');
    }

    // Climb from the thumbnail anchor, staying within this single card, and
    // return the OUTERMOST ancestor that has a visible border/outline (the
    // teal frame). Fall back to the top single-card wrapper if none is found.
    function findCard(anchor) {
        let el = anchor;
        let framed = null;
        while (el.parentElement && el.parentElement !== document.body) {
            const parent = el.parentElement;
            if (parent.querySelectorAll(THUMB_SELECTOR).length > 1) break;
            el = parent;
            if (hasVisibleFrame(el)) framed = el;   // keep highest framed one
        }
        return framed || el;
    }

    function inject(anchor) {
        if (!anchor.querySelector('img')) return;   // thumbnail anchor only
        if (anchor.dataset.vrcwDone) return;
        const m = anchor.href.match(WORLD_ID_RE);
        if (!m) return;
        anchor.dataset.vrcwDone = '1';

        const card = findCard(anchor);
        if (card.querySelector('.vrcw-dl-btn')) return;   // safety net
        card.appendChild(makeButton(m[1]));
    }

    function scan(root) {
        (root || document).querySelectorAll(WORLD_LINK_SELECTOR).forEach(inject);
    }

    scan(document);

    let pending = false;
    const observer = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; scan(document); });
    });
    observer.observe(document.body, { childList: true, subtree: true });
})();
