# Chrome Web Store listing

Answers for each tab of the Chrome Web Store Developer Dashboard, ready to paste.

Before uploading, run `site\make-zip.ps1`. It writes `store\playlist-multi-save.zip`, with `manifest.json` at the top of the zip as the store requires.

## Name

The store shows the `name` from `manifest.json`: **Playlist Multi-Save**. Keep "YouTube" and "YT" out of it. YouTube's branding rules don't allow its name, or any abbreviation or variant of it, in an app's name, and the review can reject or later pull an item over it. Saying that the extension works with YouTube, as the description below does, is allowed.

## Package

Upload `store\playlist-multi-save.zip`.

## Store listing

**Description**

```
Saving a video to several playlists on YouTube means opening the Save menu again and again and scrolling a long one-column list each time. Multi-Save adds a Save+ button under the video. It opens all your playlists in a wide grid, so you can tick as many as you like and save the video to all of them at once.

• Tick or untick any number of playlists, then save them all in one go
• Playlist covers, so you can spot the right one at a glance (or switch them off for a compact list)
• 3 to 6 columns, or Auto to fit your window, with small, medium or large cards
• Sort by recently saved to, or by name
• Search to filter: Enter ticks the top match, Ctrl+Enter saves
• Create a new playlist and save the video to it straight away
• Follows YouTube's light and dark theme

It works for YouTube inside youtube.com, signed in with your existing YouTube session, the same way YouTube's own Save button does. Nothing is sent to the developer or anyone else.

Not affiliated with YouTube or Google.
```

**Category:** Entertainment
**Language:** English
**Store icon:** `icons\icon128.png`
**Screenshot:** `store\screenshot-1280x800.png`
**Small promo tile:** `store\promo-440x280.png`
**Homepage URL:** `https://nikma.xyz/playlist-multi-save/`

## Privacy

**Single purpose**

```
Save the YouTube video you're watching to several of your playlists at once, from a grid of all your playlists.
```

**Permission justification: storage**

```
Stores the grid settings (sort order, number of columns, card size, thumbnails on or off, and what closing the grid does) and syncs them across the user's Chrome browsers.
```

**Host permission justification** (the content scripts on www.youtube.com)

```
Adds the Save+ button under YouTube videos. When the user opens the grid, it reads their playlists from YouTube; when they click Save, it adds or removes the video through YouTube's own endpoints, as YouTube's Save button does. It runs only on www.youtube.com.
```

**Remote code:** No, I am not using remote code.

**Data usage:** tick **Authentication information** (it signs YouTube requests with the user's existing YouTube session) and **Website content** (playlist names and the video's title). Both are only used inside youtube.com and never leave it. Then tick all three certifications.

**Privacy policy URL:** `https://nikma.xyz/privacy.html#multi-save`

## Distribution

Free, Public, all regions.

## Test instructions

```
Sign in to YouTube with an account that has a few playlists. Open any video and click Save+ in the row of buttons under it (next to Like and Share). Tick some playlists and click Save. The extension's options are in its toolbar popup.
```
