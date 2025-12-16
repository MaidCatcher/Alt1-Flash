// ProgFlash app_g.js
// Triple-anchor geometry lock (A + B + C)
// A = dialog frame (stable)
// B = progress bar frame (stable, no fill)
// C = close X OR cancel button frame (confirmation)
//
// Requires matcher.js:
//   captureRegion(x,y,w,h)
//   findAnchor(haystackImg, needleImg, opts)

(() => {
  const $ = id => document.getElementById(id);

  const statusEl = $("status");
  const modeEl   = $("mode");
  const lockEl   = $("lock");
  const dbgEl    = $("debugBox");

  const startBtn     = $("startBtn");
  const autoFindBtn  = $("autoFindBtn");
  const clearLockBtn = $("clearLockBtn");

  function setStatus(v){ if(statusEl) statusEl.textContent=v; }
  function setMode(v){ if(modeEl) modeEl.textContent=v; }
  function setLock(v){ if(lockEl) lockEl.textContent=v; }
  function dbg(v){ if(dbgEl) dbgEl.textContent = typeof v==="string" ? v : JSON.stringify(v,null,2); }

  // ---------- Storage ----------
  const LS_MULTI = "progflash.multiAnchorABC";
  const LS_LOCK  = "progflash.lockPos";

  function save(k,v){ localStorage.setItem(k, JSON.stringify(v)); }
  function load(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch{return null;} }
  function del(k){ localStorage.removeItem(k); }

  // ---------- Utils ----------
  function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
  function rgba(r,g,b,a){ return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24); }

  function makeNeedle(w,h,bytes){
    return {
      width:w, height:h, data:bytes,
      getPixel(x,y){
        if(x<0||y<0||x>=w||y>=h) return 0;
        const i=(y*w+x)*4;
        return rgba(bytes[i],bytes[i+1],bytes[i+2],bytes[i+3]);
      }
    };
  }

  function bytesToB64(b){
    let s=""; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]);
    return btoa(s);
  }
  function b64ToBytes(b){
    const bin=atob(b); const o=new Uint8ClampedArray(bin.length);
    for(let i=0;i<bin.length;i++) o[i]=bin.charCodeAt(i)&255;
    return o;
  }

  function crop(img,x,y,w,h){
    const out=new Uint8ClampedArray(w*h*4); let k=0;
    for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
      const i=((y+yy)*img.width+(x+xx))*4;
      out[k++]=img.data[i];
      out[k++]=img.data[i+1];
      out[k++]=img.data[i+2];
      out[k++]=img.data[i+3];
    }
    return out;
  }

  function cap(r){ return captureRegion(r.x,r.y,r.w,r.h); }

  // ==================================================
  // FAST VERIFY: A + B + C
  // ==================================================
  function tryTripleAnchor(){
    const stored = load(LS_MULTI);
    if(!stored) return false;

    const rsW = alt1.rsWidth, rsH = alt1.rsHeight;

    const A = makeNeedle(stored.A.w, stored.A.h, b64ToBytes(stored.A.b64));
    const B = makeNeedle(stored.B.w, stored.B.h, b64ToBytes(stored.B.b64));
    const C = makeNeedle(stored.C.w, stored.C.h, b64ToBytes(stored.C.b64));

    // Search area: top-middle (fast, correct for most users)
    const search = {
      x: Math.floor(rsW * 0.15),
      y: 0,
      w: Math.floor(rsW * 0.7),
      h: Math.floor(rsH * 0.6)
    };

    const img = cap(search);
    if(!img) return false;

    const mA = findAnchor(img, A, { tolerance:55, step:2, minScore:0.02 });
    if(!mA?.ok || mA.score < 0.72) return false;

    const ax = search.x + mA.x;
    const ay = search.y + mA.y;

    // ----- Anchor B -----
    const bx = ax + stored.dxB;
    const by = ay + stored.dyB;
    const padB = 8;

    const imgB = cap({
      x: clamp(bx-padB,0,rsW-1),
      y: clamp(by-padB,0,rsH-1),
      w: stored.B.w + padB*2,
      h: stored.B.h + padB*2
    });
    if(!imgB) return false;

    const mB = findAnchor(imgB, B, { tolerance:55, step:1, minScore:0.02 });
    if(!mB?.ok || mB.score < 0.70) return false;

    // ----- Anchor C -----
    const cx = ax + stored.dxC;
    const cy = ay + stored.dyC;
    const padC = 8;

    let cOK = false;
    const imgC = cap({
      x: clamp(cx-padC,0,rsW-1),
      y: clamp(cy-padC,0,rsH-1),
      w: stored.C.w + padC*2,
      h: stored.C.h + padC*2
    });

    if(imgC){
      const mC = findAnchor(imgC, C, { tolerance:60, step:1, minScore:0.02 });
      if(mC?.ok && mC.score >= 0.65) cOK = true;
    }

    // ----- Final decision -----
    const strongAB = (mA.score >= 0.80 && mB.score >= 0.78);

    if(!cOK && !strongAB) return false;

    save(LS_LOCK,{ x:ax, y:ay });
    setLock(`x=${ax}, y=${ay}`);
    setStatus("Locked (A+B+C)");
    setMode("Running");

    dbg({
      locked:true,
      A:mA.score.toFixed(2),
      B:mB.score.toFixed(2),
      C: cOK ? "ok" : "skipped"
    });

    return true;
  }

  // ==================================================
  // LEARN A + B + C (called after fallback succeeds)
  // ==================================================
  function learnTripleAnchor(absRect){
    const img = cap(absRect);
    if(!img) return false;

    // ---- Anchor A: frame (top-right) ----
    const Aw=80, Ah=28;
    const Ax=img.width-Aw-20;
    const Ay=10;

    // ---- Anchor B: progress bar frame ----
    const Bw=120, Bh=20;
    const Bx=Math.floor((img.width-Bw)/2);
    const By=Math.floor(img.height*0.55);

    // ---- Anchor C: close X (preferred) or cancel frame ----
    const Cw=26, Ch=26;
    const Cx=img.width-Cw-10;
    const Cy=10;

    save(LS_MULTI,{
      A:{ w:Aw, h:Ah, b64: bytesToB64(crop(img,Ax,Ay,Aw,Ah)) },
      B:{ w:Bw, h:Bh, b64: bytesToB64(crop(img,Bx,By,Bw,Bh)) },
      C:{ w:Cw, h:Ch, b64: bytesToB64(crop(img,Cx,Cy,Cw,Ch)) },
      dxB: Bx-Ax,
      dyB: By-Ay,
      dxC: Cx-Ax,
      dyC: Cy-Ay
    });

    dbg({ learned:true, anchors:["A","B","C"] });
    return true;
  }

  // ==================================================
  // FALLBACK (your existing app_f logic plugs here)
  // ==================================================
  function fallbackScan(){
    setStatus("Fallback scan…");
    dbg("Use existing rectangle scan; on success call learnTripleAnchor(absRect)");
  }

  // ==================================================
  // UI
  // ==================================================
  function start(){
    if(!alt1 || !alt1.permissionPixel){
      setStatus("Alt1 pixel permission missing");
      return;
    }
    setMode("Running");
    setStatus("Fast lock (A+B+C)…");
    if(tryTripleAnchor()) return;
    fallbackScan();
  }

  if(startBtn) startBtn.onclick=start;
  if(autoFindBtn) autoFindBtn.onclick=()=>{ del(LS_MULTI); del(LS_LOCK); start(); };
  if(clearLockBtn) clearLockBtn.onclick=()=>{ del(LS_MULTI); del(LS_LOCK); setLock("none"); setStatus("Cleared"); };

  setMode("Idle");
  setStatus("Idle");
})();
