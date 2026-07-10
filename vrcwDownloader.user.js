// ==UserScript==
// @name         VRChat World Search — Download Button
// @namespace    https://vrchat.com/
// @version      2.1
// @description  Adds a download button + platform/version picker to VRChat world search results, "My Worlds", Discover Worlds, and individual world pages. Downloads the chosen .vrcw bundle for PC, Android, or iOS.
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

    const PLATFORMS = [
        { id: 'standalonewindows', label: 'PC' },
        { id: 'android', label: 'Android' },
        { id: 'ios', label: 'iOS' },
    ];

    const style = document.createElement('style');
    style.textContent = `
        .vrcw-row {
            display: flex;
            gap: 8px;
            align-items: stretch;
            margin: 12px;
        }
        .vrcw-row.vrcw-detail { margin: 12px 0; }
        .vrcw-overlay {
            position: absolute;
            top: 6px;
            right: 6px;
            margin: 0;
            z-index: 20;
        }
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

        .vrcw-compact .vrcw-dl-btn,
        .vrcw-compact .vrcw-ver-trigger {
            flex: 0 0 auto;
            padding: 6px 9px;
            font-size: 12px;
        }
        .vrcw-row.vrcw-compact:not(.vrcw-overlay) { margin: 6px 0; gap: 6px; }

        /* Lives in <body> so a card's overflow:hidden can't clip it. */
        .vrcw-ver-menu {
            position: fixed;
            min-width: 130px;
            max-height: 240px;
            overflow-y: auto;
            background: #1c1c22;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            z-index: 99999;
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
        .vrcw-ver-item.active { background: rgba(50, 120, 220, 0.55); }
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

    // One fetch per world, shared between the button and the dropdowns.
    const packageCache = new Map();

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
            } catch {
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

    function platformLabel(platformId) {
        return PLATFORMS.find(p => p.id === platformId)?.label || platformId;
    }

    function versionUrl(template, version) {
        return template.replace(/\/(\d+)(\/file)/, `/${version}$2`);
    }

    // Every version from latest down to 1. Entries present in unityPackages are verified.
    function toVersionList(packages, platform) {
        const verified = new Map(); // version -> url
        let latest = 0;
        let template = null;

        for (const pkg of packages) {
            if (!pkg || pkg.platform !== platform) continue;
            const asset = pkg.assetUrl;
            if (!asset || asset.includes('/variant/')) continue; // skip the security variant
            const match = asset.match(VERSION_RE);
            const version = match ? parseInt(match[1], 10) : (pkg.assetVersion || 0);
            if (!version) continue;
            const url = asset.replace('api.vrchat.cloud', 'vrchat.com');
            verified.set(version, url);
            if (version > latest) {
                latest = version;
                template = url;
            }
        }

        if (!latest || !template) return [];

        const versions = [];
        for (let v = latest; v >= 1; v--) {
            versions.push({
                version: v,
                url: verified.get(v) || versionUrl(template, v),
                verified: verified.has(v),
            });
        }
        return versions;
    }

    function getPackages(worldId) {
        if (!packageCache.has(worldId)) {
            const promise = fetchUnityPackages(worldId).then(packages => {
                if (!packages.length) throw new Error('No bundles found (are you logged in?)');
                return packages;
            });
            promise.catch(() => packageCache.delete(worldId)); // let a failed lookup retry
            packageCache.set(worldId, promise);
        }
        return packageCache.get(worldId);
    }

    async function getVersions(worldId, platform) {
        const packages = await getPackages(worldId);
        const list = toVersionList(packages, platform);
        if (!list.length) {
            throw new Error(`No ${platformLabel(platform)} bundle found`);
        }
        return list;
    }

    function download(url) {
        const link = document.createElement('a');
        link.href = url;
        link.download = '';
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    function swallow(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    // ------------------------------------------------------------------
    // Controls
    // ------------------------------------------------------------------

    function makeControls(worldId, { compact = false } = {}) {
        const row = document.createElement('div');
        row.className = compact ? 'vrcw-row vrcw-compact' : 'vrcw-row';

        let selected = 'latest';
        let platform = 'standalonewindows';
        let cachedVersions = null;
        let onPlatformChange = null;
        let versionTrigger = null;

        row.append(makeButton(), makePlatformPicker(), makeVersionPicker());
        return row;

        function makeButton() {
            const idle = compact ? '⬇ VRCW' : '⬇ Download VRCW';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'vrcw-dl-btn';
            button.title = `Download ${platformLabel(platform)} (.vrcw) bundle`;
            button.innerHTML = `<span class="vrcw-lbl">${idle}</span>`;
            const label = button.querySelector('.vrcw-lbl');

            const reset = () => {
                label.textContent = idle;
                button.disabled = false;
                delete button.dataset.busy;
            };
            const flash = (state, text, hold) => {
                button.classList.add(state);
                label.textContent = text;
                setTimeout(() => { button.classList.remove(state); reset(); }, hold);
            };

            button.addEventListener('mousedown', swallow);
            button.addEventListener('click', async ev => {
                swallow(ev);
                if (button.dataset.busy) return;
                button.dataset.busy = '1';
                button.disabled = true;
                button.classList.remove('err', 'ok');

                try {
                    label.textContent = compact ? '…' : 'Fetching…';
                    const list = await getVersions(worldId, platform);
                    const entry = selected === 'latest'
                        ? list[0]
                        : list.find(v => String(v.version) === selected) || list[0];
                    download(entry.url);
                    flash('ok', compact ? `v${entry.version} ✓` : `Downloading v${entry.version} ✓`, 2500);
                } catch (err) {
                    console.error('[VRCW]', err);
                    button.title = String(err.message || err);
                    flash('err', compact ? '✕ retry' : 'Error — tap to retry', 3000);
                }
            });

            onPlatformChange = () => {
                button.title = `Download ${platformLabel(platform)} (.vrcw) bundle`;
            };
            return button;
        }

        function makeDropdown({ triggerText, buildItems }) {
            const picker = document.createElement('div');
            picker.className = 'vrcw-ver';

            const trigger = document.createElement('button');
            trigger.type = 'button';
            trigger.className = 'vrcw-ver-trigger';
            trigger.textContent = triggerText;
            picker.appendChild(trigger);

            let menu = null;

            const closeOnOutside = e => {
                if (menu && !menu.contains(e.target) && !trigger.contains(e.target)) close();
            };

            // Close on page/carousel scroll, but not when scrolling inside the menu.
            const onScroll = e => {
                if (menu && !menu.contains(e.target)) close();
            };

            function open() {
                menu = document.createElement('div');
                menu.className = 'vrcw-ver-menu';
                document.body.appendChild(menu);
                document.addEventListener('click', closeOnOutside, true);
                window.addEventListener('scroll', onScroll, true);
                window.addEventListener('resize', close);
                buildItems(menu, { showMessage, reposition, close, trigger });
            }

            function close() {
                if (!menu) return;
                menu.remove();
                menu = null;
                document.removeEventListener('click', closeOnOutside, true);
                window.removeEventListener('scroll', onScroll, true);
                window.removeEventListener('resize', close);
            }

            // Pin under the trigger with right edges aligned (menu lives in <body>).
            function reposition() {
                const r = trigger.getBoundingClientRect();
                menu.style.top = `${r.bottom + 4}px`;
                menu.style.right = `${window.innerWidth - r.right}px`;
            }

            function showMessage(text, isError = false) {
                menu.className = 'vrcw-ver-menu vrcw-ver-msg' + (isError ? ' err' : '');
                menu.textContent = text;
                reposition();
            }

            trigger.addEventListener('mousedown', e => e.stopPropagation());
            trigger.addEventListener('click', e => { swallow(e); menu ? close() : open(); });

            return { picker, trigger, close };
        }

        function makePlatformPicker() {
            const { picker, trigger } = makeDropdown({
                triggerText: platformLabel(platform) + ' ▾',
                buildItems(menu, { reposition, close, trigger }) {
                    menu.className = 'vrcw-ver-menu';
                    menu.textContent = '';

                    for (const p of PLATFORMS) {
                        const item = document.createElement('button');
                        item.type = 'button';
                        item.className = 'vrcw-ver-item' + (p.id === platform ? ' active' : '');
                        item.textContent = p.label;
                        item.addEventListener('click', e => {
                            swallow(e);
                            if (p.id !== platform) {
                                platform = p.id;
                                selected = 'latest';
                                cachedVersions = null;
                                trigger.textContent = p.label + ' ▾';
                                versionTrigger.textContent = 'Latest ▾';
                                onPlatformChange?.();
                            }
                            close();
                        });
                        menu.appendChild(item);
                    }
                    reposition();
                },
            });
            return picker;
        }

        function makeVersionPicker() {
            const { picker, trigger } = makeDropdown({
                triggerText: 'Latest ▾',
                buildItems(menu, { showMessage, reposition, close, trigger }) {
                    if (cachedVersions) {
                        render(cachedVersions, menu, { reposition, close, trigger });
                    } else {
                        showMessage('Loading…');
                        load(menu, { showMessage, reposition, close, trigger });
                    }
                },
            });
            versionTrigger = trigger;
            return picker;

            function render(list, menu, { reposition, close, trigger }) {
                menu.className = 'vrcw-ver-menu';
                menu.textContent = '';

                const latest = list[0];
                const options = [{
                    value: 'latest',
                    text: `Latest (v${latest.version})${latest.verified ? ' ✓' : ''}`,
                    triggerText: 'Latest',
                }].concat(list.map(v => ({
                    value: String(v.version),
                    text: `v${v.version}${v.verified ? ' ✓' : ''}`,
                    triggerText: `v${v.version}${v.verified ? ' ✓' : ''}`,
                })));

                for (const opt of options) {
                    const item = document.createElement('button');
                    item.type = 'button';
                    item.className = 'vrcw-ver-item' + (opt.value === selected ? ' active' : '');
                    item.textContent = opt.text;
                    item.addEventListener('click', e => {
                        swallow(e);
                        selected = opt.value;
                        trigger.textContent = opt.triggerText + ' ▾';
                        close();
                    });
                    menu.appendChild(item);
                }
                reposition();
            }

            async function load(menu, { showMessage, reposition, close, trigger }) {
                try {
                    cachedVersions = await getVersions(worldId, platform);
                    if (menu.isConnected) render(cachedVersions, menu, { reposition, close, trigger });
                } catch (err) {
                    console.error('[VRCW]', err);
                    if (!menu.isConnected) return;
                    showMessage('Error — tap to retry', true);
                    menu.onclick = e => {
                        e.stopPropagation();
                        close();
                        trigger.click();
                    };
                }
            }
        }
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

    // Search cards: outermost bordered ancestor that still wraps a single world.
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

    // Discover tiles: nearest bordered box. Stopping at the border keeps a
    // single-item carousel (the hero) from climbing up to the section header.
    function overlayTile(anchor) {
        let el = anchor.parentElement;
        while (el && el !== document.body && countWorlds(el) <= 1) {
            if (isFramed(el)) return el;
            el = el.parentElement;
        }
        return anchor.parentElement;
    }

    function placeInFlow(card, framed, controls) {
        // Search cards: below the tags, inside the frame.
        if (framed) return framed.appendChild(controls);

        // My Worlds tiles have a fixed height that clips a bottom child, so sit
        // the controls right after the title row instead.
        const links = [...card.querySelectorAll(WORLD_LINK)];
        const title = links.find(a => !a.querySelector('img')) || links[0];
        if (title && title.parentElement && card.contains(title.parentElement)) {
            title.parentElement.insertAdjacentElement('afterend', controls);
        } else {
            card.appendChild(controls);
        }
    }

    function placeOverlay(tile, controls) {
        if (getComputedStyle(tile).position === 'static') tile.style.position = 'relative';
        controls.classList.add('vrcw-overlay');
        tile.appendChild(controls);
    }

    // Uploaded-worlds modal / My Worlds use narrow "World Card" tiles; the image
    // wrapper counts as framed, so !framed is the wrong compact signal there.
    function useCompactControls(card, framed) {
        if (!framed) return true;
        if (card.getAttribute('aria-label') === 'World Card') return true;
        if (card.closest('[role="dialog"]')) return true;
        const width = card.getBoundingClientRect().width;
        return width > 0 && width < 380;
    }

    function addToCards(root) {
        root.querySelectorAll(WORLD_LINK).forEach(anchor => {
            const m = (anchor.getAttribute('href') || '').match(WORLD_ID_RE);
            if (!m || m[1] === currentWorldId()) return; // detail page handles its own world

            // Discover uses full-card overlay links over a CSS-background thumbnail;
            // other pages wrap their own <img> in normal flow.
            if (getComputedStyle(anchor).position === 'absolute') {
                const tile = overlayTile(anchor);
                if (!tile.querySelector('.vrcw-overlay')) {
                    placeOverlay(tile, makeControls(m[1], { compact: true }));
                }
            } else {
                const { card, framed } = findCard(anchor);
                if (!card.querySelector('.vrcw-dl-btn') && card.querySelector('img')) {
                    placeInFlow(card, framed, makeControls(m[1], {
                        compact: useCompactControls(card, framed),
                    }));
                }
            }
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
