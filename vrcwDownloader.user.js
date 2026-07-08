// ==UserScript==
// @name         VRChat World Search — Download Button
// @namespace    https://vrchat.com/
// @version      1.8
// @description  Adds a download button + version picker to VRChat world search results, "My Worlds", and individual world pages. Downloads the chosen PC (standalonewindows) .vrcw bundle.
// @author       VRCUploader Team
// @match        https://vrchat.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/VRCUploader/vrcw-download-script/main/vrcwDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/VRCUploader/vrcw-download-script/main/vrcwDownloader.user.js
// ==/UserScript==

(function () {
    'use strict';

    const WORLD_LINK = 'a[href*="/home/world/wrld_"]';
    const WORLD_ID_RE = /(wrld_[0-9a-fA-F-]{36})/;
    const VERSION_RE = /\/file\/[^/]+\/(\d+)\//; // .../file/file_xxx/485/file -> 485

    const style = document.createElement('style');
    style.textContent = `
        .vrcw-row {
            display: flex;
            gap: 8px;
            align-items: stretch;
            margin: 12px;
        }
        .vrcw-row.vrcw-detail { margin: 12px 0; }
        .vrcw-dl-btn {
            flex: 1 1 auto;
            min-width: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 10px 12px;
            box-sizing: border-box;
            font: 600 14px/1 system-ui, sans-serif;
            color: #fff;
            background: rgba(50, 120, 220, 0.9);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            transition: background .15s ease;
        }
        .vrcw-dl-btn:hover { background: rgba(60, 140, 240, 1); }
        .vrcw-dl-btn[disabled] { opacity: .7; cursor: default; }
        .vrcw-dl-btn.err { background: rgba(190, 40, 40, 0.95); }
        .vrcw-dl-btn.ok  { background: rgba(40, 150, 70, 0.95); }

        .vrcw-ver { position: relative; flex: 0 0 auto; }
        .vrcw-ver-trigger {
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 10px 12px;
            font: 600 14px/1 system-ui, sans-serif;
            color: #fff;
            background: rgba(60, 60, 70, 0.9);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            cursor: pointer;
            white-space: nowrap;
        }
        .vrcw-ver-trigger:hover { background: rgba(80, 80, 95, 1); }
        .vrcw-ver-menu {
            position: absolute;
            top: calc(100% + 4px);
            right: 0;
            min-width: 130px;
            max-height: 240px;
            overflow-y: auto;
            background: #1c1c22;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            z-index: 9999;
            box-shadow: 0 6px 20px rgba(0,0,0,.5);
        }
        .vrcw-ver-item {
            display: block;
            width: 100%;
            text-align: left;
            padding: 8px 12px;
            background: none;
            border: 0;
            color: #fff;
            font: 500 13px/1 system-ui, sans-serif;
            cursor: pointer;
            white-space: nowrap;
        }
        .vrcw-ver-item:hover { background: rgba(50, 120, 220, 0.9); }
        .vrcw-ver-msg {
            padding: 8px 12px;
            color: #ddd;
            font: 500 13px/1 system-ui, sans-serif;
        }
        .vrcw-ver-msg.err { color: #ff8080; cursor: pointer; }
    `;
    document.head.appendChild(style);

    // ------------------------------------------------------------------
    // API
    // ------------------------------------------------------------------

    // One fetch per world, shared between the button and the dropdown.
    const versionCache = new Map();

    async function fetchUnityPackages(worldId) {
        const endpoints = [
            `https://vrchat.com/api/1/worlds/${worldId}/files`,
            `https://vrchat.com/api/1/worlds/${worldId}`,
        ];
        for (const url of endpoints) {
            try {
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) continue;
                const packages = readPackages(await res.json());
                if (packages.length) return packages;
            } catch (e) {
                // try the next endpoint
            }
        }
        return [];
    }

    // The response shape varies: a world object, an array of files, or {unityPackages}.
    function readPackages(data) {
        if (!data) return [];
        if (Array.isArray(data.unityPackages)) return data.unityPackages;
        if (Array.isArray(data)) {
            return data.flatMap(item =>
                item && Array.isArray(item.unityPackages) ? item.unityPackages : []);
        }
        return [];
    }

    function toVersionList(packages) {
        const versions = [];
        for (const pkg of packages) {
            if (!pkg || pkg.platform !== 'standalonewindows') continue; // PC only
            const asset = pkg.assetUrl;
            if (!asset || asset.includes('/variant/')) continue;        // skip the security variant
            const match = asset.match(VERSION_RE);
            versions.push({
                version: match ? parseInt(match[1], 10) : (pkg.assetVersion || 0),
                url: asset.replace('api.vrchat.cloud', 'vrchat.com'),   // logged-in host
            });
        }
        versions.sort((a, b) => b.version - a.version);

        const seen = new Set();
        return versions.filter(v => !seen.has(v.version) && seen.add(v.version));
    }

    function getVersions(worldId) {
        if (!versionCache.has(worldId)) {
            const promise = fetchUnityPackages(worldId).then(packages => {
                const list = toVersionList(packages);
                if (!list.length) throw new Error('No PC bundle found (are you logged in?)');
                return list;
            });
            promise.catch(() => versionCache.delete(worldId)); // let a failed lookup retry
            versionCache.set(worldId, promise);
        }
        return versionCache.get(worldId);
    }

    function download(url) {
        const link = document.createElement('a');
        link.href = url;
        link.download = '';
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    // ------------------------------------------------------------------
    // Controls
    // ------------------------------------------------------------------

    function makeControls(worldId) {
        const row = document.createElement('div');
        row.className = 'vrcw-row';

        let selected = 'latest';
        let loaded = null;

        // --- download button ---
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'vrcw-dl-btn';
        button.title = 'Download PC (.vrcw) bundle';
        button.innerHTML = '<span class="vrcw-lbl">⬇ Download VRCW</span>';
        const label = button.querySelector('.vrcw-lbl');

        button.addEventListener('mousedown', swallow);
        button.addEventListener('click', async ev => {
            swallow(ev);
            if (button.dataset.busy) return;
            button.dataset.busy = '1';
            button.disabled = true;
            button.classList.remove('err', 'ok');

            try {
                label.textContent = 'Fetching…';
                const list = await getVersions(worldId);
                const entry = selected === 'latest'
                    ? list[0]
                    : list.find(v => String(v.version) === selected) || list[0];
                download(entry.url);
                flash('ok', `Downloading v${entry.version} ✓`);
            } catch (err) {
                console.error('[VRCW]', err);
                button.title = String(err.message || err);
                flash('err', 'Error — tap to retry');
            }
        });

        function flash(state, text) {
            button.classList.add(state);
            label.textContent = text;
            setTimeout(() => {
                button.classList.remove(state);
                label.textContent = '⬇ Download VRCW';
                button.disabled = false;
                delete button.dataset.busy;
            }, state === 'ok' ? 2500 : 3000);
        }

        // --- version dropdown ---
        const picker = document.createElement('div');
        picker.className = 'vrcw-ver';

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'vrcw-ver-trigger';
        trigger.textContent = 'Latest ▾';

        const menu = document.createElement('div');
        menu.className = 'vrcw-ver-menu';
        menu.hidden = true;

        picker.append(trigger, menu);

        const closeOnOutside = e => { if (!picker.contains(e.target)) close(); };
        function open()  { menu.hidden = false; document.addEventListener('click', closeOnOutside, true); }
        function close() { menu.hidden = true;  document.removeEventListener('click', closeOnOutside, true); }

        function renderMenu(list) {
            menu.innerHTML = '';
            const options = [{ value: 'latest', text: `Latest (v${list[0].version})` }]
                .concat(list.map(v => ({ value: String(v.version), text: `v${v.version}` })));

            for (const opt of options) {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'vrcw-ver-item';
                item.textContent = opt.text;
                item.addEventListener('click', e => {
                    swallow(e);
                    selected = opt.value;
                    trigger.textContent = (opt.value === 'latest' ? 'Latest' : opt.text) + ' ▾';
                    close();
                });
                menu.appendChild(item);
            }
        }

        async function loadMenu() {
            menu.innerHTML = '<div class="vrcw-ver-msg">Loading…</div>';
            try {
                loaded = await getVersions(worldId);
                renderMenu(loaded);
            } catch (err) {
                console.error('[VRCW]', err);
                loaded = null;
                const msg = document.createElement('div');
                msg.className = 'vrcw-ver-msg err';
                msg.textContent = 'Error — tap to retry';
                msg.addEventListener('click', e => { e.stopPropagation(); loadMenu(); });
                menu.innerHTML = '';
                menu.appendChild(msg);
            }
        }

        trigger.addEventListener('mousedown', e => e.stopPropagation());
        trigger.addEventListener('click', e => {
            swallow(e);
            if (!menu.hidden) return close();
            open();
            loaded ? renderMenu(loaded) : loadMenu();
        });

        row.append(button, picker);
        return row;
    }

    function swallow(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    // ------------------------------------------------------------------
    // Placement
    // ------------------------------------------------------------------

    function currentWorldId() {
        const m = location.pathname.match(WORLD_ID_RE);
        return m ? m[1] : null;
    }

    function countWorlds(el) {
        const ids = new Set();
        el.querySelectorAll(WORLD_LINK).forEach(a => {
            const m = (a.getAttribute('href') || '').match(WORLD_ID_RE);
            if (m) ids.add(m[1]);
        });
        return ids.size;
    }

    function isFramed(el) {
        const cs = getComputedStyle(el);
        const border = parseFloat(cs.borderTopWidth) || 0;
        const outline = parseFloat(cs.outlineWidth) || 0;
        return (border > 0 && cs.borderTopStyle !== 'none') ||
               (outline > 0 && cs.outlineStyle !== 'none');
    }

    // Walk up until the parent would include a second world, keeping track of
    // the outermost bordered ancestor (the framed search-result card).
    function findCard(anchor) {
        let card = anchor;
        let framed = null;
        while (card.parentElement && card.parentElement !== document.body) {
            if (countWorlds(card.parentElement) > 1) break;
            card = card.parentElement;
            if (isFramed(card)) framed = card;
        }
        return { card, framed };
    }

    function place(card, framed, controls) {
        // Search cards: drop it below the tags, inside the frame.
        if (framed) return framed.appendChild(controls);

        // My Worlds tiles have no frame and a fixed height that clips a bottom
        // child, so sit the controls just after the title row instead.
        const links = [...card.querySelectorAll(WORLD_LINK)];
        const title = links.find(a => !a.querySelector('img')) || links[0];
        if (title && title.parentElement && card.contains(title.parentElement)) {
            title.parentElement.insertAdjacentElement('afterend', controls);
        } else {
            card.appendChild(controls);
        }
    }

    function addToCards(root) {
        root.querySelectorAll(WORLD_LINK).forEach(anchor => {
            const m = (anchor.getAttribute('href') || '').match(WORLD_ID_RE);
            if (!m || m[1] === currentWorldId()) return; // detail page handles its own world

            const { card, framed } = findCard(anchor);
            if (!card.querySelector('img')) return;             // not a real card
            if (card.querySelector('.vrcw-dl-btn')) return;     // already added

            place(card, framed, makeControls(m[1]));
        });
    }

    function addToWorldPage() {
        const worldId = currentWorldId();
        const existing = document.querySelector('.vrcw-detail');

        if (!worldId) return existing && existing.remove();
        if (existing) {
            if (existing.dataset.worldId === worldId) return;
            existing.remove(); // navigated to a different world
        }

        const info = document.querySelector('[aria-label="World Info"]');
        if (!info || !info.parentElement) return; // still rendering

        const controls = makeControls(worldId);
        controls.classList.add('vrcw-detail');
        controls.dataset.worldId = worldId;
        info.parentElement.appendChild(controls);
    }

    function refresh() {
        addToCards(document);
        addToWorldPage();
    }

    refresh();

    // VRChat is a SPA, so re-scan as cards and pages render in.
    let queued = false;
    new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; refresh(); });
    }).observe(document.body, { childList: true, subtree: true });
})();
