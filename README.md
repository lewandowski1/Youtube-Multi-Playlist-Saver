# Playlist Multi-Save

A Chrome extension that adds a **Save+** button next to Like / Share on YouTube watch pages. It opens a wide grid of all your playlists so you can tick several and save to all of them at once.

- Tick or untick any number of playlists, then **Save** applies them all in one go
- Each playlist shows its cover image (empty playlists get a placeholder), or switch thumbnails off for a compact list
- Columns: **Auto** (fits the window) or a fixed **3–6**
- Card size: **Small**, **Medium** or **Large**
- Sort by **Recently saved to** (YouTube's order), **Name A → Z** or **Name Z → A**. Watch Later always stays first.
- Search box to filter (`Enter` toggles the top match, `Ctrl+Enter` saves, `Esc` closes)
- Closing with unsaved selections asks before discarding them. Switch off **Ask before discarding changes** in the popup to have clicking outside, the close button or `Esc` save them instead (Cancel always discards).
- Create a new playlist (saves the video to it straight away)
- Follows YouTube's light/dark theme
- YouTube's own Save button is left alone, so it still works as a fallback

The view settings can be changed in the grid itself or in the extension's popup; the closing behaviour is in the popup (click the toolbar icon). They sync across your Chrome profile, and changes apply live, even to an open grid.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder
4. Reload any open YouTube tabs

After editing the code, click the reload icon on the extension's card and refresh YouTube. Chrome leaves the old code running in tabs that were already open, so the extension takes the Save+ button off those tabs; it comes back, up to date, when you refresh them.

## Donate and website links

The popup's **Support the creator** and **Visit creator website** buttons. They're set at the top of `popup.js`:

```js
const LINKS = {
  donate: 'https://ko-fi.com/nikma',
  website: 'https://nikma.xyz',
};
```

While a link is `null`, its button in the popup shows "Coming soon".

## Files

| File | What it does |
| --- | --- |
| `content.js` | The Save+ button and the grid. Runs in YouTube's page context (`"world": "MAIN"`). |
| `bridge.js` | Relays settings between `chrome.storage.sync` and `content.js`, which can't reach extension storage from the page context. Also tells `content.js` when the extension has been reloaded, updated or switched off. |
| `settings.js` | The settings schema, shared by all three scripts |
| `popup.html/.css/.js` | The toolbar popup |
| `icons/logo.svg` | Master logo; `icons/logo-16.svg` is the pixel-aligned toolbar version. The PNGs are rendered from these. |

## Download page

`site/` is a one-page website for the extension: a looping demo video (`demo.mp4`, with `poster.webp` as its first frame), the logo (`icon.png`) and name, a short description, a download link and the install tutorial. The hub's card plays `card.mp4`, a smaller copy of the demo (see `../extensions-site/README.md`). `screenshot.webp` is a still picture of the extension; the pages don't use it. It's plain static files, so any static host can serve the folder as-is (GitHub Pages, Netlify, your own server). After changing the extension, rebuild the download, which also updates the size shown on the page:

```powershell
powershell -ExecutionPolicy Bypass -File site\make-zip.ps1
```

The zip holds everything in this folder except `site/` and `store/`. Loading the folder unpacked still works with those two in it; the extension just doesn't use their files.

The page is also linked from the hub site in `../extensions-site`, which copies it in. The install tutorial at the bottom of the page comes from `../extensions-site/install.html`: edit it there, and its `build.ps1` updates this page.

## Chrome Web Store

`make-zip.ps1` also writes the store upload, `store/*.zip`, with `manifest.json` at the top of the zip as the store requires. `store/listing.md` has the text for each tab of the store's developer dashboard, and `store/` holds the 1280x800 screenshot and the 440x280 promo tile.

Keep "YouTube" and "YT" out of the extension's name. YouTube's branding rules don't allow its name or any abbreviation of it in an app's name, which is why this is Playlist Multi-Save. The description can still say it works with YouTube.

## How it works

`content.js` calls the same internal endpoints YouTube's Save dialog uses, signed in as you:

| What | Endpoint |
| --- | --- |
| List playlists and which ones contain the video | `youtubei/v1/playlist/get_add_to_playlist` |
| Add / remove the video | `youtubei/v1/browse/edit_playlist` |
| Create a playlist | `youtubei/v1/playlist/create` |
| Playlist covers (your Library → Playlists page) | `youtubei/v1/browse` with `FEplaylist_aggregation` |

Covers are cached in youtube.com's localStorage so they appear instantly next time, then refreshed in the background. With thumbnails switched off, they aren't fetched at all.

The only permission is `storage` (for the settings). Nothing is sent anywhere except youtube.com.

## If it breaks

YouTube changes its internals from time to time. If the grid says it "doesn't recognise" the response, open DevTools → Console on YouTube: the raw response is logged under `[Playlist Multi-Save]`, and the parser in `parsePlaylists()` probably needs to be updated to match. If the **Save+** button goes missing, the selectors in `ensureButton()` need updating. If covers stop showing (placeholders everywhere), `collectThumbnails()` needs updating; saving still works without them.

## Source and license

The source is on GitHub: https://github.com/lewandowski1/Youtube-Multi-Playlist-Saver

The code is under the MIT license (see `LICENSE`). The zips that `site\make-zip.ps1` builds aren't in the repository; run the script to make them.
