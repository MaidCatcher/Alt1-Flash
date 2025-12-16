// ProgFlash app_i.js
// Adds LIVE A/B/C overlay boxes to preview canvas
// No detection logic changed

(() => {
  const $ = id => document.getElementById(id);

  const statusEl = $("status");
  const modeEl   = $("mode");
  const lockEl   = $("lock");
  const dbgEl    = $("debugBox");

  const canvas = $("previewCanvas");
  const ctx = canvas.getContext("2d");

  const startBtn     = $("startBtn");
  const stopBtn      = $("stopBtn");
  const autoFindBtn  = $("autoFindBtn");
  const clearLockBtn = $("clearLockBtn");

  function setStatus(v){ statusEl && (statusEl.textContent=v); }
  function setMode(v){ modeEl && (modeEl.textContent=v); }
  function setLock(v){ lockEl && (lockEl.textContent=v); }
  function dbg(v){ dbgEl && (dbgEl.textContent=typeof v==="string"?v:JSON.stringify(v,null,2)); }

  const LS_MULTI = "progflash.multiAnchorABC";
  const LS_LOCK  = "progflash.lockPos";

  const load = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const del  = k => localStorage.removeItem(k);

  function drawBox(x,y,w,h,color,label){
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x,y,w,h);
    ctx.fillStyle = color;
    ctx.font = "12px Arial";
    ctx.fillText(label, x+3, y-4);
  }

  function clearPreview(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
  }

  function drawAnchorsLive(baseX, baseY){
    const s = load(LS_MULTI);
    if(!s) return;

    clearPreview();

    const scaleX = canvas.width  / alt1.rsWidth;
    const scaleY = canvas.height / alt1.rsHeight;

    const Ax = baseX;
    const Ay = baseY;

    const Bx = baseX + s.dxB;
    const By = baseY + s.dyB;

    const Cx = baseX + s.dxC;
    const Cy = baseY + s.dyC;

    drawBox(
      Ax*scaleX, Ay*scaleY,
      s.A.w*scaleX, s.A.h*scaleY,
      "#00ffff", "A"
    );

    drawBox(
      Bx*scaleX, By*scaleY,
      s.B.w*scaleX, s.B.h*scaleY,
      "#00ff00", "B"
    );

    drawBox(
      Cx*scaleX, Cy*scaleY,
      s.C.w*scaleX, s.C.h*scaleY,
      "#ff9900", "C"
    );
  }

  // ---- Hook fast-lock to draw overlays ----
  if (typeof window.tryTripleAnchor === "function") {
    const origTry = window.tryTripleAnchor;
    window.tryTripleAnchor = function(){
      const ok = origTry.apply(this, arguments);
      const lock = load(LS_LOCK);
      if(lock){
        drawAnchorsLive(lock.x, lock.y);
      }
      return ok;
    };
  }

  // ---- Hook rectangle lock ----
  if (typeof window.setLockedAt === "function") {
    const origSet = window.setLockedAt;
    window.setLockedAt = function(x,y){
      origSet.apply(this, arguments);
      drawAnchorsLive(x,y);
    };
  }

  // ---- UI ----
  startBtn && (startBtn.onclick = () => {
    clearPreview();
    setStatus("Fast lock...");
    setMode("Running");
    if(typeof window.tryTripleAnchor==="function"){
      if(window.tryTripleAnchor()) return;
    }
    if(typeof autoFindBtn?.onclick==="function") autoFindBtn.onclick();
  });

  stopBtn && (stopBtn.onclick = () => {
    clearPreview();
    setMode("Idle");
    setStatus("Stopped");
  });

  clearLockBtn && (clearLockBtn.onclick = () => {
    del(LS_MULTI);
    del(LS_LOCK);
    clearPreview();
    setLock("none");
    setStatus("Cleared");
  });

  setMode("Idle");
  setStatus("Idle");
})();
