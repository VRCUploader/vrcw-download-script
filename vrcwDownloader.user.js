// ==UserScript==
// @name         VRChat World Downloader
// @namespace    https://vrchat.com/
// @version      2.3
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
    // Asset URLs look like .../api/1/file/file_xxx/485/file. Match the id and
    // version in the /file/ segment, not the 1 in /api/1/.
    const FILE_ID_RE = /\/file\/(file_[0-9a-fA-F-]+)\//;
    const VERSION_RE = /\/file\/(file_[0-9a-fA-F-]+)\/(\d+)\//;

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
        .vrcw-ver-item.missing { color: #888; }
        .vrcw-ver-item.missing:hover { background: rgba(80, 80, 95, 0.9); }
        .vrcw-ver-msg {
            padding: 8px 12px;
            color: #ddd;
            font: 500 13px/1 system-ui, sans-serif;
        }
        .vrcw-ver-msg.err { color: #ff8080; cursor: pointer; }
        .vrcw-ver-note {
            padding: 8px 12px;
            color: #c8b06a;
            font: 500 12px/1.35 system-ui, sans-serif;
            border-bottom: 1px solid rgba(255,255,255,0.12);
            white-space: normal;
            max-width: 220px;
        }
    `;
    document.head.appendChild(style);

    // ------------------------------------------------------------------
    // API
    // ------------------------------------------------------------------

    // One fetch per world / file, shared between the button and the dropdowns.
    const packageCache = new Map();
    const fileMetaCache = new Map();

    async function fetchUnityPackages(worldId) {
        const endpoints = [
            `https://vrchat.com/api/1/worlds/${worldId}/files`,
            `https://vrchat.com/api/1/worlds/${worldId}`,
        ];
        for (const url of endpoints) {
            try {
                const response = await fetch(url, { credentials: 'include' });
                if (!response.ok) continue;
                const packages = readPackages(await response.json());
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
        return PLATFORMS.find(platform => platform.id === platformId)?.label || platformId;
    }

    // Only rewrite the version number after the file id, not the 1 in /api/1/.
    function versionUrl(template, version) {
        return template.replace(
            /\/file\/(file_[0-9a-fA-F-]+)\/\d+(\/|$)/,
            `/file/$1/${version}$2`
        );
    }

    // Versions of a file that actually have downloadable data. A version entry
    // can still exist after its data is gone (deleted flag, missing file blob,
    // or a size of 0 bytes).
    async function getAvailableVersions(fileId) {
        if (!fileMetaCache.has(fileId)) {
            const promise = (async () => {
                const response = await fetch(`https://vrchat.com/api/1/file/${fileId}`, {
                    credentials: 'include',
                });
                if (!response.ok) throw new Error('Could not check file versions');
                const data = await response.json();
                const available = new Set();
                for (const entry of data.versions || []) {
                    if (!entry || entry.version < 1) continue;
                    if (entry.deleted) continue;
                    const file = entry.file;
                    if (entry.status === 'complete'
                        && file?.status === 'complete'
                        && (file.sizeInBytes || 0) > 0) {
                        available.add(entry.version);
                    }
                }
                return available;
            })();
            promise.catch(() => fileMetaCache.delete(fileId));
            fileMetaCache.set(fileId, promise);
        }
        return fileMetaCache.get(fileId);
    }

    // File ids currently used by a platform (security variants excluded).
    function isDownloadableAsset(pkg, platform) {
        return Boolean(pkg && pkg.platform === platform
            && pkg.assetUrl && !pkg.assetUrl.includes('/variant/'));
    }

    function fileIdsForPlatform(packages, platform) {
        const ids = new Set();
        for (const pkg of packages) {
            if (!isDownloadableAsset(pkg, platform)) continue;
            const match = pkg.assetUrl.match(FILE_ID_RE);
            if (match) ids.add(match[1]);
        }
        return ids;
    }

    // Platforms that currently share a file id with the given one. The API only
    // lists each platform's latest upload, so older versions of a shared file
    // can't be attributed reliably - warn instead of guessing.
    function platformsSharingFile(packages, platform) {
        const ours = fileIdsForPlatform(packages, platform);
        if (!ours.size) return [];
        return PLATFORMS
            .filter(option => option.id !== platform)
            .filter(option => {
                const theirs = fileIdsForPlatform(packages, option.id);
                return [...theirs].some(fileId => ours.has(fileId));
            })
            .map(option => option.label);
    }

    // Every version from latest down to 1. Entries present in unityPackages are verified.
    async function toVersionList(packages, platform) {
        const verified = new Map(); // version -> url
        let latest = 0;
        let template = null;

        for (const pkg of packages) {
            if (!isDownloadableAsset(pkg, platform)) continue;
            const asset = pkg.assetUrl;
            const match = asset.match(VERSION_RE);
            const version = match ? parseInt(match[2], 10) : (pkg.assetVersion || 0);
            if (!version) continue;
            const url = asset.replace('api.vrchat.cloud', 'vrchat.com');
            verified.set(version, url);
            if (version > latest) {
                latest = version;
                template = url;
            }
        }

        if (!latest || !template) return [];

        // unityPackages can cite more than one file id for the same platform, so
        // check availability per file instead of assuming they all share the latest.
        const urls = new Map(); // version -> url
        for (let version = latest; version >= 1; version--) {
            urls.set(version, verified.get(version) || versionUrl(template, version));
        }
        const fileIds = new Set(
            [...urls.values()].map(url => url.match(FILE_ID_RE)?.[1]).filter(Boolean));
        const availability = new Map(); // fileId -> Set(version) | null
        await Promise.all([...fileIds].map(async fileId => {
            try {
                availability.set(fileId, await getAvailableVersions(fileId));
            } catch (error) {
                console.warn('[VRCW] file meta lookup failed', fileId, error);
                availability.set(fileId, null);
            }
        }));

        const versions = [];
        for (let version = latest; version >= 1; version--) {
            const url = urls.get(version);
            const fileId = url.match(FILE_ID_RE)?.[1];
            const availableVersions = fileId ? availability.get(fileId) : null;
            versions.push({
                version,
                url,
                verified: verified.has(version),
                // null = unknown (metadata lookup failed)
                available: availableVersions ? availableVersions.has(version) : null,
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
        const list = await toVersionList(packages, platform);
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

    function stopEvent(event) {
        event.preventDefault();
        event.stopPropagation();
    }

    // ------------------------------------------------------------------
    // Controls
    // ------------------------------------------------------------------

    function makeControls(worldId, { compact = false } = {}) {
        const row = document.createElement('div');
        row.className = compact ? 'vrcw-row vrcw-compact' : 'vrcw-row';

        let selectedVersion = 'latest';
        let platform = 'standalonewindows';
        let cachedVersions = null;
        let sharedWith = [];
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
            const flash = (state, text, holdMs) => {
                button.classList.add(state);
                label.textContent = text;
                setTimeout(() => { button.classList.remove(state); reset(); }, holdMs);
            };

            button.addEventListener('mousedown', stopEvent);
            button.addEventListener('click', async event => {
                stopEvent(event);
                if (button.dataset.busy) return;
                button.dataset.busy = '1';
                button.disabled = true;
                button.classList.remove('err', 'ok');

                try {
                    label.textContent = compact ? '…' : 'Fetching…';
                    const list = await getVersions(worldId, platform);
                    const entry = selectedVersion === 'latest'
                        ? list[0]
                        : list.find(item => String(item.version) === selectedVersion) || list[0];
                    if (entry.available === false) {
                        throw new Error(`v${entry.version} is not available`);
                    }
                    download(entry.url);
                    flash('ok', compact ? `v${entry.version} ✓` : `Downloading v${entry.version} ✓`, 2500);
                } catch (error) {
                    console.error('[VRCW]', error);
                    button.title = String(error.message || error);
                    const message = String(error.message || '');
                    const noBundle = /No .+ bundle found/.test(message);
                    flash('err', compact
                        ? (message.includes('not available') || noBundle ? '✕ none' : '✕ retry')
                        : (message || 'Error - tap to retry'), 3000);
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

            const closeOnOutsideClick = event => {
                if (menu && !menu.contains(event.target) && !trigger.contains(event.target)) close();
            };

            // Close on page/carousel scroll, but not when scrolling inside the menu.
            const closeOnOutsideScroll = event => {
                if (menu && !menu.contains(event.target)) close();
            };

            function open() {
                menu = document.createElement('div');
                menu.className = 'vrcw-ver-menu';
                document.body.appendChild(menu);
                document.addEventListener('click', closeOnOutsideClick, true);
                window.addEventListener('scroll', closeOnOutsideScroll, true);
                window.addEventListener('resize', close);
                buildItems(menu, { showMessage, reposition, close, trigger });
            }

            function close() {
                if (!menu) return;
                menu.remove();
                menu = null;
                document.removeEventListener('click', closeOnOutsideClick, true);
                window.removeEventListener('scroll', closeOnOutsideScroll, true);
                window.removeEventListener('resize', close);
            }

            // Pin under the trigger with right edges aligned (menu lives in <body>).
            function reposition() {
                const rect = trigger.getBoundingClientRect();
                menu.style.top = `${rect.bottom + 4}px`;
                menu.style.right = `${window.innerWidth - rect.right}px`;
            }

            function showMessage(text, isError = false) {
                menu.className = 'vrcw-ver-menu vrcw-ver-msg' + (isError ? ' err' : '');
                menu.textContent = text;
                reposition();
            }

            trigger.addEventListener('mousedown', event => event.stopPropagation());
            trigger.addEventListener('click', event => {
                stopEvent(event);
                if (menu) close();
                else open();
            });

            return { picker, trigger, close };
        }

        function makePlatformPicker() {
            const { picker, trigger } = makeDropdown({
                triggerText: platformLabel(platform) + ' ▾',
                buildItems(menu, { reposition, close, trigger }) {
                    menu.className = 'vrcw-ver-menu';
                    menu.textContent = '';

                    for (const option of PLATFORMS) {
                        const item = document.createElement('button');
                        item.type = 'button';
                        item.className = 'vrcw-ver-item' + (option.id === platform ? ' active' : '');
                        item.textContent = option.label;
                        item.addEventListener('click', event => {
                            stopEvent(event);
                            if (option.id !== platform) {
                                platform = option.id;
                                selectedVersion = 'latest';
                                cachedVersions = null;
                                sharedWith = [];
                                trigger.textContent = option.label + ' ▾';
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

                if (sharedWith.length) {
                    const note = document.createElement('div');
                    note.className = 'vrcw-ver-note';
                    note.textContent = `Shares file with ${sharedWith.join(', ')} - `
                        + 'older versions may belong to another platform';
                    menu.appendChild(note);
                }

                const latest = list[0];
                const options = [{
                    value: 'latest',
                    text: `Latest (v${latest.version})${latest.verified ? ' ✓' : ''}`,
                    triggerText: 'Latest',
                    missing: latest.available === false,
                }].concat(list.map(entry => {
                    const missing = entry.available === false;
                    const mark = missing ? ' ✕' : (entry.verified ? ' ✓' : '');
                    return {
                        value: String(entry.version),
                        text: `v${entry.version}${mark}`,
                        triggerText: `v${entry.version}${mark}`,
                        missing,
                    };
                }));

                for (const option of options) {
                    const item = document.createElement('button');
                    item.type = 'button';
                    item.className = 'vrcw-ver-item'
                        + (option.value === selectedVersion ? ' active' : '')
                        + (option.missing ? ' missing' : '');
                    item.textContent = option.text;
                    item.addEventListener('click', event => {
                        stopEvent(event);
                        selectedVersion = option.value;
                        trigger.textContent = option.triggerText + ' ▾';
                        close();
                    });
                    menu.appendChild(item);
                }
                reposition();
            }

            async function load(menu, { showMessage, reposition, close, trigger }) {
                try {
                    // getVersions reuses the cached package fetch, so this is one request.
                    const packages = await getPackages(worldId);
                    sharedWith = platformsSharingFile(packages, platform);
                    cachedVersions = await getVersions(worldId, platform);
                    if (menu.isConnected) render(cachedVersions, menu, { reposition, close, trigger });
                } catch (error) {
                    console.error('[VRCW]', error);
                    if (!menu.isConnected) return;
                    const message = String(error.message || '');
                    // Missing platform builds aren't transient, so don't invite a retry.
                    if (/No .+ bundle found/.test(message)) {
                        showMessage(message);
                        return;
                    }
                    showMessage('Error - tap to retry', true);
                    menu.onclick = event => {
                        event.stopPropagation();
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
        const match = location.pathname.match(WORLD_ID_RE);
        return match ? match[1] : null;
    }

    function countWorlds(element) {
        const ids = new Set();
        element.querySelectorAll(WORLD_LINK).forEach(anchor => {
            const match = (anchor.getAttribute('href') || '').match(WORLD_ID_RE);
            if (match) ids.add(match[1]);
        });
        return ids.size;
    }

    function isFramed(element) {
        const styles = getComputedStyle(element);
        const border = parseFloat(styles.borderTopWidth) || 0;
        const outline = parseFloat(styles.outlineWidth) || 0;
        return (border > 0 && styles.borderTopStyle !== 'none') ||
               (outline > 0 && styles.outlineStyle !== 'none');
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
        let element = anchor.parentElement;
        while (element && element !== document.body && countWorlds(element) <= 1) {
            if (isFramed(element)) return element;
            element = element.parentElement;
        }
        return anchor.parentElement;
    }

    function placeInFlow(card, framed, controls) {
        // Search cards: below the tags, inside the frame.
        if (framed) return framed.appendChild(controls);

        // My Worlds tiles have a fixed height that clips a bottom child, so sit
        // the controls right after the title row instead.
        const links = [...card.querySelectorAll(WORLD_LINK)];
        const title = links.find(link => !link.querySelector('img')) || links[0];
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

    // The uploaded-worlds modal and My Worlds use narrow "World Card" tiles
    // whose image wrapper counts as framed, so !framed alone is not enough
    // to decide when to go compact.
    function useCompactControls(card, framed) {
        if (!framed) return true;
        if (card.getAttribute('aria-label') === 'World Card') return true;
        if (card.closest('[role="dialog"]')) return true;
        const width = card.getBoundingClientRect().width;
        return width > 0 && width < 380;
    }

    function addToCards(root) {
        root.querySelectorAll(WORLD_LINK).forEach(anchor => {
            const worldId = (anchor.getAttribute('href') || '').match(WORLD_ID_RE)?.[1];
            if (!worldId || worldId === currentWorldId()) return; // detail page handles its own world

            // Discover puts a full-card overlay link on top of a CSS background
            // thumbnail, while other pages wrap a normal <img> in the page flow.
            if (getComputedStyle(anchor).position === 'absolute') {
                const tile = overlayTile(anchor);
                if (!tile.querySelector('.vrcw-overlay')) {
                    placeOverlay(tile, makeControls(worldId, { compact: true }));
                }
            } else {
                const { card, framed } = findCard(anchor);
                if (!card.querySelector('.vrcw-dl-btn') && card.querySelector('img')) {
                    placeInFlow(card, framed, makeControls(worldId, {
                        compact: useCompactControls(card, framed),
                    }));
                }
            }
        });
    }

    function addToWorldPage() {
        const worldId = currentWorldId();
        const existing = document.querySelector('.vrcw-detail');

        if (!worldId) {
            existing?.remove();
            return;
        }
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
