// Content script: draws translation boxes over the page.
// Injected on demand by the background worker, so it may run more than
// once per page; the guard below keeps a single instance.
//
// Display modes:
//   english    - English covers each bubble.
//   read-first - Japanese (with furigana where you need it) covers each
//                bubble; hover a bubble to see the English.
//   hover      - The page is left as is, with a faint outline per bubble;
//                hover one for a card with furigana and English.

(() => {
  if (window.__yomuOverlay) return;
  window.__yomuOverlay = true;

  // Host element sits at the document's top-left corner. Boxes inside it
  // use document coordinates, so they scroll with the page for free.
  const host = document.createElement("yomu-overlay-root");
  host.style.cssText =
    "all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; " +
    "z-index: 2147483647; pointer-events: none;";
  const shadow = host.attachShadow({ mode: "open" });
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
      .box.ja, .card .ja {
        font-family: "Yu Gothic UI", "Meiryo", "Hiragino Sans", "Noto Sans JP", sans-serif;
        line-height: 1.5;
        overflow-wrap: normal;
        word-break: keep-all;
        line-break: strict;
      }
      .box.vertical { writing-mode: vertical-rl; }
      rt { font-size: 0.5em; font-weight: 500; color: #555; }
      .box.sfx { background: rgba(255, 244, 200, 0.92); font-style: italic; }
      .box.outline { background: transparent; box-shadow: 0 0 0 2px rgba(216, 67, 21, 0.45); }
      .box.outline.hovered { box-shadow: 0 0 0 2px #d84315; }
      .box.revealed { background: #fff8e1; }
      .layer.hide-sfx .box.sfx { display: none; }
      /* While Ctrl is held, boxes become clickable to open them in the study panel. */
      .layer.interactive .box { pointer-events: auto; cursor: pointer; }
      .layer.interactive .box:hover, .box.highlight { box-shadow: 0 0 0 3px #d84315; }
      .card {
        position: absolute;
        box-sizing: border-box;
        min-width: 160px;
        max-width: 300px;
        padding: 8px 12px;
        border-radius: 10px;
        background: #fff;
        color: #111;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.3);
        font: 14px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif;
        pointer-events: none;
      }
      .card .ja { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
      .card .en { color: #333; }
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
    <div class="status" hidden></div>
  `;
  document.documentElement.appendChild(host);

  const layer = shadow.querySelector(".layer");
  const card = shadow.querySelector(".card");
  const status = shadow.querySelector(".status");
  let statusTimer;
  let lastUrl = location.href;

  // How bubbles are shown. Updated by "start" and "set-display" messages.
  const display = { mode: "english", furigana: "above-level" };
  let revealAll = false;
  let hoverBox = null;

  status.addEventListener("click", () => (status.hidden = true));

  function showStatus(text, { error = false, spinner = false, hideAfter = 0 } = {}) {
    clearTimeout(statusTimer);
    status.className = error ? "status error" : "status";
    status.textContent = "";
    if (spinner) {
      const s = document.createElement("span");
      s.className = "spinner";
      status.append(s);
    }
    status.append(text);
    status.hidden = false;
    if (hideAfter) statusTimer = setTimeout(() => (status.hidden = true), hideAfter);
  }

  function clearOverlays() {
    layer.replaceChildren();
    setHover(null);
  }

  // ---------- Rendering one bubble ----------

  // Should this word get furigana? Flags come from the background worker,
  // which knows your level and known words.
  function wantsReading(seg) {
    if (!seg.reading || !seg.hasKanji || seg.known) return false;
    if (display.furigana === "unknown-words") return true;
    if (display.furigana === "above-level") return seg.aboveLevel;
    return false;
  }

  function japaneseNodes(region) {
    const frag = document.createDocumentFragment();
    if (!region.segments?.length) {
      frag.append(region.japanese);
      return frag;
    }
    for (const seg of region.segments) {
      if (wantsReading(seg)) {
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

  function renderBox(box) {
    const region = box._region;
    const english =
      display.mode === "english" || revealAll || (display.mode === "read-first" && box === hoverBox);
    const outline = display.mode === "hover" && !revealAll;

    box.classList.toggle("outline", outline);
    box.classList.toggle("hovered", outline && box === hoverBox);
    box.classList.toggle("revealed", english && display.mode !== "english");
    box.classList.remove("ja", "vertical");

    if (outline) {
      box.replaceChildren();
      return;
    }
    if (english) {
      box.textContent = region.english;
    } else {
      box.replaceChildren(japaneseNodes(region));
      box.classList.add("ja");
      // Tall, narrow bubbles are usually vertical text.
      if (box.offsetHeight > box.offsetWidth * 1.4) box.classList.add("vertical");
    }
    fitText(box);
  }

  function renderAll() {
    for (const box of layer.children) renderBox(box);
    showCard(display.mode === "hover" && !revealAll ? hoverBox : null);
  }

  // Shrink the font until the text fits inside its box.
  function fitText(el) {
    let size = 16;
    el.style.fontSize = `${size}px`;
    while (size > 8 && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
  }

  const rectOf = (box) => {
    const left = parseFloat(box.style.left);
    const top = parseFloat(box.style.top);
    return { left, top, right: left + parseFloat(box.style.width), bottom: top + parseFloat(box.style.height) };
  };

  // Hover card for "hover" mode: Japanese with furigana, then English.
  function showCard(box) {
    if (!box) {
      card.hidden = true;
      return;
    }
    const region = box._region;
    const ja = document.createElement("div");
    ja.className = "ja";
    ja.append(japaneseNodes(region));
    const en = document.createElement("div");
    en.className = "en";
    en.textContent = region.english;
    card.replaceChildren(ja, en);
    card.hidden = false;

    const r = rectOf(box);
    card.style.left = `${Math.max(scrollX + 8, Math.min(r.left, scrollX + innerWidth - card.offsetWidth - 8))}px`;
    const below = r.bottom + 6;
    const fitsBelow = below + card.offsetHeight < scrollY + innerHeight;
    card.style.top = `${fitsBelow ? below : Math.max(scrollY + 8, r.top - card.offsetHeight - 6)}px`;
  }

  // ---------- Hover without blocking clicks ----------
  // Boxes ignore the mouse so clicks reach the page (some readers turn
  // pages on click). Instead, track the pointer and hit-test the boxes.

  let pointer = null;
  let hoverQueued = false;

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
    let found = null;
    for (const box of layer.children) {
      if (!box.getClientRects().length) continue; // hidden (e.g. sound effects off)
      const r = rectOf(box);
      if (pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom) found = box;
    }
    setHover(found);
  }

  function setHover(box) {
    if (box === hoverBox) return;
    const prev = hoverBox;
    hoverBox = box;
    if (prev?.isConnected) renderBox(prev);
    if (box) renderBox(box);
    showCard(display.mode === "hover" && !revealAll ? box : null);
  }

  // ---------- Translation lifecycle ----------

  let view = null;
  let watchdog;

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

  function start(captureView) {
    view = captureView;
    revealAll = false;
    for (const box of [...layer.children]) {
      const r = rectOf(box);
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      const inView =
        cx >= view.scrollX && cx <= view.scrollX + view.width && cy >= view.scrollY && cy <= view.scrollY + view.height;
      if (inView) {
        box.remove();
      } else {
        // The study panel only knows the newest translation.
        box.classList.add("stale");
        delete box.dataset.index;
      }
    }
    while (layer.childElementCount > MAX_BOXES) layer.firstElementChild.remove();
    layer.hidden = false;
    renderAll();
    showStatus("Translating…", { spinner: true });
    armWatchdog();
  }

  function addRegion(region, index) {
    if (!view) return;
    armWatchdog();
    const { x, y, width, height } = region.box;
    // Box coords are fractions of the screenshot, which is the viewport.
    // Multiplying by the viewport size in CSS pixels undoes the
    // devicePixelRatio scaling, and adding the scroll offset at capture
    // time turns viewport coords into document coords.
    const left = view.scrollX + x * view.width;
    const top = view.scrollY + y * view.height;
    const w = Math.max(width * view.width, 36);
    const h = Math.max(height * view.height, 20);

    const box = document.createElement("div");
    box.className = region.kind === "sfx" ? "box sfx" : "box";
    box.dataset.index = index;
    box._region = region;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    layer.append(box);
    renderBox(box);
    const n = layer.querySelectorAll(".box:not(.stale)").length;
    showStatus(`Translating… ${n} bubble${n === 1 ? "" : "s"} so far`, { spinner: true });
  }

  function finish({ count, seconds, cost, note }) {
    clearTimeout(watchdog);
    const price = cost ? ` (about ${cost})` : "";
    const summary = count
      ? `Translated ${count} text region${count === 1 ? "" : "s"} in ${seconds.toFixed(1)}s${price}.`
      : `No Japanese text found in view${price}.`;
    const tip = count && display.mode !== "english" ? " Hover a bubble for English." : "";
    showStatus(summary + tip + (note ?? ""), { hideAfter: note ? 8000 : 3500 });
  }

  // Window scrolling is handled by document positioning. Many manga readers
  // scroll an inner element instead; we can't follow that, so hide the
  // overlays when a large inner scroller moves.
  document.addEventListener(
    "scroll",
    (e) => {
      if (!layer.childElementCount || e.target === document) return;
      const el = e.target;
      if (!(el instanceof Element)) return;
      const viewportArea = innerWidth * innerHeight;
      if (el.clientWidth * el.clientHeight < viewportArea * 0.5) return;
      clearOverlays();
      showStatus("Overlays cleared after scrolling. Press Alt+T to translate this view.", { hideAfter: 3000 });
    },
    { capture: true, passive: true }
  );

  // ---------- Ctrl+click to study a bubble ----------
  // Boxes only take clicks while Ctrl is held, so normal clicks reach the page.

  const setInteractive = (on) => layer.classList.toggle("interactive", on && layer.childElementCount > 0);
  addEventListener("keydown", (e) => e.key === "Control" && setInteractive(true), true);
  addEventListener("keyup", (e) => e.key === "Control" && setInteractive(false), true);
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

  // A resize changes layout, so old positions are wrong.
  addEventListener("resize", () => clearOverlays(), { passive: true });

  // Single-page readers change the URL without reloading on page turns.
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      clearOverlays();
    }
  }, 1000);

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function setDisplay({ mode, furigana }) {
    if (mode) display.mode = mode;
    if (furigana) display.furigana = furigana;
    renderAll();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "prepare-capture":
        // Hide (don't delete) our boxes so they stay out of the screenshot.
        layer.hidden = true;
        card.hidden = true;
        status.hidden = true;
        // Wait for the browser to repaint without our UI before capturing.
        nextFrame().then(() =>
          sendResponse({
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            width: window.innerWidth,
            height: window.innerHeight,
            dpr: window.devicePixelRatio,
          })
        );
        return true; // keep the channel open for the async response
      case "start":
        layer.classList.toggle("hide-sfx", !msg.showSfx);
        if (msg.display) Object.assign(display, msg.display);
        start(msg.view);
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
        clearTimeout(watchdog);
        layer.hidden = false;
        showStatus(msg.message, { error: true, hideAfter: 10000 });
        break;
      case "set-sfx":
        layer.classList.toggle("hide-sfx", !msg.show);
        break;
      case "set-display": {
        setDisplay(msg);
        const missing = display.mode !== "english" && [...layer.children].some((b) => !b._region.segments);
        if (missing) showStatus("Press Alt+T to get furigana for bubbles translated in English mode.", { hideAfter: 5000 });
        break;
      }
      case "reveal":
        if (!layer.childElementCount) {
          showStatus("Nothing to reveal yet. Press Alt+T to translate.", { hideAfter: 2500 });
          break;
        }
        revealAll = !revealAll;
        layer.hidden = false;
        setHover(null);
        renderAll();
        showStatus(revealAll ? "Showing English for every bubble. Press again to hide." : "English hidden.", {
          hideAfter: 2500,
        });
        break;
      case "toggle":
        if (!layer.childElementCount) {
          showStatus("Nothing to show yet. Press Alt+T to translate.", { hideAfter: 2500 });
        } else {
          layer.hidden = !layer.hidden;
          if (layer.hidden) setHover(null);
        }
        break;
    }
  });
})();
