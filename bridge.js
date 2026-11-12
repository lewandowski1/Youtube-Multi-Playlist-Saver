// Storage bridge. content.js runs in the page's MAIN world, which has no chrome.storage,
// so this isolated-world script relays settings both ways:
//   chrome.storage.sync  ->  <html data-ytms-settings="...">  (content.js watches the attribute)
//   window.postMessage({ ytms: 'save-settings' })  ->  chrome.storage.sync
(() => {
  // The extension API: `browser` in Firefox, `chrome` in Chrome. Both return promises.
  const ext = globalThis.browser ?? globalThis.chrome;
  const { KEY, ATTR, normalize } = globalThis.YTMS_SETTINGS;

  const publish = (settings) => document.documentElement.setAttribute(ATTR, JSON.stringify(normalize(settings)));

  ext.storage.sync.get(KEY).then((stored) => publish(stored[KEY]));
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[KEY]) publish(changes[KEY].newValue);
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || e.data?.ytms !== 'save-settings') return;
    ext.storage.sync.set({ [KEY]: normalize(e.data.settings) });
  });

  // When the extension is reloaded, updated or switched off, Chrome leaves the scripts in open
  // tabs running with the old code. Spot that (the extension APIs go away) and tell content.js.
  const alive = setInterval(() => {
    if (ext.runtime?.id) return;
    clearInterval(alive);
    window.postMessage({ ytms: 'stopped' }, location.origin);
  }, 2000);
})();
