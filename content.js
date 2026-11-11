// Playlist Multi-Save
// Runs in the page's MAIN world (see manifest.json) so it can read YouTube's `ytcfg`
// and call the same internal API ("InnerTube") that YouTube's own Save dialog uses.
// YouTube enforces Trusted Types, so all DOM is built with createElement/textContent, never innerHTML.
(() => {
  'use strict';
  if (window.__ytMultiSave) return;
  window.__ytMultiSave = true;

  const BTN_ID = 'ytms-btn';
  const ROOT_ID = 'ytms-root';
  const THUMBS_KEY = 'ytms:thumbs';
  const WATCH_LATER = 'WL';
  const SETTINGS = window.YTMS_SETTINGS; // from settings.js
  const ICONS = {
    grid: 'M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm13-2h2v3h3v2h-3v3h-2v-3h-3v-2h3v-3z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z',
    plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    playlist: 'M3 10h11v2H3v-2zm0-4h11v2H3V6zm0 8h7v2H3v-2zm13-1v8l6-4-6-4z',
    image: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
  };
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  // ---------- settings (chrome.storage.sync, relayed by bridge.js because MAIN world can't reach it) ----------

  const getSettings = () => {
    try {
      return SETTINGS.normalize(JSON.parse(document.documentElement.getAttribute(SETTINGS.ATTR)));
    } catch {
      return SETTINGS.normalize(null);
    }
  };

  function saveSettings(patch) {
    const next = { ...getSettings(), ...patch };
    document.documentElement.setAttribute(SETTINGS.ATTR, JSON.stringify(next)); // apply now, bridge persists it
    window.postMessage({ ytms: 'save-settings', settings: next }, location.origin);
  }

  // Changes from the popup (or another tab) arrive as attribute updates from the bridge.
  const settingsListeners = new Set();
  new MutationObserver(() => {
    const s = getSettings();
    for (const fn of settingsListeners) fn(s);
  }).observe(document.documentElement, { attributes: true, attributeFilter: [SETTINGS.ATTR] });

  // ---------- cache (youtube.com's localStorage) ----------

  function readStore(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage blocked; it just won't persist
    }
  }

  // Playlist id -> cover URL, so covers show instantly next time while fresh ones load.
  let thumbCache = new Map(Object.entries(readStore(THUMBS_KEY) || {}));

  // ---------- InnerTube ----------

  const cfg = (key) => window.ytcfg?.get?.(key) ?? window.ytcfg?.data_?.[key];

  function getCookie(name) {
    const prefix = `${name}=`;
    return document.cookie.split('; ').find((c) => c.startsWith(prefix))?.slice(prefix.length) ?? null;
  }

  async function sha1Hex(text) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Same scheme YouTube's web client uses: SHA1("<ts> <SAPISID> <origin>") per cookie variant.
  async function authHeader() {
    const ts = Math.floor(Date.now() / 1000);
    const parts = [];
    for (const [cookie, label] of [
      ['SAPISID', 'SAPISIDHASH'],
      ['__Secure-1PAPISID', 'SAPISID1PHASH'],
      ['__Secure-3PAPISID', 'SAPISID3PHASH'],
    ]) {
      const value = getCookie(cookie);
      if (value) parts.push(`${label} ${ts}_${await sha1Hex(`${ts} ${value} ${location.origin}`)}`);
    }
    return parts.join(' ');
  }

  async function innertube(path, body) {
    const context = cfg('INNERTUBE_CONTEXT');
    if (!context) throw new Error('YouTube is not ready yet, try reloading the page');

    const headers = {
      'Content-Type': 'application/json',
      'X-Origin': location.origin,
      'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0),
      'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1),
      'X-Youtube-Client-Version': String(cfg('INNERTUBE_CLIENT_VERSION') ?? context.client?.clientVersion ?? ''),
    };
    const auth = await authHeader();
    if (auth) headers.Authorization = auth;
    const pageId = cfg('DELEGATED_SESSION_ID'); // set when acting as a brand account
    if (pageId) headers['X-Goog-PageId'] = pageId;
    const visitor = cfg('VISITOR_DATA');
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;

    const key = cfg('INNERTUBE_API_KEY');
    const url = `/youtubei/v1/${path}?prettyPrint=false${key ? `&key=${encodeURIComponent(key)}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context, ...body }),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // empty or non-JSON body
    }
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
    return json ?? {};
  }

  // ---------- parsing the get_add_to_playlist response ----------
  // YouTube has served two shapes: the classic `playlistAddToOptionRenderer` list, and newer
  // `toggleableListItemViewModel` / `listItemViewModel` items. Both are handled; the newer one
  // is read defensively because its exact layout isn't documented anywhere.

  // Depth-first walk; returning false from `visit` skips that node's children.
  function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (visit(node) === false) return;
    for (const child of Array.isArray(node) ? node : Object.values(node)) walk(child, visit);
  }

  function findNode(root, pred) {
    let hit = null;
    walk(root, (n) => {
      if (hit) return false;
      if (!pred(n)) return undefined;
      hit = n;
      return false;
    });
    return hit;
  }

  // First image under `node`, at a size that stays sharp in an 80×45 slot on hi-DPI screens.
  function pickImage(node) {
    const hasUrl = (list) => Array.isArray(list) && list.some((s) => s?.url);
    const holder = findNode(node, (n) => hasUrl(n.sources) || hasUrl(n.thumbnails));
    if (!holder) return null;
    const list = (hasUrl(holder.sources) ? holder.sources : holder.thumbnails)
      .filter((s) => s?.url)
      .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
    const { url } = list.find((s) => (s.width ?? 0) >= 160) ?? list[list.length - 1];
    return url.startsWith('//') ? `https:${url}` : url;
  }

  function textOf(t) {
    if (!t) return '';
    if (typeof t === 'string') return t;
    return t.simpleText ?? t.content ?? t.runs?.map((r) => r.text).join('') ?? '';
  }

  function privacyLabel(value) {
    const v = String(value || '').replace(/^PRIVACY_/, '').toLowerCase();
    return ['private', 'public', 'unlisted'].includes(v) ? v[0].toUpperCase() + v.slice(1) : '';
  }

  const isAddEdit = (ep) => ep?.actions?.some((a) => a.action === 'ACTION_ADD_VIDEO');
  const isRemoveEdit = (ep) => ep?.actions?.some((a) => a.action?.startsWith('ACTION_REMOVE_VIDEO'));

  function fromLegacy(r) {
    return {
      id: r.playlistId,
      title: textOf(r.title) || r.playlistId,
      privacy: privacyLabel(r.privacy || r.privacyIcon?.iconType),
      inPlaylist: r.containsSelectedVideos === 'ALL',
      thumb: null, // this format has no covers; they come from fetchThumbnails()
      addEndpoint: r.addToPlaylistServiceEndpoint?.playlistEditEndpoint,
      removeEndpoint: r.removeFromPlaylistServiceEndpoint?.playlistEditEndpoint,
    };
  }

  function fromViewModel(vm) {
    const edits = [];
    let title = '';
    let subtitle = '';
    let flag;
    walk(vm, (n) => {
      if (n.playlistEditEndpoint) edits.push(n.playlistEditEndpoint);
      if (!title && n.title) title = textOf(n.title);
      if (!subtitle && n.subtitle) subtitle = textOf(n.subtitle);
      if (flag === undefined) {
        flag = [n.isToggled, n.isSelected, n.toggled, n.selected].find((v) => typeof v === 'boolean');
      }
    });
    const id = edits.find((e) => e.playlistId)?.playlistId;
    if (!id) return null; // e.g. the "New playlist" row
    return {
      id,
      title: title || id,
      privacy: privacyLabel(subtitle) || subtitle,
      // No explicit flag: the first action offered tells us the current state.
      inPlaylist: flag ?? isRemoveEdit(edits[0]),
      thumb: pickImage(vm),
      addEndpoint: edits.find(isAddEdit),
      removeEndpoint: edits.find(isRemoveEdit),
    };
  }

  function parsePlaylists(json) {
    const byId = new Map();
    walk(json, (n) => {
      let p;
      if (n.playlistAddToOptionRenderer) p = fromLegacy(n.playlistAddToOptionRenderer);
      else if (n.toggleableListItemViewModel) p = fromViewModel(n.toggleableListItemViewModel);
      else if (n.listItemViewModel) p = fromViewModel(n.listItemViewModel);
      else return undefined;
      if (p?.id && !byId.has(p.id)) byId.set(p.id, { ...p, index: byId.size, pending: null, status: null });
      return false;
    });
    return [...byId.values()];
  }

  // ---------- API ----------

  async function fetchPlaylists(videoId) {
    if (cfg('LOGGED_IN') === false) throw new Error('you need to be signed in to YouTube');
    const json = await innertube('playlist/get_add_to_playlist', { videoIds: [videoId], excludeWatchLater: false });
    const list = parsePlaylists(json);
    if (!list.length) {
      console.warn('[Playlist Multi-Save] No playlists found in response:', json);
      throw new Error("YouTube answered in a format this extension doesn't recognise (response logged to the console)");
    }
    return list;
  }

  async function editPlaylist(p, videoId, add) {
    // Prefer the exact endpoint YouTube handed us; fall back to building it.
    const ep = (add ? p.addEndpoint : p.removeEndpoint) ?? {
      playlistId: p.id,
      actions: [
        add
          ? { action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }
          : { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId },
      ],
    };
    const json = await innertube('browse/edit_playlist', {
      playlistId: ep.playlistId ?? p.id,
      actions: ep.actions,
      ...(ep.params && { params: ep.params }),
    });
    if (json.status && json.status !== 'STATUS_SUCCEEDED') throw new Error(json.status.replace(/^STATUS_/, '').toLowerCase());
  }

  // The Save dialog's data has no playlist covers, so read them from the library's
  // Playlists page (youtube.com/feed/playlists), following its "load more" pages.
  async function fetchThumbnails() {
    const thumbs = new Map();
    const seen = new Set();
    let json = await innertube('browse', { browseId: 'FEplaylist_aggregation' });
    for (let page = 0; json && page < 30; page++) {
      collectThumbnails(json, thumbs);
      const token = findContinuation(json);
      if (!token || seen.has(token)) break;
      seen.add(token);
      json = await innertube('browse', { continuation: token });
    }
    return thumbs;
  }

  function collectThumbnails(json, out) {
    walk(json, (n) => {
      const lockup = n.lockupViewModel;
      const renderer = n.gridPlaylistRenderer ?? n.playlistRenderer;
      const id = lockup?.contentId ?? renderer?.playlistId;
      if (!id) return undefined;
      const url = pickImage(lockup ? lockup.contentImage ?? lockup : renderer.thumbnailRenderer ?? renderer.thumbnail ?? renderer);
      if (url) out.set(id.replace(/^VL(?=..)/, ''), url);
      return false;
    });
  }

  // Only "load more" items count; sort chips etc. also carry continuation tokens.
  function findContinuation(json) {
    const item = findNode(json, (n) => n.continuationItemRenderer || n.nextContinuationData);
    if (!item) return null;
    if (item.nextContinuationData) return item.nextContinuationData.continuation ?? null;
    return findNode(item.continuationItemRenderer, (n) => n.continuationCommand?.token)?.continuationCommand.token ?? null;
  }

  async function createPlaylist(title, privacyStatus, videoId) {
    const json = await innertube('playlist/create', { title, privacyStatus, videoIds: [videoId] });
    if (!json.playlistId) throw new Error('YouTube did not return the new playlist');
    return json.playlistId;
  }

  // ---------- DOM helpers ----------

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    el.append(...children.flat().filter((c) => c != null && c !== false));
    return el;
  }

  function icon(d) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }

  // A spinning ring in the text colour. Buttons show theirs while they're working (.is-busy),
  // tiles while their playlist is being changed.
  const spinner = () => h('span', { class: 'ytms-spinner', 'aria-hidden': 'true' });

  function toast(text) {
    let el = document.getElementById('ytms-toast');
    if (!el) {
      el = h('div', { id: 'ytms-toast', role: 'status' });
      document.body.append(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function describeChanges(added, removed) {
    const text = [added && `added to ${plural(added, 'playlist')}`, removed && `removed from ${plural(removed, 'playlist')}`]
      .filter(Boolean)
      .join(', ');
    return text[0].toUpperCase() + text.slice(1);
  }

  async function runPool(items, limit, fn) {
    const queue = [...items];
    const worker = async () => {
      while (queue.length) await fn(queue.shift());
    };
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  }

  function sortPlaylists(list, sort) {
    const cmp =
      sort === 'az' ? (a, b) => collator.compare(a.title, b.title)
      : sort === 'za' ? (a, b) => collator.compare(b.title, a.title)
      : (a, b) => a.index - b.index; // YouTube's own order: most recently saved-to first
    // Watch Later stays pinned first, like in YouTube's dialog.
    return [...list].sort((a, b) => (b.id === WATCH_LATER) - (a.id === WATCH_LATER) || cmp(a, b));
  }

  function currentVideoId() {
    if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v');
    return location.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1] ?? null;
  }

  function currentVideoTitle() {
    const el = document.querySelector('ytd-watch-metadata #title h1');
    return el?.textContent.trim() || document.title.replace(/ - YouTube$/, '');
  }

  // Our own dark-mode switch (html.ytms-dark), since YouTube's theme hooks keep changing:
  // trust <html dark> when present, otherwise look at the page's actual background colour.
  function syncTheme() {
    document.documentElement.classList.toggle('ytms-dark', isDarkTheme());
  }

  function isDarkTheme() {
    if (document.documentElement.hasAttribute('dark')) return true;
    for (const el of [document.querySelector('ytd-app'), document.body]) {
      if (!el) continue;
      const [r, g, b, a = 1] = (getComputedStyle(el).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
      if (r !== undefined && a > 0) return 0.299 * r + 0.587 * g + 0.114 * b < 128;
    }
    return false;
  }

  // ---------- the dialog ----------

  function openModal() {
    const videoId = currentVideoId();
    if (!videoId) {
      toast('Open a video first');
      return;
    }
    if (document.getElementById(ROOT_ID)) return;
    syncTheme();

    const state = {
      playlists: [],
      query: '',
      settings: null, // set by applySettings()
      loaded: false,
      busy: false,
      needCovers: false, // the dialog data lacked covers, so fetch them from the library
      coversRequested: false,
    };
    const prevFocus = document.activeElement;

    const desired = (p) => (p.pending ? p.pending === 'add' : p.inPlaylist);
    const pendingCount = () => state.playlists.filter((p) => p.pending).length;

    // header
    const search = h('input', {
      class: 'ytms-field ytms-grow',
      type: 'search',
      placeholder: 'Search playlists…',
      'aria-label': 'Search playlists',
      autocomplete: 'off',
      oninput: () => {
        state.query = search.value.trim().toLowerCase();
        if (state.loaded) layout();
      },
    });
    // View controls only save; applySettings() reacts, same as for changes made in the popup.
    const settingSelect = (label, key, format) => {
      const el = h(
        'select',
        { class: 'ytms-field', 'aria-label': label, onchange: () => saveSettings({ [key]: el.value }) },
        SETTINGS.OPTIONS[key].map(([value, text]) => h('option', { value }, format(value, text))),
      );
      return el;
    };
    const sortSelect = settingSelect('Sort playlists', 'sort', (v, text) => text);
    const columnsSelect = settingSelect('Columns', 'columns', (v) => (v === 'auto' ? 'Auto columns' : `${v} columns`));
    const sizeSelect = settingSelect('Card size', 'size', (v, text) => `${text} cards`);
    const thumbsToggle = h(
      'button',
      { class: 'ytms-btn ytms-toggle', type: 'button', onclick: () => saveSettings({ thumbnails: !state.settings.thumbnails }) },
      icon(ICONS.image),
      'Thumbnails',
    );

    const createName = h('input', {
      class: 'ytms-field ytms-grow',
      placeholder: 'New playlist name',
      'aria-label': 'New playlist name',
      maxlength: '150',
      autocomplete: 'off',
    });
    const createPrivacy = h(
      'select',
      { class: 'ytms-field', 'aria-label': 'New playlist visibility' },
      ['PRIVATE', 'UNLISTED', 'PUBLIC'].map((v) => h('option', { value: v }, privacyLabel(v))),
    );
    const createLabel = h('span', {}, 'Create & save');
    const createGo = h('button', { class: 'ytms-btn ytms-primary', type: 'button', onclick: () => doCreate() }, spinner(), createLabel);
    const createError = h('div', { class: 'ytms-create-error', hidden: true });
    const createRow = h(
      'div',
      { class: 'ytms-create', hidden: true },
      h('div', { class: 'ytms-row' }, createName, createPrivacy, createGo,
        h('button', { class: 'ytms-btn', type: 'button', onclick: () => hideCreate() }, 'Cancel')),
      createError,
    );

    // body
    const grid = h('div', { class: 'ytms-grid', role: 'group', 'aria-label': 'Playlists' });
    const message = h('div', { class: 'ytms-message is-loading' }, 'Loading your playlists…');

    // footer
    const counts = h('span', { class: 'ytms-counts' });
    const summary = h('span', { class: 'ytms-summary', 'aria-live': 'polite' });
    const saveLabel = h('span', {}, 'Save');
    const saveBtn = h('button', { class: 'ytms-btn ytms-primary', type: 'button', disabled: true, onclick: () => apply() }, spinner(), saveLabel);
    const cancelBtn = h('button', { class: 'ytms-btn', type: 'button', onclick: () => close() }, 'Cancel');
    const newBtn = h('button', { class: 'ytms-btn', type: 'button', disabled: true, onclick: () => showCreate() }, icon(ICONS.plus), 'New playlist');
    // While saving: a bar along the top of the footer that fills as each change is done.
    const progressFill = h('span');
    const progress = h('div', { class: 'ytms-progress', role: 'progressbar', 'aria-label': 'Saving', 'aria-valuemin': '0', hidden: true }, progressFill);

    const dialog = h(
      'div',
      { class: 'ytms-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ytms-heading' },
      h(
        'div',
        { class: 'ytms-head' },
        h('div', { class: 'ytms-row' },
          h('h2', { id: 'ytms-heading' }, 'Save to playlists'),
          h('button', { class: 'ytms-btn ytms-icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => requestClose() }, icon(ICONS.close))),
        h('div', { class: 'ytms-video' }, currentVideoTitle()),
        h('div', { class: 'ytms-row' }, search, sortSelect, columnsSelect, sizeSelect, thumbsToggle),
        createRow,
      ),
      h('div', { class: 'ytms-body' }, message, grid),
      h(
        'div',
        { class: 'ytms-foot' },
        progress,
        newBtn,
        counts,
        h('span', { class: 'ytms-hint' }, 'Enter toggles the top match · Ctrl+Enter saves'),
        h('span', { class: 'ytms-spacer' }),
        summary,
        cancelBtn,
        saveBtn,
      ),
    );

    const root = h('div', { id: ROOT_ID }, dialog);
    // Close on backdrop press (mousedown, so a drag that ends outside the dialog doesn't close it).
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) requestClose();
    });
    // Keep YouTube's hotkeys (k, j, l, f, m, space, numbers…) from firing while the dialog has focus.
    root.addEventListener('keydown', onKey);
    root.addEventListener('keyup', (e) => e.stopPropagation());
    root.addEventListener('keypress', (e) => e.stopPropagation());

    applySettings(getSettings());
    settingsListeners.add(applySettings);
    document.body.append(root);
    document.documentElement.classList.add('ytms-lock');
    search.focus();

    fetchPlaylists(videoId).then(
      (list) => {
        if (!root.isConnected) return;
        message.classList.remove('is-loading');
        state.playlists = list;
        state.loaded = true;
        state.needCovers = list.some((p) => !p.thumb);
        for (const p of list) makeTile(p);
        layout();
        updateFooter();
        if (state.settings.thumbnails) loadCovers();
      },
      (err) => {
        if (!root.isConnected) return;
        message.classList.remove('is-loading');
        message.textContent = `Couldn't load your playlists: ${err.message}`;
        message.classList.add('is-error');
      },
    );

    function makeTile(p) {
      p.metaEl = h('span', { class: 'ytms-tile-meta' });
      p.imgEl = h('img', {
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        onload: () => p.imgEl.classList.add('is-loaded'),
        onerror: () => p.imgEl.classList.remove('is-loaded'),
      });
      if (p.thumb) p.imgEl.src = p.thumb;
      p.el = h(
        'button',
        { class: 'ytms-tile', type: 'button', role: 'checkbox', title: p.title, onclick: () => toggle(p) },
        h('span', { class: 'ytms-thumb' }, icon(ICONS.playlist), p.imgEl, h('span', { class: 'ytms-check' }, icon(ICONS.check)), spinner()),
        h('span', { class: 'ytms-tile-text' }, h('span', { class: 'ytms-tile-title' }, p.title), p.metaEl),
      );
      updateTile(p);
    }

    function applySettings(s) {
      const resort = s.sort !== state.settings?.sort;
      state.settings = s;
      sortSelect.value = s.sort;
      columnsSelect.value = s.columns;
      sizeSelect.value = s.size;
      thumbsToggle.setAttribute('aria-pressed', String(s.thumbnails));
      thumbsToggle.title = s.thumbnails ? 'Hide playlist thumbnails' : 'Show playlist thumbnails';
      dialog.dataset.size = s.size;
      dialog.dataset.columns = s.columns;
      dialog.style.setProperty('--cols', s.columns === 'auto' ? '' : s.columns);
      dialog.classList.toggle('no-thumbs', !s.thumbnails);
      if (!state.loaded) return;
      if (resort) layout();
      if (s.thumbnails) loadCovers();
    }

    // Covers load only while thumbnails are switched on, and at most once per dialog.
    function loadCovers() {
      if (state.coversRequested) return;
      state.coversRequested = true;
      showThumbs(thumbCache);
      if (!state.needCovers) return;
      fetchThumbnails().then(
        (thumbs) => {
          if (!thumbs.size) return;
          thumbCache = thumbs;
          writeStore(THUMBS_KEY, Object.fromEntries(thumbs));
          if (root.isConnected) showThumbs(thumbs);
        },
        (err) => console.debug('[Playlist Multi-Save] Could not load playlist covers:', err),
      );
    }

    function showThumbs(thumbs) {
      for (const p of state.playlists) {
        const url = thumbs.get(p.id);
        if (url && url !== p.thumb) {
          p.thumb = url;
          p.imgEl.src = url;
        }
      }
    }

    function updateTile(p) {
      const on = desired(p);
      const el = p.el;
      el.setAttribute('aria-checked', String(on));
      el.classList.toggle('is-on', on);
      el.classList.toggle('will-add', p.pending === 'add');
      el.classList.toggle('will-remove', p.pending === 'remove');
      // While saving, each change is queued (waiting for its turn), busy (being sent) or done.
      el.classList.toggle('is-queued', p.status === 'queued');
      el.classList.toggle('is-busy', p.status === 'busy');
      el.classList.toggle('is-done', p.status === 'done');
      el.classList.toggle('is-error', p.status === 'error');
      el.disabled = state.busy;
      const meta =
        p.status === 'queued' ? 'Waiting…'
        : p.status === 'busy' ? (p.pending === 'add' ? 'Adding…' : 'Removing…')
        : p.status === 'done' ? (p.inPlaylist ? 'Added' : 'Removed')
        : p.status === 'error' ? `Failed: ${p.error}`
        : p.pending === 'add' ? 'Will be added'
        : p.pending === 'remove' ? 'Will be removed'
        : p.privacy;
      p.metaEl.textContent = meta;
      p.metaEl.hidden = !meta;
    }

    function toggle(p) {
      if (state.busy) return;
      p.pending = p.pending ? null : p.inPlaylist ? 'remove' : 'add';
      if (p.status === 'error') p.status = null;
      updateTile(p);
      updateFooter();
    }

    function layout() {
      const list = sortPlaylists(state.playlists, state.settings.sort);
      let shown = 0;
      for (const p of list) {
        p.el.hidden = Boolean(state.query) && !p.title.toLowerCase().includes(state.query);
        if (!p.el.hidden) shown++;
      }
      grid.append(...list.map((p) => p.el));
      message.hidden = shown > 0;
      if (!shown) message.textContent = `No playlists match “${search.value.trim()}”`;
    }

    function updateFooter(note) {
      const added = state.playlists.filter((p) => p.pending === 'add').length;
      const removed = state.playlists.filter((p) => p.pending === 'remove').length;
      const savedIn = state.playlists.filter((p) => p.inPlaylist).length;
      counts.textContent = state.loaded ? `${plural(state.playlists.length, 'playlist')} · saved in ${savedIn}` : '';
      if (state.busy) {
        const { done, total } = state.progress;
        summary.textContent = total > 1 ? `${done} of ${total} done` : '';
        progressFill.style.width = `${(done / total) * 100}%`;
        progress.setAttribute('aria-valuemax', String(total));
        progress.setAttribute('aria-valuenow', String(done));
      } else {
        summary.textContent =
          note ?? [added && `+${added} to add`, removed && `−${removed} to remove`].filter(Boolean).join(' · ');
      }
      summary.classList.toggle('is-error', Boolean(note) && !state.busy);
      progress.hidden = !state.busy;
      dialog.classList.toggle('is-busy', state.busy);
      saveBtn.classList.toggle('is-busy', state.busy);
      saveBtn.disabled = state.busy || added + removed === 0;
      saveLabel.textContent = state.busy ? 'Saving…' : 'Save';
      cancelBtn.disabled = state.busy;
      newBtn.disabled = state.busy || !state.loaded;
    }

    function refresh(note) {
      for (const p of state.playlists) updateTile(p);
      updateFooter(note);
    }

    async function apply() {
      const changes = state.playlists.filter((p) => p.pending);
      if (!changes.length || state.busy) return;
      const added = changes.filter((p) => p.pending === 'add').length;
      state.busy = true;
      state.progress = { done: 0, total: changes.length };
      for (const p of changes) p.status = 'queued';
      refresh();

      await runPool(changes, 3, async (p) => {
        const add = p.pending === 'add';
        p.status = 'busy';
        updateTile(p);
        try {
          await editPlaylist(p, videoId, add);
          p.inPlaylist = add;
          p.pending = null;
          p.status = 'done';
        } catch (err) {
          p.status = 'error';
          p.error = err.message;
        }
        state.progress.done++;
        updateTile(p);
        updateFooter();
      });

      const failed = changes.filter((p) => p.status === 'error').length;
      // Leave the finished state (full bar, every tile "Added" / "Removed") up for a moment.
      if (!failed) await new Promise((resolve) => setTimeout(resolve, 400));
      state.busy = false;
      for (const p of changes) if (p.status === 'done') p.status = null;
      if (!failed) {
        close();
        toast(describeChanges(added, changes.length - added));
        return;
      }
      refresh(`${failed} of ${plural(changes.length, 'change')} failed. Press Save to retry`);
    }

    function showCreate() {
      createRow.hidden = false;
      createError.hidden = true;
      createName.value = search.value.trim();
      createName.focus();
    }

    function hideCreate() {
      createRow.hidden = true;
      search.focus();
    }

    async function doCreate() {
      const title = createName.value.trim();
      if (!title) {
        createName.focus();
        return;
      }
      createGo.disabled = true;
      createGo.classList.add('is-busy');
      createLabel.textContent = 'Creating…';
      createError.hidden = true;
      try {
        const id = await createPlaylist(title, createPrivacy.value, videoId);
        const p = {
          id,
          title,
          privacy: privacyLabel(createPrivacy.value),
          inPlaylist: true,
          thumb: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, // its only video is this one
          pending: null,
          status: null,
          index: Math.min(0, ...state.playlists.map((x) => x.index)) - 1, // newest = most recent
        };
        state.playlists.push(p);
        makeTile(p);
        layout();
        updateFooter();
        createRow.hidden = true;
        toast(`Created “${title}” and saved the video to it`);
        p.el.focus();
      } catch (err) {
        createError.textContent = `Couldn't create the playlist: ${err.message}`;
        createError.hidden = false;
      } finally {
        createGo.disabled = false;
        createGo.classList.remove('is-busy');
        createLabel.textContent = 'Create & save';
      }
    }

    // Backdrop, ✕ and Esc. (The Cancel button always discards.)
    function requestClose() {
      if (state.busy) return;
      const n = pendingCount();
      if (n && !state.settings.confirmDiscard) {
        apply(); // closes when everything saved; stays open showing any failures
        return;
      }
      if (n && !window.confirm(`Discard ${plural(n, 'unsaved change')}?`)) return;
      close();
    }

    function close() {
      if (state.busy) return;
      settingsListeners.delete(applySettings);
      root.remove();
      document.documentElement.classList.remove('ytms-lock');
      prevFocus?.focus?.();
    }

    function onKey(e) {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (e.target === search && search.value) {
          search.value = '';
          search.dispatchEvent(new Event('input'));
        } else if (!createRow.hidden) {
          hideCreate();
        } else {
          requestClose();
        }
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        apply();
      } else if (e.key === 'Enter' && e.target === createName) {
        e.preventDefault();
        doCreate();
      } else if (e.key === 'Enter' && e.target === search && state.query) {
        e.preventDefault();
        grid.querySelector('.ytms-tile:not([hidden])')?.click();
      }
    }
  }

  // ---------- the "Save+" button under the video ----------

  // The visible watch-page metadata; YouTube can keep hidden copies around for other layouts.
  function watchMetadata() {
    return [...document.querySelectorAll('ytd-watch-metadata')].find((el) => el.getClientRects().length) ?? null;
  }

  // The button belongs in the row of main action buttons (where Like/Dislike lives).
  // While YouTube is still building that row there is no slot, and we wait rather than
  // fall back to a parent container, where the button would stretch across the page.
  function buttonSlot(meta) {
    const row = meta.querySelector('#top-level-buttons-computed');
    if (row) return { into: row };
    const like = meta.querySelector('segmented-like-dislike-button-view-model, ytd-segmented-like-dislike-button-renderer');
    return like ? { after: like } : null;
  }

  function ensureButton() {
    syncTheme();
    let btn = document.getElementById(BTN_ID);
    const meta = location.pathname === '/watch' ? watchMetadata() : null;
    if (!meta) {
      btn?.remove();
      return;
    }
    const slot = buttonSlot(meta);
    if (!slot) return;
    if (!btn) {
      btn = h(
        'button',
        { id: BTN_ID, type: 'button', title: 'Save to multiple playlists', 'aria-label': 'Save to multiple playlists', onclick: () => openModal() },
        icon(ICONS.grid),
        h('span', {}, 'Save+'),
      );
    }
    // Also moves a button that YouTube's re-rendering left somewhere else.
    if (slot.into && btn.parentElement !== slot.into) slot.into.append(btn);
    if (slot.after && btn.previousElementSibling !== slot.after) slot.after.after(btn);
    // Match the height of YouTube's own action buttons, which differs between layouts.
    if (!btn.style.getPropertyValue('--ytms-h')) {
      const height = meta.querySelector(`#actions button:not(#${BTN_ID})`)?.offsetHeight;
      if (height >= 28 && height <= 56) btn.style.setProperty('--ytms-h', `${height}px`);
    }
  }

  // ---------- styles ----------

  const CSS = `
#${BTN_ID} {
  /* !important where YouTube's layout rules for the row's children could stretch or hide us */
  display: inline-flex !important; flex: none !important; width: auto !important; max-width: max-content !important;
  align-self: center !important; justify-self: start !important;
  align-items: center; justify-content: center; gap: 6px;
  box-sizing: border-box; height: var(--ytms-h, 36px); margin: 0 0 0 8px; padding: 0 16px 0 12px;
  border: 0; border-radius: 999px; cursor: pointer; white-space: nowrap; vertical-align: middle;
  background: rgba(0,0,0,.05); color: #0f0f0f;
  font: 500 14px/1 Roboto, Arial, sans-serif;
}
#${BTN_ID}:hover { background: rgba(0,0,0,.1); }
html.ytms-dark #${BTN_ID} { background: rgba(255,255,255,.1); color: #f1f1f1; }
html.ytms-dark #${BTN_ID}:hover { background: rgba(255,255,255,.2); }
#${BTN_ID} svg { width: 24px; height: 24px; fill: currentColor; }

#ytms-toast {
  position: fixed; left: 50%; bottom: 24px; z-index: 2147483001;
  transform: translate(-50%, 16px); opacity: 0; pointer-events: none;
  transition: opacity .2s, transform .2s;
  max-width: calc(100vw - 32px); padding: 12px 16px; border-radius: 8px;
  background: #0f0f0f; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.3);
  font: 400 14px/20px Roboto, Arial, sans-serif;
}
html.ytms-dark #ytms-toast { background: #f1f1f1; color: #0f0f0f; }
#ytms-toast.show { opacity: 1; transform: translate(-50%, 0); }

html.ytms-lock, html.ytms-lock body { overflow: hidden !important; }

#${ROOT_ID} {
  --bg: #fff; --fg: #0f0f0f; --muted: #606060; --line: rgba(0,0,0,.1); --field: #fff; --field-line: rgba(0,0,0,.2);
  --tile: #f2f2f2; --tile-hover: #e5e5e5; --thumb: rgba(0,0,0,.08);
  --accent: #065fd4; --on-accent: #fff; --accent-bg: rgba(6,95,212,.1);
  --danger: #cc0000;
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; align-items: center; justify-content: center;
  padding: 24px; box-sizing: border-box; background: rgba(0,0,0,.55);
  font: 400 14px/20px Roboto, Arial, sans-serif; color: var(--fg);
}
html.ytms-dark #${ROOT_ID} {
  --bg: #212121; --fg: #f1f1f1; --muted: #aaa; --line: rgba(255,255,255,.1); --field: #121212; --field-line: rgba(255,255,255,.2);
  --tile: #2e2e2e; --tile-hover: #3a3a3a; --thumb: rgba(255,255,255,.08);
  --accent: #3ea6ff; --on-accent: #0f0f0f; --accent-bg: rgba(62,166,255,.16);
  --danger: #ff6b6b;
}
#${ROOT_ID} *, #${ROOT_ID} *::before, #${ROOT_ID} *::after { box-sizing: border-box; }
#${ROOT_ID} [hidden] { display: none !important; }
#${ROOT_ID} svg { width: 20px; height: 20px; fill: currentColor; flex: none; }

#${ROOT_ID} .ytms-dialog {
  --tile-min: 210px; --tile-pad: 10px; --thumb-w: 80px; --thumb-h: 45px; --check: 18px; --title-size: 14px; --meta-size: 12px;
  display: flex; flex-direction: column; width: min(1320px, 100%); max-height: 100%;
  background: var(--bg); border-radius: 12px; overflow: hidden; box-shadow: 0 16px 48px rgba(0,0,0,.4);
}
#${ROOT_ID} .ytms-dialog[data-size="small"] {
  --tile-min: 170px; --tile-pad: 7px; --thumb-w: 56px; --thumb-h: 32px; --check: 14px; --title-size: 13px; --meta-size: 11px;
}
#${ROOT_ID} .ytms-dialog[data-size="large"] {
  --tile-min: 280px; --tile-pad: 12px; --thumb-w: 120px; --thumb-h: 68px; --title-size: 15px; --meta-size: 13px;
}
/* A fixed column count sizes the dialog to fit that many cards of the chosen size. */
#${ROOT_ID} .ytms-dialog:not([data-columns="auto"]) { width: min(calc(var(--cols) * (var(--tile-min) + 48px) + 40px), 100%); }
#${ROOT_ID} .ytms-head { display: flex; flex-direction: column; gap: 10px; padding: 16px 20px 14px; border-bottom: 1px solid var(--line); }
#${ROOT_ID} .ytms-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
#${ROOT_ID} h2 { flex: 1; margin: 0; font-size: 18px; line-height: 24px; font-weight: 600; color: var(--fg); }
#${ROOT_ID} .ytms-video { margin-top: -8px; color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

#${ROOT_ID} .ytms-field {
  height: 36px; padding: 0 12px; border: 1px solid var(--field-line); border-radius: 8px;
  background: var(--field); color: var(--fg); font: inherit; outline: none;
}
#${ROOT_ID} select.ytms-field { padding: 0 8px; cursor: pointer; }
#${ROOT_ID} .ytms-field:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
#${ROOT_ID} .ytms-grow { flex: 1 1 240px; min-width: 0; }
#${ROOT_ID} .ytms-create { display: flex; flex-direction: column; gap: 6px; }
#${ROOT_ID} .ytms-create-error { color: var(--danger); font-size: 13px; }

#${ROOT_ID} .ytms-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 36px; padding: 0 16px; border: 0; border-radius: 18px; cursor: pointer; white-space: nowrap;
  background: var(--tile); color: var(--fg); font: 500 14px/36px Roboto, Arial, sans-serif;
}
#${ROOT_ID} .ytms-btn:hover { background: var(--tile-hover); }
#${ROOT_ID} .ytms-btn.ytms-primary { background: var(--accent); color: var(--on-accent); }
#${ROOT_ID} .ytms-btn.ytms-primary:hover { filter: brightness(1.08); }
#${ROOT_ID} .ytms-btn:disabled { opacity: .45; cursor: default; filter: none; }
#${ROOT_ID} .ytms-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
#${ROOT_ID} .ytms-icon-btn { width: 36px; padding: 0; background: transparent; }
#${ROOT_ID} .ytms-icon-btn svg { width: 24px; height: 24px; }
#${ROOT_ID} .ytms-btn.ytms-toggle {
  padding: 0 12px; border: 1px solid var(--field-line); border-radius: 8px;
  background: var(--field); color: var(--muted); font-weight: 400;
}
#${ROOT_ID} .ytms-btn.ytms-toggle[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-bg); color: var(--fg); }
#${ROOT_ID} .ytms-toggle[aria-pressed="true"] svg { color: var(--accent); }

#${ROOT_ID} .ytms-body { flex: 1; min-height: 140px; overflow-y: auto; overscroll-behavior: contain; padding: 16px 20px; }
#${ROOT_ID} .ytms-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--tile-min), 1fr)); gap: 8px; }
#${ROOT_ID} .ytms-dialog:not([data-columns="auto"]) .ytms-grid { grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); }
#${ROOT_ID} .ytms-message { padding: 32px 0; text-align: center; color: var(--muted); }
#${ROOT_ID} .ytms-message.is-error { color: var(--danger); }

#${ROOT_ID} .ytms-tile {
  display: flex; align-items: center; gap: calc(var(--tile-pad) + 2px);
  min-height: calc(var(--thumb-h) + 2 * var(--tile-pad) + 2px); padding: var(--tile-pad);
  border: 1px solid transparent; border-radius: 10px; cursor: pointer; text-align: left;
  background: var(--tile); color: var(--fg); font: inherit;
  transition: background .12s, border-color .12s;
}
#${ROOT_ID} .ytms-tile:hover { background: var(--tile-hover); }
#${ROOT_ID} .ytms-tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
#${ROOT_ID} .ytms-tile:disabled { cursor: default; }
#${ROOT_ID} .ytms-tile.is-on { background: var(--accent-bg); }
#${ROOT_ID} .ytms-tile.will-add { border-color: var(--accent); }
#${ROOT_ID} .ytms-tile.will-remove, #${ROOT_ID} .ytms-tile.is-error { border-color: var(--danger); }
#${ROOT_ID} .ytms-tile.will-remove .ytms-tile-title { text-decoration: line-through; opacity: .7; }
#${ROOT_ID} .ytms-tile.is-queued { opacity: .6; }
#${ROOT_ID} .ytms-dialog.is-busy .ytms-tile { cursor: progress; }
#${ROOT_ID} .ytms-thumb {
  position: relative; display: flex; align-items: center; justify-content: center; flex: none;
  width: var(--thumb-w); height: var(--thumb-h); border-radius: 6px; overflow: hidden;
  background: var(--thumb); color: var(--muted);
}
#${ROOT_ID} .ytms-thumb > svg { width: 22px; height: 22px; opacity: .7; }
#${ROOT_ID} .ytms-thumb img {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
  opacity: 0; transition: opacity .15s;
}
#${ROOT_ID} .ytms-thumb img.is-loaded { opacity: 1; }
#${ROOT_ID} .ytms-check {
  position: absolute; top: 4px; left: 4px;
  display: flex; align-items: center; justify-content: center;
  width: var(--check); height: var(--check); border: 2px solid #fff; border-radius: 4px;
  background: rgba(0,0,0,.35); color: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.45);
}
#${ROOT_ID} .ytms-check svg { width: calc(var(--check) - 4px); height: calc(var(--check) - 4px); opacity: 0; }
#${ROOT_ID} .is-on .ytms-check { background: var(--accent); color: var(--on-accent); }
#${ROOT_ID} .is-on .ytms-check svg { opacity: 1; }
#${ROOT_ID} .ytms-tile-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
#${ROOT_ID} .ytms-tile-title {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  font-size: var(--title-size); line-height: 1.4; font-weight: 500; overflow-wrap: anywhere;
}
#${ROOT_ID} .ytms-tile-meta { font-size: var(--meta-size); line-height: 1.35; color: var(--muted); }
#${ROOT_ID} .will-add .ytms-tile-meta, #${ROOT_ID} .is-done .ytms-tile-meta { color: var(--accent); }
#${ROOT_ID} .will-remove .ytms-tile-meta, #${ROOT_ID} .is-error .ytms-tile-meta { color: var(--danger); }

/* Working: spinners on the busy button and over the cover of each playlist being changed. */
@keyframes ytms-spin { to { transform: rotate(360deg); } }
#${ROOT_ID} .ytms-spinner, #${ROOT_ID} .ytms-message.is-loading::before {
  display: block; flex: none; width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid currentColor; border-right-color: transparent;
  animation: ytms-spin .75s linear infinite;
}
#${ROOT_ID} .ytms-message.is-loading::before { content: ''; width: 24px; height: 24px; margin: 0 auto 12px; border-width: 3px; color: var(--accent); }
#${ROOT_ID} .ytms-btn .ytms-spinner { display: none; }
#${ROOT_ID} .ytms-btn.is-busy .ytms-spinner { display: block; }
#${ROOT_ID} .ytms-btn.is-busy:disabled { opacity: 1; cursor: progress; }
#${ROOT_ID} .ytms-thumb .ytms-spinner { display: none; position: absolute; inset: 0; z-index: 1; margin: auto; width: 22px; height: 22px; border-width: 3px; color: #fff; }
#${ROOT_ID} .ytms-tile.is-busy .ytms-thumb .ytms-spinner { display: block; }
#${ROOT_ID} .ytms-tile.is-busy .ytms-thumb::after { content: ''; position: absolute; inset: 0; background: rgba(0,0,0,.5); }
#${ROOT_ID} .ytms-tile.is-busy .ytms-check { visibility: hidden; }
#${ROOT_ID} .ytms-foot { position: relative; }
#${ROOT_ID} .ytms-progress { position: absolute; top: -1px; left: 0; right: 0; height: 3px; background: var(--accent-bg); overflow: hidden; }
#${ROOT_ID} .ytms-progress span { display: block; width: 0; height: 100%; background: var(--accent); transition: width .3s; }
@media (prefers-reduced-motion: reduce) {
  #${ROOT_ID} .ytms-spinner, #${ROOT_ID} .ytms-message.is-loading::before { animation-duration: 1.6s; }
  #${ROOT_ID} .ytms-progress span { transition: none; }
}

/* Thumbnails switched off: plain checkbox in place of the cover. */
#${ROOT_ID} .no-thumbs .ytms-tile { min-height: 0; align-items: flex-start; }
#${ROOT_ID} .no-thumbs .ytms-thumb { width: 20px; height: 20px; background: none; border-radius: 0; overflow: visible; }
#${ROOT_ID} .no-thumbs .ytms-thumb > svg, #${ROOT_ID} .no-thumbs .ytms-thumb img { display: none; }
#${ROOT_ID} .no-thumbs .ytms-check { --check: 20px; position: static; border-color: var(--muted); background: transparent; box-shadow: none; }
#${ROOT_ID} .no-thumbs .is-on .ytms-check { border-color: var(--accent); background: var(--accent); }
#${ROOT_ID} .no-thumbs .ytms-thumb .ytms-spinner { width: 18px; height: 18px; border-width: 2px; color: var(--accent); }
#${ROOT_ID} .no-thumbs .ytms-tile.is-busy .ytms-thumb::after { display: none; }

#${ROOT_ID} .ytms-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 20px; border-top: 1px solid var(--line); }
#${ROOT_ID} .ytms-counts, #${ROOT_ID} .ytms-hint { color: var(--muted); font-size: 13px; }
#${ROOT_ID} .ytms-spacer { flex: 1; }
#${ROOT_ID} .ytms-summary { font-size: 13px; font-weight: 500; }
#${ROOT_ID} .ytms-summary.is-error { color: var(--danger); }

@media (max-width: 900px) { #${ROOT_ID} .ytms-hint { display: none; } }
@media (max-width: 600px) {
  #${ROOT_ID} { padding: 8px; }
  #${ROOT_ID} .ytms-head, #${ROOT_ID} .ytms-body, #${ROOT_ID} .ytms-foot { padding-left: 12px; padding-right: 12px; }
  #${ROOT_ID} .ytms-dialog[data-columns] .ytms-grid { grid-template-columns: 1fr; }
}
`;

  // ---------- boot ----------

  document.head.append(h('style', { id: 'ytms-style' }, CSS));

  // YouTube is a single-page app that re-renders the action bar freely, so keep re-checking.
  let scheduled = false;
  let stopped = false;
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (!stopped) ensureButton();
    }, 300);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('yt-navigate-finish', schedule);
  schedule();

  // The extension was reloaded, updated or switched off (bridge.js noticed). This copy is now
  // outdated, so take the button down; refreshing the tab loads the current version.
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.ytms !== 'stopped') return;
    stopped = true;
    observer.disconnect();
    document.getElementById(BTN_ID)?.remove();
  });
})();
