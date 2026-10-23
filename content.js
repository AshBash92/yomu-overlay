// Content script: draws translation boxes over the page.
// Injected on demand by the background worker, so it may run more than
// once per page; the guard below keeps a single instance.

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
      .box.sfx { background: rgba(255, 244, 200, 0.92); font-style: italic; }
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
    <div class="status" hidden></div>
  `;
  document.documentElement.appendChild(host);

  const layer = shadow.querySelector(".layer");
  const status = shadow.querySelector(".status");
  let statusTimer;
  let lastUrl = location.href;

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
  }

  // State for the translation in progress.
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

  function start(captureView) {
    view = captureView;
    clearOverlays();
    layer.hidden = false;
    showStatus("Translating…", { spinner: true });
    armWatchdog();
  }

  function addRegion(region) {
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
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    box.textContent = region.english;
    layer.append(box);
    fitText(box);
    const n = layer.childElementCount;
    showStatus(`Translating… ${n} bubble${n === 1 ? "" : "s"} so far`, { spinner: true });
  }

  function finish({ count, seconds, note }) {
    clearTimeout(watchdog);
    const summary = count
      ? `Translated ${count} text region${count === 1 ? "" : "s"} in ${seconds.toFixed(1)}s.`
      : "No Japanese text found in view.";
    showStatus(summary + (note ?? ""), { hideAfter: note ? 8000 : 3000 });
  }

  // Shrink the font until the translation fits inside its box.
  function fitText(el) {
    let size = 16;
    el.style.fontSize = `${size}px`;
    while (size > 8 && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "prepare-capture":
        clearOverlays();
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
        start(msg.view);
        break;
      case "region":
        addRegion(msg.region);
        break;
      case "done":
        finish(msg);
        break;
      case "error":
        clearTimeout(watchdog);
        showStatus(msg.message, { error: true, hideAfter: 10000 });
        break;
      case "toggle":
        if (!layer.childElementCount) {
          showStatus("Nothing to show yet. Press Alt+T to translate.", { hideAfter: 2500 });
        } else {
          layer.hidden = !layer.hidden;
        }
        break;
    }
  });
})();
