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
| Show / hide overlays | Alt+H (or the on-page **Hide** button) |
| Reveal English for every bubble (read-first / hover modes) | Alt+Shift+E |
| Open the study panel | Alt+Shift+S |
| Study one bubble | Ctrl+click its translation |

## Files

| File | What it does |
| --- | --- |
| `manifest.json` | Extension config: permissions, hotkeys, pages |
| `background.js` | Service worker: hotkeys, screenshot, sends it to Claude |
| `claude.js` | Claude API calls, prompt, and the JSON shape of the answer |
| `panel.html/js` | Study side panel: bubbles, word breakdowns, grammar, saved words |
| `panel-open.js` | Opens the side panel (or a window if unsupported) |
| `known.js` | Known words, and importing word lists or Anki exports |
| `jlpt.js` | Approximate N5/N4 kanji lists |
| `usage.js` | Cost estimates and the monthly total |
| `wordlist.js` | Saved word list and Anki CSV export |
| `content.js` | Draws the translation boxes on the page |
| `popup.html/js` | Toolbar button menu |
| `options.html/js` | API key, model, and effort settings |
| `settings.js` | Shared storage helpers |

## Debugging

- Background worker logs (timing for each translation, plus errors): `brave://extensions` → Yomu Overlay → click the blue **service worker** link. If it says "(inactive)", press Alt+T first.
- Errors from the overlay: open DevTools (F12) on the manga tab → Console.

## Study panel

Open it with Alt+Shift+S or the toolbar popup. It lists every bubble from the last translation of the current tab. Click a bubble to load its reading and word-by-word breakdown (one small Claude request, cached until the browser restarts). Click a word for its meaning and kanji, then **Save word**. **Explain grammar** asks Claude for a short grammar note.

### Importing saved words into Anki

1. In the panel, open **Saved words** and click **Export CSV for Anki**.
2. In Anki: **File → Import**, pick the CSV. The columns are named automatically.
3. Choose a note type and deck, map the fields you want (e.g. Word to Front; Reading, Meaning, Kanji, and Sentence to Back), then **Import**.

## Learning profile

Set your JLPT level on the options page. Grammar notes and word breakdowns are pitched at that level, and kanji from the bundled N5/N4 lists (approximate, from common study lists) count as known.

In the study panel, words have two states besides new: **Learning** (saved; exported to Anki) and **Known**. Mark a word with **I know this**, or a whole bubble with **I knew every word**. Known words are stored by dictionary form, so every conjugation counts. The **Known** tab can import words you already know: paste one per line, or choose an Anki "Notes in Plain Text" export.

## Display modes

Pick one in the toolbar popup:

- **English**: English covers each bubble.
- **Read first**: Japanese covers each bubble, with furigana only where you need it. Hover a bubble to see its English.
- **Original page, hover for help**: the page is untouched apart from a faint outline per bubble. Hover one for a card with the furigana and English.

Furigana follows your level and known words: **Kanji above my level** (default), **Every word I haven't marked known**, or **Off**. The Japanese modes ask Claude for word readings, which adds a little to each translation; English mode doesn't. Hovering never blocks clicks on the page.
