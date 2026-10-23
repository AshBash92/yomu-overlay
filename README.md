# yomu-overlay

A Brave/Chromium extension (Manifest V3) that translates Japanese manga as you read and helps you learn kanji.

Press **Alt+T** and the extension screenshots the visible tab, sends it to Claude (vision), and draws English translations over each speech bubble. Later phases add series context memory, display modes (English / furigana / hover), and study tools (word breakdowns, grammar explanations, Anki CSV export).

Plain JavaScript, no build step. You supply your own Anthropic API key; it is stored only in `chrome.storage.local`.

## Load it in Brave

1. Open `brave://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `yomu-overlay` folder.
4. Click the extension's **Details → Extension options** and paste your Anthropic API key.
5. Open a manga page and press **Alt+T**.

After changing code, click the reload icon on the extension card in `brave://extensions`, then refresh the manga tab.

To change the hotkey, go to `brave://extensions/shortcuts`.

## Hotkeys

| Action | Default |
| --- | --- |
| Translate what's visible | Alt+T |
| Show / hide overlays | Alt+Shift+T |

## Files

| File | What it does |
| --- | --- |
| `manifest.json` | Extension config: permissions, hotkeys, pages |
| `background.js` | Service worker: hotkeys, screenshot, sends it to Claude |
| `claude.js` | Claude API calls, prompt, and the JSON shape of the answer |
| `content.js` | Draws the translation boxes on the page |
| `popup.html/js` | Toolbar button menu |
| `options.html/js` | API key, model, and effort settings |
| `settings.js` | Shared storage helpers |

## Debugging

- Background worker logs (timing for each translation, plus errors): `brave://extensions` → Yomu Overlay → click the blue **service worker** link. If it says "(inactive)", press Alt+T first.
- Errors from the overlay: open DevTools (F12) on the manga tab → Console.
