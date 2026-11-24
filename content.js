// Content script: draws translation boxes over the page.
// Injected on demand by the background worker, so it may run more than
// once per page; the guard below keeps a single instance.
//
// Display modes:
//   study   - The original page stays visible, with a small marker per
//             bubble. Hover one for a card of hints you choose to open:
//             clear text, furigana, word help, then the English and a rating.
//   english - English covers each bubble.

(() => {
  if (window.__yomuOverlay) return;
  window.__yomuOverlay = true;

  // Host element sits at the document's top-left corner. Boxes inside it
  // use document coordinates, so they scroll with the page for free.
  const host = document.createElement("yomu-overlay-root");
  host.style.cssText =
    "all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; " +
    "z-index: 2147483647; pointer-events: none;";
  // Closed so the page's own scripts can't read translations or press our buttons.
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      .layer { position: absolute; top: 0; left: 0; }
      .box {
        position: absolute;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2px 4px;
        overflow: hidden;
        background: rgba(255, 255, 255, 0.96);
        color: #111;
        border-radius: 10px;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15);
        font: 600 14px/1.15 "Segoe UI", system-ui, -apple-system, sans-serif;
        text-align: center;
        overflow-wrap: anywhere;
        pointer-events: none; /* clicks pass through to the page */
      }
      .card .ja, .card .chip {
        font-family: "Yu Gothic UI", "Meiryo", "Hiragino Sans", "Noto Sans JP", sans-serif;
        line-break: strict;
      }
      ruby { ruby-align: center; } /* keeps long readings from spreading the kanji apart */
      rt { font-size: 0.6em; font-weight: 500; color: #444; }
      .box.sfx { --bubble: #fff4c8; font-style: italic; }
      .box.revealed { --bubble: #fff8e1; }
      .box.marker, .box.english { background: transparent; box-shadow: none; overflow: visible; padding: 0; }
      .en-text {
        position: absolute;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2px 4px;
        overflow: hidden;
        overflow-wrap: normal; /* keep words whole */
        border-radius: 10px;
        background: var(--bubble, #fff);
        box-shadow: 0 0 3px 2px var(--bubble, #fff); /* soft edge that blends into the bubble */
      }
      .box.marker.hovered { box-shadow: 0 0 0 2px #d84315; }
      .mark {
        position: absolute;
        top: -7px;
        right: -7px;
        box-sizing: border-box;
        width: 17px;
        height: 17px;
        border: 2px solid #d84315;
        border-radius: 50%;
        background: #fff;
        color: #111;
        font: 700 10px/13px "Segoe UI", system-ui, sans-serif;
        font-style: normal;
        text-align: center;
      }
      .mark.seen { background: #d84315; color: #fff; }
      .mark.got { background: #2e7d32; border-color: #2e7d32; color: #fff; }
      .mark.partly { background: #f9a825; border-color: #f9a825; color: #111; }
      .mark.missed { background: #c62828; border-color: #c62828; color: #fff; }
      .layer.hide-sfx .box.sfx { display: none; }
      .box.offscreen { visibility: hidden; }
      /* While Ctrl is held, boxes become clickable to open them in the study panel. */
      .layer.interactive .box { pointer-events: auto; cursor: pointer; }
      .layer.interactive .box:hover, .box.highlight { box-shadow: 0 0 0 3px #d84315; }
      .card {
        position: absolute;
        box-sizing: border-box;
        width: 310px;
        max-width: calc(100vw - 16px);
        padding: 10px 12px;
        border-radius: 10px;
        background: #fff;
        color: #111;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.3);
        font: 14px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif;
        pointer-events: auto; /* its buttons take clicks; they never reach the page */
        cursor: default;
      }
      .card .prompt { color: #555; font-size: 13px; margin-bottom: 8px; }
      .card .ja { font-size: 19px; font-weight: 600; line-height: 1.9; margin-bottom: 6px; }
      .card .en { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
      .card .muted { color: #555; font-size: 12px; }
      .card .card-error { color: #b71c1c; font-size: 13px; margin-bottom: 6px; }
      .card .gloss { color: #333; font-size: 13px; margin-bottom: 8px; }
      .card .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
      .card .row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
      .card .rate { margin-top: 8px; padding-top: 8px; border-top: 1px solid #e5e5e5; }
      .card .rate .muted { width: 100%; }
      .card .note { margin-top: 6px; }
      .card button {
        all: unset;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        border: 1px solid #c8c8c8;
        border-radius: 6px;
        background: #fff;
        color: #222;
      }
      .card button:hover { background: #f2f2f2; }
      .card button:focus-visible { outline: 2px solid #d84315; outline-offset: 1px; }
      .card button.on { border-color: #d84315; background: #fbe9e7; color: #a32c0a; }
      .card .action { padding: 3px 7px; font: 600 12px/1.4 "Segoe UI", system-ui, sans-serif; }
      .card .chip { padding: 2px 7px; font-size: 16px; line-height: 1.4; }
      .card kbd { color: #666; font: 10px ui-monospace, monospace; }
      .card button.on kbd { color: #a32c0a; }
      .status {
        position: fixed;
        right: 16px;
        bottom: 16px;
        max-width: 340px;
        padding: 8px 12px;
        border-radius: 8px;
        background: #1f1f1f;
        color: #fff;
        font: 13px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        pointer-events: auto;
        cursor: pointer;
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .status.error { background: #b71c1c; }
      .status-action {
        all: unset;
        flex: none;
        cursor: pointer;
        padding: 2px 9px;
        border: 1px solid rgba(255, 255, 255, 0.6);
        border-radius: 6px;
        font-weight: 600;
      }
      .status-action:hover { background: rgba(255, 255, 255, 0.18); }
      .status-action:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
      .controls {
        position: fixed;
        left: 16px;
        bottom: 16px;
        display: flex;
        gap: 4px;
        padding: 4px;
        border-radius: 999px;
        background: rgba(31, 31, 31, 0.85);
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
        pointer-events: auto;
        opacity: 0.6;
        transition: opacity 0.15s;
      }
      .controls:hover, .controls:focus-within { opacity: 1; }
      .controls button {
        all: unset;
        cursor: pointer;
        padding: 4px 10px;
        border-radius: 999px;
        color: #fff;
        font: 600 12px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif;
      }
      .controls button:hover { background: rgba(255, 255, 255, 0.18); }
      .controls button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
      .controls button.on { background: #d84315; }
      .controls .progress { padding: 4px 8px; color: #fff; font: 600 12px/1.4 "Segoe UI", system-ui, sans-serif; }
      .spinner {
        width: 12px; height: 12px; flex: none;
        border: 2px solid rgba(255, 255, 255, 0.35);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      [hidden] { display: none !important; }
    </style>
    <div class="layer"></div>
    <div class="card" hidden></div>
    <div class="status" role="status" hidden></div>
    <div class="controls" hidden>
      <span class="progress" hidden></span>
      <button class="auto" title="Translate new pages as you reach them. Each new page uses your API credits." hidden></button>
      <button class="hide" title="Hide or show the translation boxes">Hide</button>
      <button class="reveal" title="Show English for every bubble">Show all English</button>
      <button class="close" title="Remove the translation boxes from this page" aria-label="Remove translations">✕</button>
    </div>
  `;
  document.documentElement.appendChild(host);

  const layer = shadow.querySelector(".layer");
  const card = shadow.querySelector(".card");
  const status = shadow.querySelector(".status");
  const controls = shadow.querySelector(".controls");
  const hideBtn = controls.querySelector(".hide");
  const revealBtn = controls.querySelector(".reveal");
  const autoBtn = controls.querySelector(".auto");
  const progress = controls.querySelector(".progress");
  let statusTimer;
  let lastUrl = location.href;

  // How bubbles are shown. Updated by "start" and "set-display" messages.
  const display = { mode: "study", furigana: "above-level" };
  let revealAll = false;
  let hoverBox = null;
  let pageId = null; // the translation the numbered bubbles belong to
  let recapShown = false;
  let capturing = false; // our UI must stay out of the screenshot

  // Auto-translate: the background worker owns the session, this side
  // watches for new pages. images: what's already translated, by image.
  const auto = { on: false, available: false, started: false, remembering: false, images: new Map() };

  status.addEventListener("click", () => (status.hidden = true));

  function showStatus(text, { error = false, spinner = false, hideAfter = 0, action = null } = {}) {
    clearTimeout(statusTimer);
    status.className = error ? "status error" : "status";
    status.textContent = "";
    if (spinner) {
      const s = document.createElement("span");
      s.className = "spinner";
      status.append(s);
    }
    status.append(text);
    if (action) {
      const button = document.createElement("button");
      button.className = "status-action";
      button.textContent = action.label;
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        status.hidden = true;
        action.run();
      });
      status.append(button);
    }
    status.hidden = false;
    if (hideAfter) statusTimer = setTimeout(() => (status.hidden = true), hideAfter);
  }

  function clearOverlays() {
    layer.replaceChildren();
    unwatchAnchors();
    setHover(null);
    updateControls();
  }

  // ---------- On-page buttons ----------

  function updateControls() {
    const hasBoxes = layer.childElementCount > 0;
    // Stays up between pages so auto-translate can always be turned off.
    controls.hidden = capturing || !(hasBoxes || (auto.on && display.mode === "english"));
    hideBtn.hidden = !hasBoxes;
    autoBtn.hidden = display.mode !== "english" || !auto.available;
    autoBtn.textContent = auto.on ? "Auto on" : "Auto off";
    autoBtn.classList.toggle("on", auto.on);
    autoBtn.setAttribute("aria-pressed", String(auto.on));
    if (display.mode === "english") hideBtn.textContent = layer.hidden ? "Show English" : "Show original";
    else hideBtn.textContent = layer.hidden ? "Show" : "Hide";
    hideBtn.classList.toggle("on", layer.hidden);
    revealBtn.hidden = display.mode === "english" || layer.hidden;
    revealBtn.textContent = revealAll ? "Hide English" : "Show all English";
    revealBtn.classList.toggle("on", revealAll);
    const boxes = currentBoxes();
    progress.hidden = display.mode === "english" || !boxes.length;
    progress.textContent = `${boxes.filter((b) => b._study.rating).length}/${boxes.length} read`;
  }

  // The bubbles from the newest translation, leaving out hidden sound effects.
  function currentBoxes() {
    const hideSfx = layer.classList.contains("hide-sfx");
    return [...layer.querySelectorAll(".box[data-index]")].filter((b) => !(hideSfx && b.classList.contains("sfx")));
  }

  function toggleLayer() {
    if (!layer.childElementCount) {
      showStatus("Nothing to show yet. Press Alt+T to translate.", { hideAfter: 2500 });
      return;
    }
    layer.hidden = !layer.hidden;
    if (layer.hidden) {
      setHover(null);
    } else {
      layoutBoxes();
      renderAll(); // text can only be measured while it's visible
      queueAuto(); // pages turned while viewing the original
    }
    updateControls();
  }

  function toggleReveal() {
    if (!layer.childElementCount) {
      showStatus("Nothing to reveal yet. Press Alt+T to translate.", { hideAfter: 2500 });
      return;
    }
    if (display.mode === "english") return; // English is already showing
    revealAll = !revealAll;
    if (revealAll) {
      const boxes = currentBoxes();
      for (const box of boxes) box._study.english = true;
      sendStudy(boxes, { english: true });
    }
    layer.hidden = false;
    layoutBoxes();
    setHover(null);
    renderAll();
    updateControls();
  }

  // Clicks on the buttons must not reach the page (it might turn the page).
  for (const type of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup"]) {
    for (const el of [controls, card, status]) el.addEventListener(type, (e) => e.stopPropagation());
  }
  hideBtn.addEventListener("click", toggleLayer);
  revealBtn.addEventListener("click", toggleReveal);
  autoBtn.addEventListener("click", () => requestAuto(!auto.on));
  controls.querySelector(".close").addEventListener("click", () => {
    if (auto.on) requestAuto(false);
    abandonTranslation();
    clearOverlays();
    showStatus("Translations removed. Press Alt+T to translate again.", { hideAfter: 2500 });
  });

  // ---------- Rendering one bubble ----------

  // Should this word get furigana? Flags come from the background worker,
  // which knows your level and known words.
  function wantsReading(seg) {
    if (!seg.reading || !seg.hasKanji || seg.known) return false;
    if (display.furigana === "unknown-words") return true;
    if (display.furigana === "above-level") return seg.aboveLevel;
    return false;
  }

  function japaneseNodes(region, withFurigana) {
    const frag = document.createDocumentFragment();
    if (!region.segments?.length) {
      frag.append(region.japanese);
      return frag;
    }
    // The reader asked for help, so if their settings pick no words, show every reading.
    const showAll = withFurigana && !region.segments.some(wantsReading);
    for (const seg of region.segments) {
      if (withFurigana && seg.reading && (showAll || wantsReading(seg))) {
        const ruby = document.createElement("ruby");
        const rt = document.createElement("rt");
        rt.textContent = seg.reading;
        ruby.append(seg.text, rt);
        frag.append(ruby);
      } else {
        frag.append(seg.text);
      }
    }
    return frag;
  }

  const MARKS = { got: "✓", partly: "~", missed: "✕" };

  // The small corner marker: empty until you reveal the English, then "?"
  // until you rate it, then your rating.
  function markFor(box) {
    const { english, rating } = box._study;
    const mark = document.createElement("span");
    mark.className = `mark ${rating ?? (english ? "seen" : "")}`.trim();
    mark.textContent = rating ? MARKS[rating] : english ? "?" : "";
    return mark;
  }

  function renderBox(box) {
    const english = display.mode === "english" || revealAll;
    box.classList.toggle("marker", !english);
    box.classList.toggle("english", english);
    box.classList.toggle("hovered", !english && box === hoverBox);
    box.classList.toggle("revealed", english && display.mode !== "english");

    if (!english) {
      box.replaceChildren(markFor(box));
      return;
    }
    const text = make("span", "en-text", box._region.english);
    text.lang = "en";
    box.replaceChildren(text);
    fitEnglish(box, text);
  }

  function renderAll() {
    for (const box of layer.children) renderBox(box);
    showCard(display.mode === "study" && !revealAll ? hoverBox : null);
  }

  const rectOf = (box) => {
    const left = parseFloat(box.style.left);
    const top = parseFloat(box.style.top);
    return { left, top, right: left + parseFloat(box.style.width), bottom: top + parseFloat(box.style.height) };
  };

  const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

  // The free space around a bubble: inside its image, and no further than
  // halfway to the bubbles beside it, so two widened bubbles can't overlap.
  function roomAround(box, r) {
    const image = box._anchor?.el.getBoundingClientRect();
    const page = document.documentElement;
    const bounds = image
      ? { left: scrollX + image.left, right: scrollX + image.right, top: scrollY + image.top, bottom: scrollY + image.bottom }
      : { left: 0, right: page.scrollWidth, top: 0, bottom: page.scrollHeight };
    let { left, right } = bounds;
    for (const other of layer.children) {
      if (other === box || other.classList.contains("offscreen") || !other.getClientRects().length) continue;
      const o = rectOf(other);
      if (o.bottom <= r.top || o.top >= r.bottom) continue; // not beside this bubble
      if (o.right <= r.left) left = Math.max(left, (o.right + r.left) / 2);
      else if (o.left >= r.right) right = Math.min(right, (o.left + r.right) / 2);
    }
    return {
      left: Math.min(left, r.left),
      right: Math.max(right, r.right),
      top: Math.min(bounds.top, r.top),
      bottom: Math.max(bounds.bottom, r.bottom),
    };
  }

  // English often needs more room than vertical Japanese. Keep words whole,
  // widen into free space before the text gets small, and never cut it off.
  function fitEnglish(box, text) {
    const r = rectOf(box);
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    if (!box.getClientRects().length || !Number.isFinite(w + h)) return; // fitted once it's shown

    let room = null;
    const tryFit = (width, size) => {
      const left = room ? clamp(r.left + (w - width) / 2, room.left, room.right - width) : r.left;
      text.style.left = `${left - r.left}px`;
      text.style.width = `${width}px`;
      text.style.fontSize = `${size}px`;
      return text.scrollHeight <= text.clientHeight + 1 && text.scrollWidth <= text.clientWidth + 1;
    };

    text.style.top = "0";
    text.style.height = `${h}px`;
    for (let size = 16; size >= 12; size--) if (tryFit(w, size)) return;

    room = roomAround(box, r);
    const widest = Math.max(w, Math.min(room.right - room.left, Math.max(w * 2, 180)));
    for (const width of new Set([Math.min(w * 1.35, widest), Math.min(w * 1.7, widest), widest])) {
      for (let size = 14; size >= 12; size--) if (tryFit(width, size)) return;
    }
    for (let size = 11; size >= 9; size--) if (tryFit(widest, size)) return;

    // Still too long: let it run taller rather than lose any of it.
    text.style.overflowWrap = "anywhere";
    text.style.height = "auto";
    text.style.minHeight = `${h}px`;
    tryFit(widest, 10);
    const tall = text.offsetHeight;
    text.style.top = `${clamp(r.top + (h - tall) / 2, room.top, Math.max(room.top, room.bottom - tall)) - r.top}px`;
  }

  // ---------- Hint card ----------
  // Nothing is shown until you ask for it, one step at a time.

  const newStudy = () => ({ english: false, rating: null, looked: [] });
  const newHints = () => ({ clear: false, furigana: false, words: false, wordState: null, selected: -1 });
  const RATING_BUTTONS = [
    ["got", "Got it", "1"],
    ["partly", "Partly", "2"],
    ["missed", "Missed it", "3"],
  ];
  const KEY_ACTIONS = { c: "clear", f: "furigana", w: "words", e: "english", 1: "got", 2: "partly", 3: "missed" };
  let cardSide = null;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function actionButton(act, label, key, on = false) {
    const button = make("button", on ? "action on" : "action", label);
    button.dataset.act = act;
    button.setAttribute("aria-pressed", String(on));
    button.append(make("kbd", "", key));
    return button;
  }

  const isTracked = (box) => box.dataset.index !== undefined;
  const canFurigana = (box) =>
    display.furigana !== "off" && Boolean(box._region.segments?.some((s) => s.reading));

  function wordHelpNodes(hints) {
    const state = hints.wordState;
    if (!state || state.status === "loading") return [make("div", "muted", "Looking up words…")];
    if (state.status === "error") return [make("div", "card-error", state.error)];
    const chips = make("div", "chips");
    state.words.forEach((w, i) => {
      const on = i === hints.selected;
      const chip = make("button", on ? "chip on" : "chip", w.word);
      chip.lang = "ja";
      chip.dataset.act = `word:${i}`;
      chip.setAttribute("aria-pressed", String(on));
      chips.append(chip);
    });
    const w = state.words[hints.selected];
    let gloss = "Choose a word.";
    if (w) {
      const reading = w.reading && w.reading !== w.word ? `${w.reading} · ` : "";
      const base = w.dictionaryForm && w.dictionaryForm !== w.word ? ` (from ${w.dictionaryForm})` : "";
      gloss = `${reading}${w.meaning}${base}`;
    }
    return [chips, make("div", "gloss", gloss)];
  }

  function ratingNote({ rating, looked }) {
    if (rating === "got") return "Counted as understood.";
    return looked.length ? `Added to Learning: ${looked.join(", ")}` : "Marked for review.";
  }

  function renderCard(box) {
    const { _region: region, _study: st, _hints: hints } = box;
    const focusedAct = shadow.activeElement?.dataset?.act;
    const parts = [];

    if (!st.english && !hints.clear && !hints.furigana && !hints.words) {
      parts.push(make("div", "prompt", "Try reading it first."));
    }
    if (hints.clear || hints.furigana) {
      const ja = make("div", "ja");
      ja.lang = "ja";
      ja.append(japaneseNodes(region, hints.furigana));
      parts.push(ja);
    }
    if (hints.words) parts.push(...wordHelpNodes(hints));
    if (st.english) {
      const en = make("div", "en", region.english);
      en.lang = "en";
      parts.push(en);
    }

    const row = make("div", "row");
    row.append(actionButton("clear", "Clear text", "C", hints.clear));
    if (canFurigana(box)) row.append(actionButton("furigana", "Furigana", "F", hints.furigana));
    if (isTracked(box)) row.append(actionButton("words", "Word help", "W", hints.words));
    if (!st.english) row.append(actionButton("english", "Show English", "E"));
    parts.push(row);

    if (st.english && isTracked(box)) {
      const rate = make("div", "row rate");
      rate.append(make("div", "muted", "Did you get it?"));
      for (const [act, label, key] of RATING_BUTTONS) rate.append(actionButton(act, label, key, st.rating === act));
      parts.push(rate);
      if (st.rating) parts.push(make("div", "muted note", ratingNote(st)));
    }

    card.replaceChildren(...parts);
    if (focusedAct) card.querySelector(`[data-act="${focusedAct}"]`)?.focus();
  }

  // Stays on one side of the bubble while its hints open, so the buttons
  // don't jump away from the pointer.
  function placeCard(box) {
    const r = rectOf(box);
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    cardSide ??= r.bottom + 6 + height <= scrollY + innerHeight ? "below" : "above";
    const wanted = cardSide === "below" ? r.bottom + 6 : r.top - height - 6;
    const top = Math.max(scrollY + 8, Math.min(wanted, scrollY + innerHeight - height - 8));
    card.style.top = `${top}px`;
    card.style.left = `${Math.max(scrollX + 8, Math.min(r.left, scrollX + innerWidth - width - 8))}px`;
  }

  function showCard(box) {
    if (!box) {
      card.hidden = true;
      cardSide = null;
      return;
    }
    renderCard(box);
    card.hidden = false;
    placeCard(box);
  }

  function sendStudy(boxes, patch) {
    const indices = boxes.filter(isTracked).map((b) => Number(b.dataset.index));
    if (!indices.length || pageId == null) return;
    chrome.runtime.sendMessage({ type: "study-update", pageId, indices, ...patch }).catch(() => {
      showStatus("The extension was reloaded. Refresh this page.", { error: true, hideAfter: 5000 });
    });
  }

  async function loadWords(box) {
    const hints = box._hints;
    if (hints.wordState?.status === "loading" || hints.wordState?.status === "done") return;
    hints.wordState = { status: "loading" };
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "word-help", pageId, index: Number(box.dataset.index) });
    } catch {
      res = { error: "The extension was reloaded. Refresh this page." };
    }
    hints.wordState = Array.isArray(res?.words)
      ? { status: "done", words: res.words }
      : { status: "error", error: res?.error ?? "Couldn't load word help. Try again." };
    if (box === hoverBox && !card.hidden) showCard(box);
  }

  function cardAction(box, action) {
    const { _study: st, _hints: hints } = box;
    if (action === "clear") {
      hints.clear = !hints.clear;
    } else if (action === "furigana") {
      if (!canFurigana(box)) return;
      hints.furigana = !hints.furigana;
    } else if (action === "words") {
      if (!isTracked(box)) return;
      hints.words = !hints.words;
      if (hints.words) loadWords(box);
    } else if (action === "english") {
      if (st.english) return;
      st.english = true;
      sendStudy([box], { english: true });
      renderBox(box);
    } else if (MARKS[action]) {
      if (!st.english || !isTracked(box)) return;
      st.rating = action;
      sendStudy([box], { rating: action });
      renderBox(box);
      updateControls();
      checkRecap();
    } else if (action.startsWith("word:")) {
      const i = Number(action.slice(5));
      const word = hints.wordState?.words?.[i];
      if (!word) return;
      hints.selected = i;
      if (!st.looked.includes(word.word)) st.looked.push(word.word);
      sendStudy([box], { look: word.word });
    }
    showCard(box);
  }

  card.addEventListener("click", (e) => {
    const button = e.target.closest("[data-act]");
    if (button && hoverBox) cardAction(hoverBox, button.dataset.act);
  });

  // Hint keys only work while a bubble's card is open, so they don't get in
  // the way of a reader's own shortcuts the rest of the time.
  addEventListener(
    "keydown",
    (e) => {
      if (!e.isTrusted || !hoverBox || card.hidden) return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat || e.isComposing) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
      const action = KEY_ACTIONS[e.key.toLowerCase()];
      if (!action) return;
      const st = hoverBox._study;
      if (action === "english" && st.english) return;
      if (MARKS[action] && (!st.english || !isTracked(hoverBox))) return;
      if (action === "furigana" && !canFurigana(hoverBox)) return;
      if (action === "words" && !isTracked(hoverBox)) return;
      e.preventDefault();
      e.stopPropagation();
      cardAction(hoverBox, action);
    },
    true
  );

  // The panel can reveal and rate too, so take its changes.
  function syncStudy(msg) {
    if (msg.pageId !== pageId) return;
    let hoverChanged = false;
    for (const box of layer.querySelectorAll(".box[data-index]")) {
      const next = msg.bubbles?.[box.dataset.index];
      if (!next) continue;
      const cur = box._study;
      const merged = {
        english: cur.english || next.english,
        rating: next.rating ?? cur.rating,
        looked: [...new Set([...cur.looked, ...next.looked])],
      };
      if (JSON.stringify(merged) === JSON.stringify(cur)) continue;
      box._study = merged;
      renderBox(box);
      if (box === hoverBox) hoverChanged = true;
    }
    if (hoverChanged && !card.hidden) showCard(hoverBox);
    updateControls();
    checkRecap();
  }

  // Once every bubble is rated, sum up the page.
  function checkRecap() {
    if (display.mode !== "study" || translating || recapShown) return;
    const boxes = currentBoxes();
    if (!boxes.length || !boxes.every((b) => b._study.rating)) return;
    recapShown = true;
    const got = boxes.filter((b) => b._study.rating === "got").length;
    const review = boxes.length - got;
    const text = review
      ? `Page done: ${got} of ${boxes.length} understood, ${review} to review.`
      : `Page done: all ${boxes.length} understood.`;
    const action = review
      ? {
          label: "Review",
          run: () =>
            chrome.runtime
              .sendMessage({ type: "open-panel" })
              .then((res) => {
                if (!res?.opened) showStatus("Press Alt+Shift+S to open the study panel.", { hideAfter: 4000 });
              })
              .catch(() => showStatus("The extension was reloaded. Refresh this page.", { error: true, hideAfter: 5000 })),
        }
      : null;
    showStatus(text, { hideAfter: 12000, action });
  }

  // ---------- Hover without blocking clicks ----------
  // Boxes ignore the mouse so clicks reach the page (some readers turn
  // pages on click). Instead, track the pointer and hit-test the boxes.

  let pointer = null;
  let hoverQueued = false;
  let leaveTimer = null;

  function cancelLeave() {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      pointer = { x: e.pageX, y: e.pageY };
      if (!hoverQueued) {
        hoverQueued = true;
        requestAnimationFrame(updateHover);
      }
    },
    { passive: true }
  );
  document.addEventListener("mouseleave", () => setHover(null));

  function updateHover() {
    hoverQueued = false;
    if (!pointer || layer.hidden || display.mode === "english" || revealAll) return setHover(null);
    if (!card.hidden && card.matches(":hover")) return cancelLeave();
    let found = null;
    for (const box of layer.children) {
      if (!box.getClientRects().length || box.classList.contains("offscreen")) continue; // e.g. sound effects off
      const r = rectOf(box);
      if (pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom) found = box;
    }
    if (found) {
      cancelLeave();
      setHover(found);
    } else if (hoverBox && leaveTimer === null) {
      // A short grace period to cross the gap from the bubble to its card.
      leaveTimer = setTimeout(() => {
        leaveTimer = null;
        if (!card.matches(":hover")) setHover(null);
      }, 200);
    }
  }

  function setHover(box) {
    if (box === hoverBox) return;
    cancelLeave();
    const prev = hoverBox;
    hoverBox = box;
    cardSide = null;
    if (prev?.isConnected) renderBox(prev);
    if (box) renderBox(box);
    showCard(display.mode === "study" && !revealAll ? box : null);
  }

  // ---------- Translation lifecycle ----------

  let view = null;
  let watchdog;
  let translating = false;
  let captureTargets = []; // the manga images in the current screenshot

  // ---------- Finding the manga and anchoring boxes to it ----------
  // Boxes are stored as fractions of their image, so they follow it when
  // the page resizes (opening the study panel does this) or an inner
  // container scrolls. Pages with no detectable image fall back to fixed
  // positions over the whole screenshot.

  const IMAGES = "img, canvas";
  const MIN_IMAGE_EDGE = 200;

  function findPageImages() {
    const found = [];
    for (const el of document.querySelectorAll(IMAGES)) {
      const r = el.getBoundingClientRect();
      if (r.width < MIN_IMAGE_EDGE || r.height < MIN_IMAGE_EDGE) continue;
      const left = Math.max(r.left, 0);
      const top = Math.max(r.top, 0);
      const right = Math.min(r.right, innerWidth);
      const bottom = Math.min(r.bottom, innerHeight);
      if (right <= left || bottom <= top) continue;
      const style = getComputedStyle(el);
      if (style.visibility !== "visible" || Number(style.opacity) < 0.05) continue;
      // Skip pages preloaded underneath the one being shown.
      const onTop = document.elementsFromPoint((left + right) / 2, (top + bottom) / 2).find((n) => n.matches(IMAGES));
      if (onTop && onTop !== el) continue;
      found.push({ el, rect: r, visible: { left, top, right, bottom }, area: (right - left) * (bottom - top) });
    }
    if (!found.length) return [];
    const main = found.reduce((a, b) => (b.area > a.area ? b : a));
    if (main.area < innerWidth * innerHeight * 0.15) return [];
    // Facing pages and long-strip panels are about as wide as the main one; ads usually aren't.
    return found
      .filter((f) => f.rect.width >= main.rect.width * 0.6)
      .map((f) => ({ ...f, src: f.el.getAttribute("src"), srcset: f.el.getAttribute("srcset") }));
  }

  function cropFor(targets) {
    if (!targets.length) return { left: 0, top: 0, width: innerWidth, height: innerHeight };
    const left = Math.min(...targets.map((t) => t.visible.left));
    const top = Math.min(...targets.map((t) => t.visible.top));
    const right = Math.max(...targets.map((t) => t.visible.right));
    const bottom = Math.max(...targets.map((t) => t.visible.bottom));
    return { left, top, width: right - left, height: bottom - top };
  }

  // False once the reader has removed this image or swapped in another page.
  const sameImage = (a) =>
    a.el.isConnected && a.el.getAttribute("src") === a.src && a.el.getAttribute("srcset") === a.srcset;

  function clipAncestors(el) {
    const out = [];
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/auto|scroll|hidden|clip/.test(s.overflowX + s.overflowY)) out.push(n);
    }
    return out;
  }

  function anchorFor(vx, vy, vw, vh) {
    const cx = vx + vw / 2;
    const cy = vy + vh / 2;
    const t = captureTargets.find(
      ({ rect: r }) => cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom
    );
    if (!t) return null;
    watchAnchor(t.el);
    return {
      el: t.el,
      src: t.src,
      srcset: t.srcset,
      clips: clipAncestors(t.el),
      x: (vx - t.rect.left) / t.rect.width,
      y: (vy - t.rect.top) / t.rect.height,
      w: vw / t.rect.width,
      h: vh / t.rect.height,
    };
  }

  // Moves a box to its image. Returns true if its size changed.
  function positionBox(box, clipRects) {
    const a = box._anchor;
    const r = a.el.getBoundingClientRect();
    const cx = r.left + (a.x + a.w / 2) * r.width;
    const cy = r.top + (a.y + a.h / 2) * r.height;
    const clipped = a.clips.some((c) => {
      if (!clipRects.has(c)) clipRects.set(c, c.getBoundingClientRect());
      const k = clipRects.get(c);
      return cx < k.left || cx > k.right || cy < k.top || cy > k.bottom;
    });
    const hidden = !r.width || !r.height || clipped;
    box.classList.toggle("offscreen", hidden);
    if (hidden) return false;
    const width = Math.max(a.w * r.width, 36);
    const height = Math.max(a.h * r.height, 20);
    const resized =
      Math.abs(width - parseFloat(box.style.width || 0)) > 0.5 ||
      Math.abs(height - parseFloat(box.style.height || 0)) > 0.5;
    box.style.left = `${scrollX + r.left + a.x * r.width}px`;
    box.style.top = `${scrollY + r.top + a.y * r.height}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    return resized;
  }

  function layoutBoxes() {
    layoutQueued = false;
    if (layer.hidden) return; // text can't be measured; runs again when shown
    const clipRects = new Map();
    let removed = false;
    const resized = new Set();
    for (const box of [...layer.children]) {
      if (!box._anchor) continue;
      if (!sameImage(box._anchor)) {
        box.remove();
        removed = true;
      } else if (positionBox(box, clipRects)) {
        resized.add(box);
      }
    }
    if (resized.size) {
      // Moving boxes can remove a scrollbar and shift the images, so place
      // them again. Text is fitted last because each box makes room for its neighbors.
      const settled = new Map();
      for (const box of layer.children) {
        if (box._anchor && positionBox(box, settled)) resized.add(box);
      }
      for (const box of resized) renderBox(box);
    }
    if (hoverBox && (!hoverBox.isConnected || hoverBox.classList.contains("offscreen"))) setHover(null);
    else if (hoverBox && !card.hidden) placeCard(hoverBox);
    if (removed) updateControls();
  }

  let layoutQueued = false;
  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(layoutBoxes);
  }

  const resizeWatcher = new ResizeObserver(() => queueLayout());
  const srcWatcher = new MutationObserver(() => queueLayout());
  const watched = new Set();
  resizeWatcher.observe(document.documentElement);

  function watchAnchor(el) {
    if (watched.has(el)) return;
    watched.add(el);
    resizeWatcher.observe(el);
    srcWatcher.observe(el, { attributes: true, attributeFilter: ["src", "srcset"] });
  }

  function unwatchAnchors() {
    resizeWatcher.disconnect();
    srcWatcher.disconnect();
    watched.clear();
    resizeWatcher.observe(document.documentElement);
  }

  // Boxes with no image can't follow a layout change, so they have to go.
  function dropUnanchored() {
    let dropped = 0;
    for (const box of [...layer.children]) {
      if (box._anchor) continue;
      box.remove();
      dropped++;
    }
    if (dropped) {
      if (hoverBox && !hoverBox.isConnected) setHover(null);
      updateControls();
    }
    if (translating && !captureTargets.length) abandonTranslation();
    return dropped;
  }

  // The page moved on, so bubbles still streaming in no longer belong to it.
  function abandonTranslation() {
    if (!translating) return;
    translating = false;
    view = null;
    clearTimeout(watchdog);
    chrome.runtime.sendMessage({ type: "cancel-translation" }).catch(() => {});
    if (auto.on) {
      status.hidden = true;
      queueAuto(); // the new page gets its own translation
    } else {
      showStatus("The page changed, so the translation was stopped.", { hideAfter: 3000 });
    }
  }

  // If the background worker goes silent (e.g. the browser stopped it),
  // don't leave "Translating…" on screen forever.
  function armWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      showStatus("Lost contact with the extension while translating. Press Alt+T to try again.", {
        error: true,
        hideAfter: 10000,
      });
    }, 120_000);
  }

  // Translations from earlier views stay on the page so scrolling back
  // doesn't cost a new request. Only boxes under the view being
  // re-translated are replaced.
  const MAX_BOXES = 400;

  function start(captureView, newPageId) {
    capturing = false;
    view = captureView;
    pageId = newPageId;
    recapShown = false;
    translating = true;
    revealAll = false;
    layer.hidden = false;
    layoutBoxes();
    const minX = view.scrollX + view.crop.left;
    const minY = view.scrollY + view.crop.top;
    for (const box of [...layer.children]) {
      const r = rectOf(box);
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      const inView =
        !box.classList.contains("offscreen") &&
        cx >= minX && cx <= minX + view.crop.width && cy >= minY && cy <= minY + view.crop.height;
      if (inView) {
        box.remove();
      } else {
        // The study panel only knows the newest translation.
        box.classList.add("stale");
        delete box.dataset.index;
      }
    }
    while (layer.childElementCount > MAX_BOXES) layer.firstElementChild.remove();
    renderAll();
    updateControls();
    showStatus("Translating…", { spinner: true });
    armWatchdog();
  }

  function addRegion(region, index) {
    if (!view || !translating) return;
    if (captureTargets.length && !captureTargets.some(sameImage)) return abandonTranslation();
    const { x, y, width, height } = region.box;
    if (![x, y, width, height].every(Number.isFinite)) return;
    armWatchdog();
    // Box coords are fractions of the image sent to Claude, which is the
    // crop. Multiplying by its size in CSS pixels undoes the
    // devicePixelRatio scaling and gives viewport coords.
    const fx = Math.min(Math.max(x, 0), 1);
    const fy = Math.min(Math.max(y, 0), 1);
    const vx = view.crop.left + fx * view.crop.width;
    const vy = view.crop.top + fy * view.crop.height;
    const vw = Math.min(Math.max(width, 0), 1 - fx) * view.crop.width;
    const vh = Math.min(Math.max(height, 0), 1 - fy) * view.crop.height;

    const box = document.createElement("div");
    box.className = region.kind === "sfx" ? "box sfx" : "box";
    box.dataset.index = index;
    box._region = region;
    box._study = newStudy();
    box._hints = newHints();
    box._anchor = anchorFor(vx, vy, vw, vh);
    if (box._anchor) {
      positionBox(box, new Map());
    } else {
      // Adding the scroll offset at capture time gives document coords.
      box.style.left = `${view.scrollX + vx}px`;
      box.style.top = `${view.scrollY + vy}px`;
      box.style.width = `${Math.max(vw, 36)}px`;
      box.style.height = `${Math.max(vh, 20)}px`;
    }
    layer.append(box);
    renderBox(box);
    updateControls();
    const n = layer.querySelectorAll(".box:not(.stale)").length;
    showStatus(`Translating… ${n} bubble${n === 1 ? "" : "s"} so far`, { spinner: true });
  }

  function finish({ count, seconds, cost, note }) {
    if (!translating) return;
    translating = false;
    clearTimeout(watchdog);
    const price = cost ? ` (about ${cost})` : "";
    const summary = count
      ? `Translated ${count} text region${count === 1 ? "" : "s"} in ${seconds.toFixed(1)}s${price}.`
      : `No Japanese text found in view${price}.`;
    const tip = count && display.mode === "study" ? " Try reading, then hover a bubble for hints." : "";
    showStatus(summary + tip + (note ?? ""), { hideAfter: note ? 8000 : 4500 });
    // Now that every bubble is here, refit so none widened into a later one.
    if (display.mode === "english" || revealAll) renderAll();
    checkRecap();
    rememberTranslation();
  }

  function showAfterCapture() {
    capturing = false;
    layer.hidden = false;
    layoutBoxes();
    renderAll();
    updateControls();
  }

  // ---------- Auto-translate ----------
  // Pages it has already translated come back for free. Nothing is sent
  // unless a manga image is showing and the reader recently scrolled,
  // clicked, or pressed a key, so an idle tab can't spend credits.

  const AUTO_SETTLE_MS = 700;
  const AUTO_INPUT_WINDOW_MS = 15_000;
  const AUTO_NEW_AREA = 0.4; // how much of the view must be new
  const AUTO_EDGE_PX = 40; // bubbles cut off at the screen edge still count as unread
  let autoTimer = null;
  let lastInput = 0;

  // Very long image addresses (data: URLs) are stored as a hash.
  function shortKey(text) {
    if (text.length <= 400) return text;
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    return `long:${text.length}:${(hash >>> 0).toString(16)}`;
  }

  function imageKey(el) {
    if (el.tagName === "CANVAS") {
      const index = [...document.querySelectorAll("canvas")].indexOf(el);
      return shortKey(`canvas:${index}:${location.href}`);
    }
    return shortKey(el.currentSrc || el.src);
  }

  const imageReady = ({ el }) => el.tagName !== "IMG" || (el.complete && el.naturalWidth > 0);

  function queueAuto({ restart = true, delay = AUTO_SETTLE_MS } = {}) {
    if (!auto.on || (autoTimer && !restart)) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(checkAuto, delay);
  }

  // Which part of the image the last screenshot could read in full.
  function capturedRange({ rect: r, visible: v }) {
    const top = clamp((v.top + (v.top > r.top + 1 ? AUTO_EDGE_PX : 0) - r.top) / r.height, 0, 1);
    const bottom = clamp((v.bottom - (v.bottom < r.bottom - 1 ? AUTO_EDGE_PX : 0) - r.top) / r.height, 0, 1);
    return [Math.min(top, bottom), Math.max(top, bottom)];
  }

  function rememberTranslation() {
    if (!auto.on || pageId == null) return;
    const images = [];
    for (const target of captureTargets) {
      if (!sameImage(target)) continue;
      const [top, bottom] = capturedRange(target);
      const boxes = [...layer.querySelectorAll(".box[data-index]")]
        .filter((b) => b._anchor?.el === target.el)
        .map((b) => ({ index: Number(b.dataset.index), x: b._anchor.x, y: b._anchor.y, w: b._anchor.w, h: b._anchor.h }));
      images.push({ key: imageKey(target.el), top, bottom, boxes });
    }
    if (!images.length) return;
    auto.remembering = true;
    chrome.runtime
      .sendMessage({ type: "auto-remember", pageId, images })
      .then((res) => {
        for (const [key, entry] of Object.entries(res?.images ?? {})) auto.images.set(key, entry);
      })
      .catch(() => {})
      .finally(() => {
        auto.remembering = false;
        queueAuto();
      });
  }

  // Readers that keep every page mounted just hide the old one.
  function dropCoveredPages(targets) {
    const showing = new Set(targets.map((t) => t.el));
    for (const box of [...layer.children]) {
      const el = box._anchor?.el;
      if (!el || showing.has(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) box.remove();
    }
  }

  function restoreCached(targets) {
    let added = false;
    for (const target of targets) {
      const entry = auto.images.get(imageKey(target.el));
      if (!entry?.boxes.length) continue;
      if ([...layer.children].some((b) => b._anchor?.el === target.el)) continue;
      watchAnchor(target.el);
      const clips = clipAncestors(target.el);
      for (const { region, x, y, w, h } of entry.boxes) {
        const box = document.createElement("div");
        box.className = region.kind === "sfx" ? "box sfx stale" : "box stale";
        box._region = region;
        box._study = newStudy();
        box._hints = newHints();
        box._anchor = { el: target.el, src: target.src, srcset: target.srcset, clips, x, y, w, h };
        positionBox(box, new Map());
        layer.append(box);
        added = true;
      }
    }
    if (!added) return;
    while (layer.childElementCount > MAX_BOXES) layer.firstElementChild.remove();
    renderAll();
    updateControls();
  }

  function needsTranslation(targets) {
    let seen = 0;
    let unread = 0;
    for (const target of targets) {
      const { rect: r, visible: v } = target;
      const top = (v.top - r.top) / r.height;
      const bottom = (v.bottom - r.top) / r.height;
      const area = (v.right - v.left) * (v.bottom - v.top);
      let covered = 0;
      for (const [a, b] of auto.images.get(imageKey(target.el))?.ranges ?? []) {
        covered += Math.max(0, Math.min(b, bottom) - Math.max(a, top));
      }
      seen += area;
      unread += area * (1 - covered / Math.max(bottom - top, 0.0001));
    }
    return seen > 0 && unread / seen >= AUTO_NEW_AREA;
  }

  async function checkAuto() {
    autoTimer = null;
    if (!auto.on || display.mode !== "english" || capturing || layer.hidden || document.hidden) return;
    if (translating) {
      // The reader moved on while this page was still translating.
      if (captureTargets.length && !captureTargets.some(sameImage)) abandonTranslation();
      return;
    }
    if (auto.remembering) return;
    const targets = findPageImages();
    if (!targets.length || !targets.every(imageReady)) return;
    dropCoveredPages(targets);
    restoreCached(targets);
    updateControls();
    if (!needsTranslation(targets) || Date.now() - lastInput > AUTO_INPUT_WINDOW_MS) return;

    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "auto-translate" });
    } catch {
      return;
    }
    if (res?.busy) queueAuto({ delay: 800 });
    if (res?.limit) {
      showStatus(`Auto-translate paused after ${res.limit} pages so it can't run up your bill.`, {
        action: { label: "Keep going", run: () => requestAuto(true) },
      });
    }
  }

  async function requestAuto(on) {
    if (!on) setAuto({ on: false, available: auto.available });
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "auto-toggle", on });
    } catch {
      showStatus("The extension was reloaded. Refresh this page.", { error: true, hideAfter: 5000 });
      return;
    }
    if (on && !res?.on) showStatus("Press Alt+T on this page to turn auto-translate on.", { hideAfter: 4000 });
  }

  const pageWatcher = new MutationObserver(() => queueAuto({ restart: false }));

  function setAuto(msg) {
    if (msg.display) Object.assign(display, msg.display);
    if (msg.showSfx !== undefined) layer.classList.toggle("hide-sfx", !msg.showSfx);
    if (msg.images) auto.images = new Map(Object.entries(msg.images));
    auto.available = Boolean(msg.available);
    const turnedOn = Boolean(msg.on) && !auto.on;
    auto.on = Boolean(msg.on);
    if (auto.on) {
      if (turnedOn) {
        pageWatcher.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["src", "srcset"],
        });
        // Starting it, or arriving on a new page because of it, counts as reading.
        if (!auto.started) lastInput = Date.now();
        auto.started = true;
        if (!translating) rememberTranslation();
      }
      queueAuto();
    } else {
      clearTimeout(autoTimer);
      autoTimer = null;
      pageWatcher.disconnect();
    }
    updateControls();
  }

  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    addEventListener(
      type,
      (e) => {
        if (!e.isTrusted) return;
        lastInput = Date.now();
        queueAuto();
      },
      { capture: true, passive: true }
    );
  }
  document.addEventListener("visibilitychange", () => queueAuto());
  document.addEventListener(
    "load",
    (e) => {
      if (e.target instanceof HTMLImageElement) queueAuto({ restart: false });
    },
    true
  );

  // Window scrolling is handled by document positioning. Many manga readers
  // scroll an inner element instead: anchored boxes follow it, and boxes
  // with no image are removed when a large inner scroller moves.
  document.addEventListener(
    "scroll",
    (e) => {
      if (layer.childElementCount) queueLayout();
      queueAuto();
      if (e.target === document) return;
      const el = e.target;
      if (!(el instanceof Element)) return;
      const viewportArea = innerWidth * innerHeight;
      if (el.clientWidth * el.clientHeight < viewportArea * 0.5) return;
      if (dropUnanchored()) {
        showStatus("Overlays cleared after scrolling. Press Alt+T to translate this view.", { hideAfter: 3000 });
      }
    },
    { capture: true, passive: true }
  );

  // ---------- Ctrl+click to study a bubble ----------
  // Boxes only take clicks while Ctrl is held, so normal clicks reach the page.

  const setInteractive = (on) => layer.classList.toggle("interactive", on && layer.childElementCount > 0);
  addEventListener("keydown", (e) => e.isTrusted && e.key === "Control" && setInteractive(true), true);
  addEventListener("keyup", (e) => e.isTrusted && e.key === "Control" && setInteractive(false), true);
  addEventListener("blur", () => {
    setInteractive(false);
    setHover(null);
  });

  layer.addEventListener("click", (e) => {
    const box = e.target.closest(".box");
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    if (box.dataset.index === undefined) {
      showStatus("That bubble is from an earlier view. Press Alt+T here to study it.", { hideAfter: 4000 });
      return;
    }
    highlight(Number(box.dataset.index));
    chrome.runtime
      .sendMessage({ type: "focus-region", index: Number(box.dataset.index) })
      .then((res) => {
        if (!res?.opened) showStatus("Press Alt+Shift+S to open the study panel.", { hideAfter: 4000 });
      })
      .catch(() => showStatus("The extension was reloaded. Refresh this page.", { error: true, hideAfter: 5000 }));
  });

  function highlight(index) {
    for (const box of layer.querySelectorAll(".box.highlight")) box.classList.remove("highlight");
    const box = layer.querySelector(`.box[data-index="${index}"]`);
    if (!box) return;
    box.classList.add("highlight");
    const r = box.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) box.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // A resize moves the images; anchored boxes follow them.
  addEventListener(
    "resize",
    () => {
      dropUnanchored();
      queueLayout();
      queueAuto();
    },
    { passive: true }
  );

  // Single-page readers change the URL without reloading on page turns.
  // An <img> with the same source is still the same page (long-strip readers
  // update the URL as you scroll), but a reused canvas may now show another.
  const survivesNavigation = (a) => a?.el.tagName === "IMG" && sameImage(a);
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (!captureTargets.some(survivesNavigation)) abandonTranslation();
    for (const box of [...layer.children]) {
      if (!survivesNavigation(box._anchor)) box.remove();
    }
    if (hoverBox && !hoverBox.isConnected) setHover(null);
    updateControls();
    queueAuto();
  }, 1000);

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function setDisplay({ mode, furigana }) {
    if (mode) display.mode = mode;
    if (furigana) display.furigana = furigana;
    renderAll();
    updateControls();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "prepare-capture":
        // Hide (don't delete) our boxes so they stay out of the screenshot.
        setHover(null);
        capturing = true;
        layer.hidden = true;
        card.hidden = true;
        status.hidden = true;
        controls.hidden = true;
        // Wait for the browser to repaint without our UI before capturing.
        nextFrame().then(() => {
          const targets = findPageImages();
          // With no manga image to crop to, the whole tab would be sent.
          // That takes a deliberate keypress, so auto-translate skips it.
          if (msg.auto && !targets.length) {
            showAfterCapture();
            sendResponse({ skip: true });
            return;
          }
          captureTargets = targets;
          sendResponse({
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            width: window.innerWidth,
            height: window.innerHeight,
            dpr: window.devicePixelRatio,
            crop: cropFor(captureTargets),
          });
        });
        return true; // keep the channel open for the async response
      case "start":
        layer.classList.toggle("hide-sfx", !msg.showSfx);
        if (msg.display) Object.assign(display, msg.display);
        auto.available = Boolean(msg.autoAvailable);
        start(msg.view, msg.pageId);
        break;
      case "capture-cancelled":
        showAfterCapture();
        break;
      case "auto-state":
        setAuto(msg);
        break;
      case "study-sync":
        syncStudy(msg);
        break;
      case "region":
        addRegion(msg.region, msg.index);
        break;
      case "highlight":
        highlight(msg.index);
        break;
      case "done":
        finish(msg);
        break;
      case "error":
        translating = false;
        clearTimeout(watchdog);
        showAfterCapture();
        showStatus(msg.message, { error: true, hideAfter: 10000 });
        break;
      case "set-sfx":
        layer.classList.toggle("hide-sfx", !msg.show);
        renderAll();
        break;
      case "set-display": {
        setDisplay(msg);
        const missing = display.mode !== "english" && [...layer.children].some((b) => !b._region.segments);
        if (missing) showStatus("Press Alt+T to get furigana for bubbles translated in English mode.", { hideAfter: 5000 });
        break;
      }
      case "reveal":
        toggleReveal();
        break;
      case "toggle":
        toggleLayer();
        break;
    }
  });
})();
