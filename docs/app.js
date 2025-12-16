// ProgFlash app_h_merged.js
// Final merge: rectangle fallback + triple-anchor fast lock (A+B+C)
// Safe integration with existing rectangle scan (no guessing required)

(() => {
  const $ = id => document.getElementById(id);

  const statusEl = $("status");
  const modeEl   = $("mode");
  const lockEl   = $("lock");
  const dbgEl    = $("debugBox");

  const startBtn     = $("startBtn");
  const stopBtn      = $("stopBtn");
  const autoFindBtn  = $("autoFindBtn");
  const clearLockBtn = $("clearLockBtn");

  function setStatus(v){ statusEl && (statusEl.textContent = v); }
  function setMode(v){ modeEl && (modeEl.textContent = v); }
  function setLock(v){ lockEl && (lockEl.textContent = v); }
  function dbg(v){ dbgEl && (dbgEl.textContent = typeof v === "string" ? v : JSON.stringify(v,null,2)); }

  const LS_MULTI = "progflash.multiAnchorABC";
  const LS_LOCK  = "progflash.lockPos";

  const save = (k,v)=>localStorage.setItem(k,JSON.stringify(v));
  const load = k=>{ try{return JSON.parse(localStorage.getItem(k));}catch{return null;} };
  const del  = k=>localStorage.removeItem(k);

  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  const rgba=(r,g,b,a)=>(r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24);

  function makeNeedle(w,h,bytes){
    return {
      width:w,height:h,data:bytes,
      getPixel(x,y){
        if(x<0||y<0||x>=w||y>=h) return 0;
        const i=(y*w+x)*4;
        return rgba(bytes[i],bytes[i+1],bytes[i+2],bytes[i+3]);
      }
    };
  }

  const b64ToBytes=b=>{
    const bin=atob(b); const o=new Uint8ClampedArray(bin.length);
    for(let i=0;i<bin.length;i++) o[i]=bin.charCodeAt(i)&255;
    return o;
  };

  const bytesToB64=b=>{
    let s=""; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]);
    return btoa(s);
  };

  const crop=(img,x,y,w,h)=>{
    const out=new Uint8ClampedArray(w*h*4); let k=0;
    for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
      const i=((y+yy)*img.width+(x+xx))*4;
      out[k++]=img.data[i];
      out[k++]=img.data[i+1];
      out[k++]=img.data[i+2];
      out[k++]=img.data[i+3];
    }
    return out;
  };

  const cap=r=>captureRegion(r.x,r.y,r.w,r.h);

  // ==================================================
  // FAST TRIPLE-ANCHOR LOCK
  // ==================================================
  function tryTripleAnchor(){
    const s=load(LS_MULTI);
    if(!s) return false;

    const rsW=alt1.rsWidth, rsH=alt1.rsHeight;

    const A=makeNeedle(s.A.w,s.A.h,b64ToBytes(s.A.b64));
    const B=makeNeedle(s.B.w,s.B.h,b64ToBytes(s.B.b64));
    const C=makeNeedle(s.C.w,s.C.h,b64ToBytes(s.C.b64));

    const search={ x:rsW*0.15|0, y:0, w:rsW*0.7|0, h:rsH*0.6|0 };
    const img=cap(search);
    if(!img) return false;

    const mA=findAnchor(img,A,{tolerance:55,step:2,minScore:0.02});
    if(!mA?.ok||mA.score<0.72) return false;

    const ax=search.x+mA.x, ay=search.y+mA.y;

    const imgB=cap({x:ax+s.dxB-8,y:ay+s.dyB-8,w:s.B.w+16,h:s.B.h+16});
    const mB=imgB&&findAnchor(imgB,B,{tolerance:55,step:1,minScore:0.02});
    if(!mB?.ok||mB.score<0.70) return false;

    const imgC=cap({x:ax+s.dxC-8,y:ay+s.dyC-8,w:s.C.w+16,h:s.C.h+16});
    const mC=imgC&&findAnchor(imgC,C,{tolerance:60,step:1,minScore:0.02});
    const cOK=!!(mC?.ok&&mC.score>=0.65);

    if(!cOK && !(mA.score>=0.80 && mB.score>=0.78)) return false;

    save(LS_LOCK,{x:ax,y:ay});
    setLock(`x=${ax}, y=${ay}`);
    setStatus("Locked (fast A+B+C)");
    setMode("Running");
    dbg({fast:true,A:mA.score,B:mB.score,C:cOK});
    return true;
  }

  // ==================================================
  // LEARN ANCHORS WHEN RECTANGLE LOCK SUCCEEDS
  // ==================================================
  function learnTripleAnchor(absRect){
    const img=cap(absRect);
    if(!img) return;

    const Aw=80,Ah=28,Ax=img.width-Aw-20,Ay=10;
    const Bw=120,Bh=20,Bx=(img.width-Bw)>>1,By=(img.height*0.55)|0;
    const Cw=26,Ch=26,Cx=img.width-Cw-10,Cy=10;

    save(LS_MULTI,{
      A:{w:Aw,h:Ah,b64:bytesToB64(crop(img,Ax,Ay,Aw,Ah))},
      B:{w:Bw,h:Bh,b64:bytesToB64(crop(img,Bx,By,Bw,Bh))},
      C:{w:Cw,h:Ch,b64:bytesToB64(crop(img,Cx,Cy,Cw,Ch))},
      dxB:Bx-Ax,dyB:By-Ay,
      dxC:Cx-Ax,dyC:Cy-Ay
    });

    dbg({learnedAnchors:true});
  }

  // ==================================================
  // RECTANGLE FALLBACK (SAFE HOOK)
  // ==================================================
  function fallbackScan(){
  setStatus("Fallback scan…");
  dbg("Rectangle detector running");

  // Trigger the SAME logic as clicking "Auto find"
  if (autoFindBtn && typeof autoFindBtn.onclick === "function") {
    autoFindBtn.onclick();
    return;
  }

  // Fallback: try Start button logic
  if (startBtn && typeof startBtn.onclick === "function") {
    startBtn.onclick();
    return;
  }

  dbg("ERROR: No scan entry point found");
}


  // Monkey-patch lock setter to learn anchors automatically
  if(typeof window.setLockedAt==="function"){
    const orig=window.setLockedAt;
    window.setLockedAt=function(x,y,absRect){
      if(absRect) learnTripleAnchor(absRect);
      return orig.apply(this,arguments);
    };
  }

  // ==================================================
  // START / UI
  // ==================================================
  function start(){
    if(!alt1||!alt1.permissionPixel){
      setStatus("Alt1 pixel permission missing");
      return;
    }
    setMode("Running");
    setStatus("Fast lock…");
    if(!tryTripleAnchor()) fallbackScan();
  }

  startBtn && (startBtn.onclick=start);
  autoFindBtn && (autoFindBtn.onclick=()=>{del(LS_MULTI);del(LS_LOCK);start();});
  clearLockBtn && (clearLockBtn.onclick=()=>{del(LS_MULTI);del(LS_LOCK);setLock("none");setStatus("Cleared");});
  stopBtn && (stopBtn.onclick=()=>{setMode("Idle");setStatus("Stopped");});

  setMode("Idle");
  setStatus("Idle");
})();
