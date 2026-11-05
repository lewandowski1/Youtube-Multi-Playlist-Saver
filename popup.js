// The popup's two link buttons. While a link is null its button shows "Coming soon".
const LINKS = {
  donate: 'https://ko-fi.com/nikma',
  website: 'https://nikma.xyz',
};

const { KEY, OPTIONS, normalize } = globalThis.YTMS_SETTINGS;
let settings = normalize(null);

function save(patch) {
  settings = { ...settings, ...patch };
  chrome.storage.sync.set({ [KEY]: settings }); // bridge.js forwards it to open YouTube tabs
}

function render() {
  for (const input of document.querySelectorAll('.switch')) input.checked = settings[input.dataset.setting];
  document.getElementById('sort').value = settings.sort;
  for (const input of document.querySelectorAll('.seg input')) input.checked = settings[input.name] === input.value;
}

// Segmented controls and the sort select are built from the shared option lists.
for (const group of document.querySelectorAll('.seg')) {
  const key = group.dataset.setting;
  for (const [value, label] of OPTIONS[key]) {
    const input = document.createElement('input');
    Object.assign(input, { type: 'radio', name: key, value });
    input.addEventListener('change', () => save({ [key]: value }));
    const text = document.createElement('span');
    text.textContent = label;
    const option = document.createElement('label');
    option.append(input, text);
    group.append(option);
  }
}

const sort = document.getElementById('sort');
for (const [value, label] of OPTIONS.sort) sort.append(new Option(label, value));
sort.addEventListener('change', () => save({ sort: sort.value }));

for (const input of document.querySelectorAll('.switch')) {
  input.addEventListener('change', () => save({ [input.dataset.setting]: input.checked }));
}

for (const [id, url] of Object.entries(LINKS)) {
  const link = document.getElementById(id);
  if (url) {
    link.href = url;
    continue;
  }
  link.classList.add('soon');
  link.setAttribute('aria-disabled', 'true');
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = 'Coming soon';
  link.append(badge);
}

document.getElementById('version').textContent = chrome.runtime.getManifest().version;

render();
chrome.storage.sync.get(KEY).then((stored) => {
  settings = normalize(stored[KEY]);
  render();
});
