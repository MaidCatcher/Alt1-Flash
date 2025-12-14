// app.js — Alt1 compatible (NO modules / NO imports)
// Requires matcher.js globals:
//   progflashCaptureRs, progflashLoadImage, progflashFindAnchor

/* ===================== DOM ===================== */

const statusEl   = document.getElementById("status");
const modeEl     = document.getElementById("mode");
const lockEl     = document.getElementById("lock");
const progressEl = document.getElementById("progressPct");
const dbgEl      = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");

const thresholdInput = document.getElementById("thresholdPct");
const flashStyleSel  = document.getElementById("flashStyle");

/* ===================== Helpers ===================== */

function setStatus(v){ statusEl.textContent = v; }
function setMode(v){ modeEl.textContent = v; }
function setLock(v){ lockEl.textContent = v; }
function setProgress(v){ progressEl.textContent = v; }
function dbg(v){ dbgEl.textContent = String(v); }

function rgba(r,g,b,a=255){
  return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24);
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

const APP_V = Date.now();

/* ===================== Settings ===================== */

const LS_THRESH = "progflash_threshold";
const LS_STYLE  = "progflash_flashstyle";

function loadSettings(){
  thresholdInput.value =
    Math.min(99, Math.max(1, parseInt(localStorage.getItem(LS_THRESH) || "95", 10)));
  flashStyleSel.value =
    localStorage.getItem(LS_STYLE) || "fullscreen";
}
function saveSettings(){
  localStorage.setItem(LS_THRESH, thresholdInput.value);
  localStorage.setItem(LS_STYLE, flashStyleSel.value);
}

thresholdInput.onchange = saveSettings;
flashStyleSel.onchange  = saveSettings;
loadSettings();

function getThreshold(){ return parseInt(thresholdInput.value, 10) || 95; }
function getFlashStyle(){ return flashStyleSel.value; }

/* ===================== Audio ===================== */

const audioCtx = window.AudioContext ? new AudioContext() : null;

function playBeep(){
  if (!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.value = 880;
  g.gain.value = 0.15;
  o.connect(g);
  g.connect(audioCtx.destination);
  o.start();
  setTimeout(()=>o.stop(),120);
}

/* ===================== Flash ===================== */

let flashing=false;
let lastFlashAt=0;
const FLASH_CD=1200;

async function flashText(){
  if (!alt1.permissionOverlay || flashing) return;
  if (Date.now()-lastFlashAt < FLASH_CD) return;
  flashing=true; lastFlashAt=Date.now();

  const g="progflash_flash";
  try{
    for(let i=0;i<2;i++){
      alt1.overLaySetGroup(g);
      alt1.overLayText("PROGFLASH",-1,36,40,80,700);
      await sleep(180);
      alt1.overLayClearGroup(g);
      await sleep(180);
    }
  }finally{
    alt1.overLayClearGroup(g);
    flashing=false;
  }
}

async function flashFullscreen(){
  if (!alt1.permissionOverlay || flashing) return;
  if (Date.now()-lastFlashAt < FLASH_CD) return;
  flashing=true; lastFlashAt=Date.now();

  const g="progflash_flash";
  const x=alt1.rsX||0, y=alt1.rsY||0;
  const w=alt1.rsWidth||0, h=alt1.rsHeight||0;

  try{
    for(let i=0;i<2;i++){
      alt1.overLaySetGroup(g);
      alt1.overLayRect(rgba(255,255,255,220),x,y,w,h,200,0);
      await sleep(120);
      alt1.overLayClearGroup(g);
      await sleep(120);
    }
  }finally{
    alt1.overLayClearGroup(g);
    flashing=false;
  }
}

function flashNow(){
  playBeep();
  return getFlashStyle()==="text" ? flashText() : flashFullscreen();
}

/* ===================== Progress ===================== */

function getPx(img,x,y){
  if(!img||x<0||y<0||x>=img.width||y>=img.height) return null;
  const i=(y*img.width+x)*4,d=img.data;
  return {r:d[i],g:d[i+1],b:d[i+2]};
}
function lum(p){ return (p.r*30+p.g*59+p.b*11)/100; }

function measureProgressPercent(img,x,y,w,h){
  const scanY=y+h+6;
  if(scanY<0||scanY>=img.height) return null;

  const ref=getPx(img,x+Math.floor(w/2),scanY);
  if(!ref) return null;

  let left=x,right=x;

  for(let i=0;i<900;i++){
    const p=getPx(img,x-i,scanY);
    if(!p||Math.abs(lum(p)-lum(ref))>20){ left=x-i+1; break; }
  }
  for(let i=0;i<1600;i++){
    const p=getPx(img,x+i,scanY);
    if(!p||Math.abs(lum(p)-lum(ref))>20){ right=x+i-1; break; }
  }

  const width=right-left;
  if(width<120) return null;

  let fillX=left;
  for(let px=left;px<=right;px++){
    const p=getPx(img,px,scanY);
    if(p && p.g>p.r+15 && p.g>p.b+15) fillX=px;
  }

  return Math.max(0,Math.min(100,((fillX-left)/width)*100));
}

/* ===================== Main ===================== */

let running=false, loop=null, anchor=null;
let lastPct=null, flashed=false;

function matcherReady(){
  return typeof window.progflashCaptureRs==="function";
}

async function start(){
  if(!alt1.permissionPixel||!alt1.permissionOverlay){
    setStatus("Missing permissions"); return;
  }
  if(!matcherReady()){
    setStatus("matcher.js not loaded"); return;
  }

  if(!anchor){
    anchor=await window.progflashLoadImage("./img/progbar_anchor.png?v="+APP_V);
  }

  running=true;
  startBtn.disabled=true;
  stopBtn.disabled=false;

  setMode("Running");
  setStatus("Searching…");
  setProgress("—");

  lastPct=null;
  flashed=false;

  loop=setInterval(()=>{
    if(!running) return;

    const img=window.progflashCaptureRs();
    if(!img) return;

    const res=window.progflashFindAnchor(img,anchor,{tolerance:65,returnBest:true});
    if(!res||!res.ok){
      setStatus("Searching…");
      setProgress("—");
      lastPct=null;
      flashed=false;
      return;
    }

    setStatus("Locked");
    setLock(`x=${res.x}, y=${res.y}`);

    const raw=measureProgressPercent(img,res.x,res.y,anchor.width,anchor.height);
    if(raw==null) return;

    let pct=Math.round(raw); // ✅ FIXED: let, not const

    // 🔒 Smooth + monotonic
    if(lastPct!=null){
      if(pct < lastPct-5 && pct < 10){
        flashed=false; // new craft
      }else{
        pct=Math.max(pct,lastPct);
      }
    }

    setProgress(pct+"%");

    const thresh=getThreshold();
    if(!flashed && pct>=thresh){
      flashed=true;
      flashNow();
    }

    lastPct=pct;

    dbg(
      `ProgFlash v=${APP_V}\n`+
      `progress=${pct}%\n`+
      `flashAt=${thresh}%\n`+
      `flashStyle=${getFlashStyle()}`
    );
  },120);
}

function stop(){
  running=false;
  if(loop) clearInterval(loop);
  loop=null;

  startBtn.disabled=false;
  stopBtn.disabled=true;

  setMode("Not running");
  setStatus("Idle");
  setProgress("—");

  lastPct=null;
  flashed=false;
}

startBtn.onclick=()=>start();
stopBtn.onclick =()=>stop();
testBtn.onclick =()=>flashNow();

setStatus("Idle");
setMode("Not running");
setProgress("—");
dbg(`ProgFlash v=${APP_V}\nReady`);
