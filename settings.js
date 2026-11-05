// Settings schema shared by the page script (content.js), the storage bridge (bridge.js) and the popup.
// Options are [value, label] pairs so their order is kept (object keys like "3" would sort first).
globalThis.YTMS_SETTINGS = (() => {
  const OPTIONS = {
    sort: [
      ['recent', 'Recently saved to'],
      ['az', 'Name A → Z'],
      ['za', 'Name Z → A'],
    ],
    columns: [
      ['auto', 'Auto'],
      ['3', '3'],
      ['4', '4'],
      ['5', '5'],
      ['6', '6'],
    ],
    size: [
      ['small', 'Small'],
      ['medium', 'Medium'],
      ['large', 'Large'],
    ],
  };
  // confirmDiscard: closing the grid with unsaved changes asks first; when false it saves them instead.
  const DEFAULTS = { sort: 'recent', columns: 'auto', size: 'medium', thumbnails: true, confirmDiscard: true };

  function normalize(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const pick = (key) => (OPTIONS[key].some(([value]) => value === s[key]) ? s[key] : DEFAULTS[key]);
    const flag = (key) => (typeof s[key] === 'boolean' ? s[key] : DEFAULTS[key]);
    return {
      sort: pick('sort'),
      columns: pick('columns'),
      size: pick('size'),
      thumbnails: flag('thumbnails'),
      confirmDiscard: flag('confirmDiscard'),
    };
  }

  // KEY: chrome.storage.sync key. ATTR: <html> attribute the bridge mirrors settings into for the page script.
  return { KEY: 'settings', ATTR: 'data-ytms-settings', OPTIONS, DEFAULTS, normalize };
})();
