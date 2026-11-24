# Yomu Overlay

A Brave/Chromium extension (Manifest V3) that translates Japanese manga as you read and helps you learn kanji.

Press **Alt+T** on a manga page and read it your way:

- **Just read English:** translations appear over each speech bubble.
- **Learn Japanese:** try each bubble yourself and ask for only as much help as you need: clear text, furigana, word meanings, and finally the English. Rate how you did, review what you missed, and export words to Anki.

> **You need your own Claude API key.** Yomu calls the Claude API directly from your browser. It has no shared key, account system, or server, so you pay Anthropic for what you use. [Setup](#setup) walks you through it.

Plain JavaScript, no build step.

## Setup

### 1. Install the extension

Works in Brave, Chrome, Edge, and other Chromium browsers.

1. Download this repo with **Code → Download ZIP** and unzip it, or run:

   ```
   git clone https://github.com/AshBash92/yomu-overlay.git
   ```

2. Put the folder somewhere permanent. The browser loads the extension from it, so moving or deleting it breaks the extension.
3. Open your extensions page: `brave://extensions`, `chrome://extensions`, or `edge://extensions`.
4. Turn on **Developer mode**.
5. Click **Load unpacked** and select the `yomu-overlay` folder (the one containing `manifest.json`).
6. Optional: open the puzzle-piece menu in the toolbar and pin **Yomu Overlay**.

### 2. Get a Claude API key

1. Sign in or create an account at the [Claude Console](https://platform.claude.com/).
2. Check your balance on the [Billing page](https://platform.claude.com/settings/billing). New users receive some free credits to try the API. Buy more there when they run out.
3. Open [API keys](https://platform.claude.com/settings/keys) and click **Create key**.
4. Name it something like `Yomu Overlay` and choose an expiration. If asked for a linked account, choose yourself.
5. **Copy the key now.** It starts with `sk-ant-` and is only shown once.
6. Recommended: set a monthly cap on the [Spend limits page](https://platform.claude.com/settings/spend-limits) so you can't be surprised by a bill.

Treat the key like a password. Never commit it, post it, or share it in a screenshot.

### 3. Add the key to Yomu

1. Click the **Yomu Overlay** toolbar button, then **Options**. You can also go to **Details → Extension options** on the extensions page.
2. Paste your key into **Anthropic API key**.
3. Click **Test key** and wait for "Key works."
4. Click **Save**. Testing a key doesn't save it.
5. Under **How do you want to read?**, choose **Learn Japanese** or **Just read English**. You can change this any time from the toolbar popup.

### 4. Translate a page

Open a manga page and press **Alt+T**. The first translation may take a few seconds.

- In **Just read English**, the English appears over each bubble. See [Just read English](#just-read-english).
- In **Learn Japanese**, a small marker appears on each bubble. Try reading it, then hover the bubble if you want a hint. See [Learn Japanese](#learn-japanese).

### Managing your key and costs

- **Replace or remove the key:** open Options, change or clear the field, and click **Save**.
- **If a key leaks:** delete it on the [API keys page](https://platform.claude.com/settings/keys), then create a new one.
- **Keep costs low:** Claude Haiku is the default and the cheapest model. You can change the model and effort in Options.
- **Track spending:** the toolbar popup shows an estimate for this month. Your actual bill is in the [Claude Console](https://platform.claude.com/).

### Troubleshooting

| Message | What to do |
| --- | --- |
| No API key yet | Add your key in Options and click **Save** |
| Your API key was rejected | Copy the key again, or create a new one |
| Your API key isn't allowed to use this model | Pick another model in Options, or check the key's workspace |
| Request failed (400) mentioning credit balance | Add credits on the [Billing page](https://platform.claude.com/settings/billing) |
| Rate limit reached | Wait a moment and try again |
| Yomu can't run on this page | Browser pages and extension stores are blocked; use a normal website |

## Privacy and security

- **What gets sent:** when you press the translate hotkey, a screenshot goes to the Anthropic API. It's cropped to the manga images on the page. If none can be detected (for example, pages drawn with CSS backgrounds), the **whole visible tab** is sent, so don't translate pages showing anything private. Nothing is captured until you ask.
- **Auto-translate:** off by default. Once you turn it on and press the hotkey on a tab, new manga pages on that site are sent as you read them. It only captures the tab you're looking at, never sends a full-tab screenshot, and stops when you leave the site.
- **Your API key:** stored unencrypted in your browser profile (`chrome.storage.local`), hidden from content scripts, and sent only to `api.anthropic.com`. Use a dedicated key with a spend limit.
- **Your data:** saved words, known words, and settings stay in this browser. There is no server or analytics. Anki exports include the source page's address, without its query string.

This is an independent project, not affiliated with or endorsed by Anthropic.

## Hotkeys

To change them, go to `brave://extensions/shortcuts` (or your browser's equivalent).

| Action | Default |
| --- | --- |
| Translate what's visible | Alt+T |
| Show / hide overlays | Alt+H (or the on-page button) |
| Show English for every bubble (Learn Japanese) | Alt+Shift+E |
| Open the study panel | Alt+Shift+S |
| Study one bubble | Ctrl+click it |

While your pointer is over a bubble in Learn Japanese mode:

| Key | Action |
| --- | --- |
| C | Show the text in a clear font |
| F | Show furigana |
| W | Word help |
| E | Show English |
| 1 / 2 / 3 | Rate it: Got it / Partly / Missed it |

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

- After changing code, click the reload icon on the extension card, then refresh the manga tab.
- Background worker logs (timing for each translation, plus errors): `brave://extensions` → Yomu Overlay → click the blue **service worker** link. If it says "(inactive)", press Alt+T first.
- Errors from the overlay: open DevTools (F12) on the manga tab → Console.

## Study panel

Open it with Alt+Shift+S or the toolbar popup. It lists every bubble from the last translation of the current tab. In Learn Japanese mode the English stays hidden until you choose **Show English**, and your reveals and ratings stay in step with the page.

**Word help** loads a word-by-word breakdown (one small Claude request, cached until the browser restarts). Click a word for its meaning and kanji, then **Save word**. **Explain grammar** asks Claude for a short grammar note. Once every bubble is rated, **Review these** narrows the list to the ones you didn't fully get.

### Importing saved words into Anki

1. In the panel, open **Saved words** and click **Export CSV for Anki**.
2. In Anki: **File → Import**, pick the CSV. The columns are named automatically.
3. Choose a note type and deck, map the fields you want (e.g. Word to Front; Reading, Meaning, Kanji, and Sentence to Back), then **Import**.

## Learning profile

Set your JLPT level on the options page. Grammar notes and word breakdowns are pitched at that level, and kanji from the bundled N5/N4 lists (approximate, from common study lists) count as known.

In the study panel, words have two states besides new: **Learning** (saved; exported to Anki) and **Known**. Mark a word with **I know this**, or a whole bubble with **I knew every word**. Known words are stored by dictionary form, so every conjugation counts. The **Known** tab can import words you already know: paste one per line, or choose an Anki "Notes in Plain Text" export.

## Just read English

Choose **Just read English** in Options or the toolbar popup.

1. Press **Alt+T** on a page. The English appears over each bubble as it's translated.
2. Turn the page or scroll, then press **Alt+T** again. Yomu only translates when you ask, so you never pay for pages you skip.
3. Press **Alt+H** or the on-page **Show original** button to compare with the Japanese art.

Text stays whole: if English doesn't fit a narrow bubble, Yomu widens it into nearby free space before making the text smaller. This mode skips word readings, so it costs a little less than Learn Japanese.

### Auto-translate

Turn on **Translate new pages automatically** in the toolbar popup or Options, then press **Alt+T** once on a manga page. New pages translate as you turn or scroll to them.

Each new page is sent to Claude and uses your API credits, so it has limits:

- Pages you've already read come back for free when you return to them.
- It only runs on the tab you're looking at, and only right after you scroll, click, or press a key, so an idle tab costs nothing.
- It waits while **Show original** is on.
- It pauses after 30 pages in a row and asks before continuing.
- It turns off for that tab if you leave the site or a request fails.

Use the on-page **Auto on** button to stop it for one tab. Readers that draw pages on a `<canvas>` without changing the page address can't be detected, so press **Alt+T** on those.

## Learn Japanese

**Learn Japanese** is the default. You can switch modes in the toolbar popup.

1. **Read:** the original page stays visible, with a small marker on each bubble. No English is shown.
2. **Hint:** hover a bubble for a card with **Clear text**, **Furigana**, and **Word help**. Open only what you need.
3. **Reveal:** choose **Show English** when you're ready.
4. **Rate:** pick **Got it**, **Partly**, or **Missed it**. On Partly or Missed it, words you looked up are added to Learning. **Got it** adds nothing and never marks words as known, since you can understand a line from context without knowing every word.
5. **Recap:** when every bubble is rated, Yomu sums up the page and offers a review of the ones you missed.

The furigana hint follows your level and known words: **Kanji above my level** (default), **Every word I haven't marked known**, or **Off**. If those settings would show nothing for a line, asking for furigana shows all its readings.

This mode asks Claude for word readings, which adds a little to each translation. Clear text, furigana, and the English arrive with that translation, so revealing them costs nothing extra. Word help makes one small request the first time you use it on a line. The card's buttons never turn the page, and clicks anywhere else still reach it.

## License

Yomu Overlay is **source-available** under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).

You're welcome to use, copy, modify, and share it for personal study, hobby projects, and other noncommercial purposes. **Commercial use isn't allowed**, including selling it or building it into a paid product or service. If you share it, include the license and its `Required Notice` line.

This summary is for convenience; the [license text](LICENSE.md) is what applies.
