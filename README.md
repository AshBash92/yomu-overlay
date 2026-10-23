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
