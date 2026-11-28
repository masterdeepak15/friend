/**
 * Runs in every page of the meeting before the site's own scripts, and gives the browser a microphone and ears without any driver on the PC:
 *  - the microphone the site asks for is a stream the page makes itself; it is silent until `__friend.speak` plays a sound into it;
 *  - every remote audio track of a call (the other people) is also listened to, a little at a time, as 16 kHz 16-bit sound that
 *    `__friend.take` hands over. Nothing is kept in the page beyond what was not taken yet.
 */
export const audioHook = (name: string): string => String.raw`(() => {
  if (window.__friend) return;
  const NAME = ${JSON.stringify(name)};
  const F = (window.__friend = { ctx: null, dest: null, rctx: null, proc: null, chunks: [], samples: 0, tapped: new Set(), speaking: false });
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = () => (F.ctx = F.ctx || new AC());
  const dest = () => (F.dest = F.dest || ctx().createMediaStreamDestination());

  // the camera: a picture of our own that moves with the voice, instead of a test pattern
  F.heard = 0;
  F.say = 0;
  const cv = document.createElement("canvas");
  cv.width = 640;
  cv.height = 360;
  const g = cv.getContext("2d");
  const t0 = Date.now();
  let smooth = 0;
  let hearSmooth = 0;
  const level = () => {
    if (!F.an) return 0;
    const b = F.anBuf || (F.anBuf = new Uint8Array(F.an.fftSize));
    F.an.getByteTimeDomainData(b);
    let s = 0;
    for (let i = 0; i < b.length; i++) { const v = (b[i] - 128) / 128; s += v * v; }
    return Math.min(1, Math.sqrt(s / b.length) * 4);
  };
  const draw = () => {
    const t = (Date.now() - t0) / 1000;
    const speaking = F.speaking ? level() : 0;
    smooth += (speaking - smooth) * 0.35;
    hearSmooth += (Math.min(1, F.heard * 5) - hearSmooth) * 0.25;
    F.heard *= 0.85;
    const w = cv.width, h = cv.height, cx = w / 2, cy = h / 2 - 14;
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#0a1024");
    bg.addColorStop(1, "#16204a");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const base = 58 + Math.sin(t * 1.6) * 3 + smooth * 26;
    const hue = F.speaking ? 190 : 225;
    // rings that spread out while it talks, and a slow pulse when it is only listening
    for (let i = 0; i < 4; i++) {
      const ph = (t * (F.speaking ? 0.9 : 0.35) + i / 4) % 1;
      const r = base + 10 + ph * (F.speaking ? 70 + smooth * 40 : 36 + hearSmooth * 30);
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.strokeStyle = "hsla(" + hue + ",90%,65%," + ((1 - ph) * (F.speaking ? 0.55 : 0.18 + hearSmooth * 0.3)) + ")";
      g.lineWidth = 2;
      g.stroke();
    }
    const orb = g.createRadialGradient(cx - 14, cy - 18, 6, cx, cy, base);
    orb.addColorStop(0, "hsl(" + hue + ",95%,78%)");
    orb.addColorStop(1, "hsl(" + (hue + 30) + ",85%,48%)");
    g.shadowColor = "hsl(" + hue + ",95%,60%)";
    g.shadowBlur = 24 + smooth * 40;
    g.fillStyle = orb;
    g.beginPath();
    g.arc(cx, cy, base, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    // a voice line across the orb
    g.beginPath();
    for (let x = -base * 0.7; x <= base * 0.7; x += 3) {
      const a = (F.speaking ? 4 + smooth * 26 : 2 + hearSmooth * 8) * Math.cos((x / (base * 0.7)) * Math.PI / 2);
      const y = Math.sin(x / 7 + t * (F.speaking ? 9 : 3)) * a;
      x === -base * 0.7 ? g.moveTo(cx + x, cy + y) : g.lineTo(cx + x, cy + y);
    }
    g.strokeStyle = "rgba(255,255,255,0.92)";
    g.lineWidth = 3;
    g.lineCap = "round";
    g.stroke();
    g.fillStyle = "#e8edff";
    g.font = "600 30px Segoe UI, Arial, sans-serif";
    g.textAlign = "center";
    g.fillText(NAME, cx, h - 62);
    g.fillStyle = F.speaking ? "#7fe3ff" : "#93a0c8";
    g.font = "16px Segoe UI, Arial, sans-serif";
    g.fillText(F.speaking ? "speaking" : hearSmooth > 0.25 ? "listening" : "AI assistant · taking notes", cx, h - 34);
  };
  draw();
  setInterval(draw, 66);
  const picture = cv.captureStream(15);

  // the microphone: a silent stream of our own
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia && AC) {
    md.getUserMedia = async (c) => {
      const s = new MediaStream();
      if (c && c.video) picture.getVideoTracks().forEach((t) => s.addTrack(t.clone()));
      if (c && c.audio) dest().stream.getAudioTracks().forEach((t) => s.addTrack(t.clone()));
      return s;
    };
  }

  // the screen: what is shared when the site asks for a screen is a stage of our own (slides, a picture or a film), never the real screen
  const sv = document.createElement("canvas");
  sv.width = 1280;
  sv.height = 720;
  const sg = sv.getContext("2d");
  const stage = (F.stage = { kind: null, slides: [], i: 0, el: null, url: null, prev: null, prevReveal: null, reveal: null, changedAt: 0 });
  F.asked = 0;
  F.parts = [];
  const wrapText = (t, maxW) => {
    const words = String(t).split(/\s+/);
    const rows = [];
    let row = "";
    for (const w of words) {
      const next = row ? row + " " + w : w;
      if (sg.measureText(next).width > maxW && row) { rows.push(row); row = w; } else row = next;
    }
    if (row) rows.push(row);
    return rows;
  };
  const contain = (el, w, h) => {
    const r = Math.min(1280 / w, 720 / h);
    sg.drawImage(el, (1280 - w * r) / 2, (720 - h * r) / 2, w * r, h * r);
  };
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  // one slide: its title, and its lines; with reveal (a number) only that many lines are there, the last one lit and the earlier ones dim, each coming in with a slide-up and a fade
  const drawSlide = (s, o) => {
    sg.save();
    sg.globalAlpha = o.alpha;
    sg.translate(o.dx, 0);
    sg.textAlign = "left";
    sg.fillStyle = "#e8edff";
    sg.font = "700 56px Segoe UI, Arial, sans-serif";
    let y = 130;
    for (const r of wrapText(s.title || "", 1120)) { sg.fillText(r, 80, y); y += 66; }
    y += 24;
    sg.font = "400 38px Segoe UI, Arial, sans-serif";
    const lines = s.lines || [];
    const shown = o.reveal === null ? lines.length : Math.min(o.reveal, lines.length);
    for (let i = 0; i < shown; i++) {
      const l = typeof lines[i] === "string" ? lines[i] : lines[i].text;
      const age = o.reveal === null ? 1 : Math.min(1, (o.now - ((s.born && s.born[i]) || 0)) / 450);
      const e = ease(age);
      const current = o.reveal !== null && i === shown - 1;
      const rows = wrapText(l, 1060);
      const up = (1 - e) * 26;
      sg.globalAlpha = o.alpha * e * (o.reveal === null || current ? 1 : 0.5);
      if (current) {
        sg.fillStyle = "rgba(127,227,255,0.14)";
        sg.fillRect(60, y - 40 + up, 1160, rows.length * 50 + 14);
        sg.fillStyle = "#7fe3ff";
        sg.fillRect(60, y - 40 + up, 6, rows.length * 50 + 14);
      }
      sg.fillStyle = "#7fe3ff";
      sg.fillText("•", 84, y + up);
      sg.fillStyle = current ? "#ffffff" : "#c3cdf5";
      for (const r of rows) { sg.fillText(r, 130, y + up); y += 50; }
      y += 12;
    }
    sg.restore();
  };
  const drawStage = () => {
    sg.fillStyle = "#0b1230";
    sg.fillRect(0, 0, 1280, 720);
    if (stage.kind === "slides") {
      const now = Date.now();
      const s = stage.slides[stage.i] || { title: "", lines: [] };
      const p = stage.prev ? Math.min(1, (now - stage.changedAt) / 500) : 1;
      const e = ease(p);
      // the slide that was there slides out to the left while the new one slides in from the right
      if (stage.prev && p < 1) drawSlide(stage.prev, { dx: -e * 120, alpha: 1 - e, now, reveal: stage.prevReveal });
      drawSlide(s, { dx: stage.prev ? (1 - e) * 160 : 0, alpha: stage.prev ? e : 1, now, reveal: stage.reveal });
      sg.fillStyle = "#1c2650";
      sg.fillRect(0, 712, 1280, 8);
      sg.fillStyle = "#7fe3ff";
      sg.fillRect(0, 712, 1280 * ((stage.i + 1) / stage.slides.length), 8);
      sg.fillStyle = "#5d6a99";
      sg.font = "22px Segoe UI, Arial, sans-serif";
      sg.textAlign = "right";
      sg.fillText((stage.i + 1) + " / " + stage.slides.length, 1230, 690);
    } else if (stage.kind === "image" && stage.el && stage.el.naturalWidth) contain(stage.el, stage.el.naturalWidth, stage.el.naturalHeight);
    else if (stage.kind === "video" && stage.el && stage.el.videoWidth) contain(stage.el, stage.el.videoWidth, stage.el.videoHeight);
  };
  drawStage();
  setInterval(drawStage, 66);
  const stageStream = sv.captureStream(15);
  const clearStage = () => {
    if (stage.el && stage.el.pause) { try { stage.el.pause(); } catch (e) {} }
    if (stage.url) { try { URL.revokeObjectURL(stage.url); } catch (e) {} }
    stage.kind = null; stage.slides = []; stage.i = 0; stage.el = null; stage.url = null;
  };
  if (md) md.getDisplayMedia = async () => { F.asked++; return new MediaStream(stageStream.getVideoTracks().map((t) => t.clone())); };
  // a slide with .anim has its lines come in one by one (F.reveal), the others show every line at once
  const first = (s) => (s && s.anim ? 0 : null);
  F.slides = (slides, start) => { clearStage(); stage.kind = "slides"; stage.slides = slides; stage.i = Math.max(0, Math.min(slides.length - 1, start || 0)); stage.prev = null; stage.reveal = first(slides[stage.i]); stage.changedAt = Date.now(); drawStage(); return slides.length; };
  F.flip = (by) => { if (stage.kind !== "slides") return false; const n = Math.max(0, Math.min(stage.slides.length - 1, stage.i + by)); if (n === stage.i) return true; stage.prev = stage.slides[stage.i]; stage.prevReveal = stage.reveal; stage.i = n; stage.slides[n].born = []; stage.reveal = first(stage.slides[n]); stage.changedAt = Date.now(); drawStage(); return true; };
  F.reveal = (n) => { if (stage.kind !== "slides") return false; const s = stage.slides[stage.i]; s.born = s.born || []; for (let k = (stage.reveal || 0); k < n; k++) s.born[k] = Date.now(); stage.reveal = n; return true; };
  F.put = (b64, reset) => { if (reset) F.parts = []; const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); F.parts.push(u); return F.parts.length; };
  F.showFile = (kind, mime) => new Promise((done) => {
    clearStage();
    const blob = new Blob(F.parts, { type: mime });
    F.parts = [];
    stage.url = URL.createObjectURL(blob);
    if (kind === "image") {
      const im = new Image();
      im.onload = () => { stage.kind = "image"; stage.el = im; drawStage(); done(true); };
      im.onerror = () => done(false);
      im.src = stage.url;
    } else {
      const v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true;
      v.onloadeddata = () => { stage.kind = "video"; stage.el = v; v.play().catch(() => {}); done(true); };
      v.onerror = () => done(false);
      v.src = stage.url;
    }
  });
  F.hide = () => { clearStage(); drawStage(); return true; };

  // what is said: decode the sound and play it into the microphone stream; resolves with its length in seconds when it has finished
  F.speak = async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const c = ctx();
    await c.resume();
    const buf = await c.decodeAudioData(bytes.buffer);
    const src = c.createBufferSource();
    src.buffer = buf;
    if (!F.an) { F.an = c.createAnalyser(); F.an.fftSize = 512; F.an.connect(dest()); }
    src.connect(F.an);
    F.speaking = true;
    return new Promise((done) => { src.onended = () => { F.speaking = false; done(buf.duration); }; src.start(); });
  };

  // what is heard: every remote audio track of every call
  const tap = (track) => {
    if (!AC || F.tapped.has(track.id)) return;
    F.tapped.add(track.id);
    const stream = new MediaStream([track]);
    // Chrome only delivers a remote stream's sound once something plays it; a silent element does
    try { const a = new Audio(); a.muted = true; a.srcObject = stream; a.play().catch(() => {}); } catch (e) {}
    if (!F.rctx) {
      F.rctx = new AC({ sampleRate: 16000 });
      const p = F.rctx.createScriptProcessor(4096, 1, 1);
      const off = F.rctx.createGain();
      off.gain.value = 0;
      p.connect(off);
      off.connect(F.rctx.destination);
      p.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        const out = new Int16Array(d.length);
        let en = 0;
        for (let i = 0; i < d.length; i++) { out[i] = Math.max(-1, Math.min(1, d[i])) * 32767; en += d[i] * d[i]; }
        F.heard = Math.max(F.heard, Math.sqrt(en / d.length));
        F.chunks.push(out);
        F.samples += out.length;
        if (F.samples > 16000 * 120) { F.chunks.shift(); } // never more than a couple of minutes waiting
      };
      F.proc = p;
    }
    F.rctx.resume().catch(() => {});
    F.rctx.createMediaStreamSource(stream).connect(F.proc);
  };
  const RPC = window.RTCPeerConnection;
  if (RPC) {
    const Wrapped = function (...a) {
      const pc = new RPC(...a);
      pc.addEventListener("track", (e) => { if (e.track && e.track.kind === "audio") tap(e.track); });
      return pc;
    };
    Wrapped.prototype = RPC.prototype;
    for (const k of Object.getOwnPropertyNames(RPC)) { if (!(k in Wrapped)) { try { Wrapped[k] = RPC[k]; } catch (e) {} } }
    window.RTCPeerConnection = Wrapped;
  }

  // the sound heard since the last call, as base64 16-bit PCM
  F.take = () => {
    const chunks = F.chunks;
    F.chunks = [];
    F.samples = 0;
    let n = 0;
    for (const c of chunks) n += c.length;
    const all = new Uint8Array(n * 2);
    let o = 0;
    for (const c of chunks) { all.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), o); o += c.byteLength; }
    let s = "";
    for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000));
    return btoa(s);
  };
})();`;
