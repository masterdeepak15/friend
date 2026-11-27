/**
 * Runs in every page of the meeting before the site's own scripts, and gives the browser a microphone and ears without any driver on the PC:
 *  - the microphone the site asks for is a stream the page makes itself; it is silent until `__friend.speak` plays a sound into it;
 *  - every remote audio track of a call (the other people) is also listened to, a little at a time, as 16 kHz 16-bit sound that
 *    `__friend.take` hands over. Nothing is kept in the page beyond what was not taken yet.
 */
export const AUDIO_HOOK = String.raw`(() => {
  if (window.__friend) return;
  const F = (window.__friend = { ctx: null, dest: null, rctx: null, proc: null, chunks: [], samples: 0, tapped: new Set(), speaking: false });
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = () => (F.ctx = F.ctx || new AC());
  const dest = () => (F.dest = F.dest || ctx().createMediaStreamDestination());

  // the microphone: a silent stream of our own, and the real fake camera if the site asks for video
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia && AC) {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      const s = new MediaStream();
      if (c && c.video) {
        try { (await orig({ video: c.video })).getTracks().forEach((t) => s.addTrack(t)); } catch (e) { if (!(c && c.audio)) throw e; }
      }
      if (c && c.audio) dest().stream.getAudioTracks().forEach((t) => s.addTrack(t.clone()));
      return s;
    };
  }

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
    src.connect(dest());
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
        for (let i = 0; i < d.length; i++) out[i] = Math.max(-1, Math.min(1, d[i])) * 32767;
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
