// app.js — NO imports, Alt1-compatible
(function () {
  const statusEl = document.getElementById("status");
  const modeEl   = document.getElementById("mode");
  const lockEl   = document.getElementById("lock");
  const dbgEl    = document.getElementById("debugBox");

  const startBtn = document.getElementById("startBtn");
  const stopBtn  = document.getElementById("stopBtn");
  const testBtn  = document.getElementById("testFlashBtn");

  function setStatus(v){ statusEl.textContent = v; }
  function setMode(v){ modeEl.textContent = v; }
  function setLock(v){ lockEl.textContent = v; }
  function dbg(v){ dbgEl.textContent = String(v); }

  const APP_V = Date.now();

  let running = false;
  let loop = null;
  let anchor = null;

  let flashing = false;
  async function flashOverlay() {
    if (!window.alt1 || !alt1.permissionOverlay || flashing) return;
    flashing = true;
    try {
      alt1.overLaySetGroup("progflash");
      alt1.overLayText("PROGFLASH", -16776961, 22, 30, 53, 900);
      await new Promise(r => setTimeout(r, 250));
      alt1.overLayClearGroup("progflash");
    } finally {
      flashing = false;
    }
  }

  function captureDebugPrefix() {
    const diag = window.progflashCaptureDiag || {};
    const alt1Keys = window.alt1 ? Object.keys(alt1).filter(k => k.toLowerCase().includes("capture")) : [];
    const alt1Fns  = window.alt1 ? alt1Keys.filter(k => typeof alt1[k] === "function") : [];
    const alt1Props = window.alt1 ? alt1Keys.filter(k => typeof alt1[k] !== "function") : [];
    return (
      `ProgFlash v=${APP_V}\n` +
      `anchor=${anchor ? anchor.width + "x" + anchor.height : "?"}\n` +
      `rsX=${window.alt1 ? alt1.rsX : "n/a"} rsY=${window.alt1 ? alt1.rsY : "n/a"}\n` +
      `rsW=${window.alt1 ? alt1.rsWidth : "n/a"} rsH=${window.alt1 ? alt1.rsHeight : "n/a"}\n` +
      `native captureRs: ${typeof window.captureRs}\n` +
      `native captureEvents: ${typeof window.captureEvents}\n` +
      `captureMode: ${diag.captureMode || ""}\n` +
      `cbCount: ${diag.cbCount || 0}\n` +
      `argSample: ${diag.argSample || ""}\n` +
      `lastErr: ${diag.lastErr || ""}\n` +
      `alt1.capture fns: ${alt1Fns.length ? alt1Fns.join(",") : "(none)"}\n` +
      `alt1.capture props: ${alt1Props.length ? alt1Props.join(",") : "(none)"}\n`
    );
  }

  function stop() {
    running = false;
    if (loop) clearInterval(loop);
    loop = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setMode("Not running");
    setStatus("Idle");
    setLock("none");
  }

  function tick() {
    if (!running) return;

    const img = window.progflashCaptureRs ? window.progflashCaptureRs() : null;
    if (!img) {
      dbg(captureDebugPrefix() + `captureRs(): null (capture failed)`);
      return;
    }

    const res = window.progflashFindAnchor(img, anchor, {
      tolerance: 65,
      stride: 1,
      minScore: 0.5,
      returnBest: true
    });

    const scoreTxt = (res && typeof res.score === "number") ? res.score.toFixed(3) : "n/a";
    dbg(
      captureDebugPrefix() +
      `img=${img.width}x${img.height}\n` +
      `best score=${scoreTxt}\n` +
      `ok=${!!(res && res.ok)}`
    );

    if (res && res.ok) {
      setStatus("Locked");
      setLock(`x=${res.x}, y=${res.y}`);
      flashOverlay();
    } else {
      setStatus("Searching…");
      setLock("none");
    }
  }

  async function start() {
    if (!window.alt1) { setStatus("Not in Alt1"); return; }
    if (!alt1.permissionPixel || !alt1.permissionOverlay) {
      setStatus("Missing permissions");
      dbg(`ProgFlash v=${APP_V}\noverlay=${alt1.permissionOverlay}\ncapture=${alt1.permissionPixel}`);
      return;
    }
    if (!window.progflashLoadImage || !window.progflashFindAnchor || !window.progflashCaptureRs) {
      setStatus("Missing matcher globals");
      dbg("matcher.js not loaded before app.js");
      return;
    }

    if (!anchor) {
      setStatus("Loading anchor…");
      anchor = await window.progflashLoadImage("./img/progbar_anchor.png?v=" + APP_V);
    }

    running = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;

    setMode("Running");
    setStatus("Searching…");
    setLock("none");

    tick(); // capture immediately
    if (loop) clearInterval(loop);
    loop = setInterval(tick, 200);
  }

  startBtn.onclick = () => start().catch(console.error);
  stopBtn.onclick  = () => stop();
  testBtn.onclick  = () => flashOverlay();

  setStatus("Idle");
  setMode("Not running");
  setLock("none");
  dbg("Ready…");
})();
