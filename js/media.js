// Camera, microphone and speaker handling, recording, and the mic level meter.
// Bluetooth headsets show up as ordinary devices once they are paired with the
// computer, so supporting them means: list every device, react when one connects
// or disconnects, open the exact one the user picked, and play sound back
// through the chosen output (setSinkId) where the browser allows it.

const md = () => globalThis.navigator?.mediaDevices;

export const support = {
  get secure() {
    return globalThis.isSecureContext !== false;
  },
  get getUserMedia() {
    return Boolean(md()?.getUserMedia);
  },
  get recorder() {
    return typeof globalThis.MediaRecorder !== 'undefined';
  },
  /** Can we route playback to a chosen speaker or headset? (Chrome, Edge, Firefox 116+, Safari 18.4+ on Mac) */
  get outputSelection() {
    return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  },
  /** Firefox: the browser shows its own speaker picker. */
  get selectAudioOutput() {
    return Boolean(md()?.selectAudioOutput);
  },
};

const BLUETOOTH_HINT = /airpods|bluetooth|\bbt\b|headset|hands-?free|buds|beats|bose|jabra|plantronics|\bpoly\b|sony wh|sony wf|wh-1000|wf-1000|jbl|skullcandy|soundcore|powerbeats|galaxy buds|pixel buds|hfp|a2dp/i;

/** Guess from the label whether a device is a Bluetooth headset. */
export function looksBluetooth(label = '') {
  return BLUETOOTH_HINT.test(label);
}

/** Lists cameras, microphones and speakers. Labels are blank until permission is granted. */
export async function listDevices() {
  const out = { cameras: [], mics: [], speakers: [] };
  if (!md()?.enumerateDevices) return out;
  let devices = [];
  try {
    devices = await md().enumerateDevices();
  } catch {
    return out;
  }
  const counters = { videoinput: 0, audioinput: 0, audiooutput: 0 };
  const names = { videoinput: 'Camera', audioinput: 'Microphone', audiooutput: 'Speaker' };
  const seen = new Set();
  for (const d of devices) {
    if (!(d.kind in counters)) continue;
    // Chrome on Windows adds a "communications" pseudo-device; it only confuses the list.
    if (d.deviceId === 'communications') continue;
    // Before permission Chrome returns one placeholder per kind with no id.
    if (!d.deviceId && d.kind === 'audiooutput') continue;
    const key = `${d.kind}:${d.deviceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counters[d.kind] += 1;
    let label = d.label || `${names[d.kind]} ${counters[d.kind]}`;
    if (d.deviceId === 'default' && d.label) label = `System default (${d.label.replace(/^Default\s*-\s*/i, '')})`;
    const item = { deviceId: d.deviceId, groupId: d.groupId, label, rawLabel: d.label || '', hasLabel: Boolean(d.label) };
    item.bluetooth = looksBluetooth(item.rawLabel);
    if (d.kind === 'videoinput') out.cameras.push(item);
    else if (d.kind === 'audioinput') out.mics.push(item);
    else out.speakers.push(item);
  }
  return out;
}

/** Calls `cb` whenever a device is plugged in, paired or removed. Returns an unsubscribe function. */
export function onDeviceChange(cb) {
  const mediaDevices = md();
  if (!mediaDevices?.addEventListener) return () => {};
  let timer;
  // A Bluetooth headset adds its mic and its speaker as separate events.
  const handler = () => {
    clearTimeout(timer);
    timer = setTimeout(cb, 450);
  };
  mediaDevices.addEventListener('devicechange', handler);
  return () => {
    clearTimeout(timer);
    mediaDevices.removeEventListener('devicechange', handler);
  };
}

function deviceConstraint(id, exact) {
  if (!id) return undefined;
  return exact ? { exact: id } : { ideal: id };
}

function videoConstraints(cameraId, exact) {
  // About 540p: plenty for watching yourself back, and light enough for older
  // laptops to encode smoothly (one-way interview platforms record around 480p).
  const c = { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30, max: 30 } };
  const deviceId = deviceConstraint(cameraId, exact);
  if (deviceId) c.deviceId = deviceId;
  else c.facingMode = 'user';
  return c;
}

function audioConstraints(micId, exact) {
  const c = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } };
  const deviceId = deviceConstraint(micId, exact);
  if (deviceId) c.deviceId = deviceId;
  return c;
}

/**
 * Opens the camera and microphone.
 * `exact: true` when the person just picked a device (fail loudly if it is gone);
 * otherwise saved devices are only a preference.
 * Falls back to the defaults if a picked device is gone, and to audio only if
 * there is no camera at all. Returns { stream, audioOnly, fellBack }.
 */
export async function openStream({ cameraId = '', micId = '', exact = false, allowAudioOnly = true } = {}) {
  if (!support.secure) throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
  if (!support.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
  const gum = (c) => md().getUserMedia(c);
  try {
    const stream = await gum({ video: videoConstraints(cameraId, exact), audio: audioConstraints(micId, exact) });
    return { stream, audioOnly: false, fellBack: false };
  } catch (err) {
    let lastErr = err;
    const deviceGone = (cameraId || micId) && ['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(err.name);
    if (deviceGone) {
      try {
        const stream = await gum({ video: videoConstraints('', false), audio: audioConstraints('', false) });
        return { stream, audioOnly: false, fellBack: true };
      } catch (err2) {
        lastErr = err2;
      }
    }
    if (allowAudioOnly && (lastErr.name === 'NotFoundError' || lastErr.name === 'OverconstrainedError')) {
      // No camera: still let people practice their delivery.
      const stream = await gum({ video: false, audio: audioConstraints(micId, false) });
      return { stream, audioOnly: true, fellBack: true };
    }
    throw lastErr;
  }
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      /* ignore */
    }
  });
}

/** The devices actually in use (can differ from the request after a fallback). */
export function activeDeviceIds(stream) {
  const v = stream?.getVideoTracks()[0];
  const a = stream?.getAudioTracks()[0];
  return {
    cameraId: v?.getSettings?.().deviceId || '',
    micId: a?.getSettings?.().deviceId || '',
    cameraLabel: v?.label || '',
    micLabel: a?.label || '',
  };
}

/**
 * Watches the camera and mic. `onEnded(kind)` fires when a device stops for good
 * (a Bluetooth headset disconnects); `onMute(kind, muted)` fires when the system
 * or headset mutes it (for example an AirPods stem press).
 */
export function watchTracks(stream, onEnded, onMute) {
  const handlers = [];
  stream?.getTracks().forEach((track) => {
    const ended = () => onEnded?.(track.kind);
    const mute = () => onMute?.(track.kind, true);
    const unmute = () => onMute?.(track.kind, false);
    track.addEventListener('ended', ended);
    track.addEventListener('mute', mute);
    track.addEventListener('unmute', unmute);
    handlers.push(() => {
      track.removeEventListener('ended', ended);
      track.removeEventListener('mute', mute);
      track.removeEventListener('unmute', unmute);
    });
  });
  return () => handlers.forEach((off) => off());
}

/** iOS/Safari: tell the system whether we are recording or just playing back. */
export function setAudioSession(type) {
  try {
    if (navigator.audioSession && 'type' in navigator.audioSession) navigator.audioSession.type = type;
  } catch {
    /* ignore */
  }
}

/** Plain-language explanation of a getUserMedia error. */
export function describeMediaError(err) {
  const name = err?.name || '';
  const ua = globalThis.navigator?.userAgent || '';
  const isMac = /Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad/i.test(ua);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        kind: 'denied',
        title: 'Camera and microphone are blocked',
        message: `Allow access in your browser: click the camera or lock icon in the address bar, set Camera and Microphone to Allow, then try again.${isMac ? ' On a Mac, also check System Settings → Privacy & Security → Camera and Microphone for your browser.' : ''}`,
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { kind: 'notfound', title: 'No camera or microphone found', message: 'Connect a camera and microphone (or pair your Bluetooth headset), then try again.' };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return { kind: 'inuse', title: 'Your camera or microphone is busy', message: 'Another app (Zoom, Teams, FaceTime) may be using it. Close that app, then try again.' };
    case 'OverconstrainedError':
      return { kind: 'gone', title: 'That device is not available', message: 'Pick a different camera or microphone.' };
    case 'InsecureContext':
      return { kind: 'insecure', title: 'This page needs a secure connection', message: 'Open the site over https:// (or http://localhost) to use the camera.' };
    case 'Unsupported':
      return { kind: 'unsupported', title: 'This browser cannot record video', message: 'Use a current version of Chrome, Edge, Firefox or Safari.' };
    default:
      return { kind: 'other', title: 'Could not start the camera', message: err?.message || 'Something went wrong. Reload the page and try again.' };
  }
}

// ---------- Recording ----------

// MP4 (H.264 + AAC) first: Safari and Chrome/Edge 126+ record it, and the
// downloaded files open in QuickTime, Windows and on phones. WebM is the
// fallback (Firefox, Chromium builds without H.264).
const VIDEO_TYPES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const AUDIO_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

// Formats that produced an empty file on this device; skipped from then on.
const brokenTypes = new Set();

export function pickMimeType(audioOnly = false) {
  if (!support.recorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  const list = audioOnly ? AUDIO_TYPES : VIDEO_TYPES;
  return (
    list.find((t) => {
      if (brokenTypes.has(t)) return false;
      try {
        return MediaRecorder.isTypeSupported(t);
      } catch {
        return false;
      }
    }) || ''
  );
}

export class Recorder {
  constructor(stream, { audioOnly = false } = {}) {
    this.stream = stream;
    this.audioOnly = audioOnly;
    this.mimeType = pickMimeType(audioOnly);
    this.chunks = [];
    this.mr = null;
    this.startedAt = 0;
    this.stoppedAt = 0;
    this.onerror = null;
  }

  get state() {
    return this.mr?.state || 'inactive';
  }

  start() {
    this.chunks = [];
    this.stoppedAt = 0;
    this.mimeType = pickMimeType(this.audioOnly);
    const opts = { audioBitsPerSecond: 128_000 };
    if (!this.audioOnly) opts.videoBitsPerSecond = 1_500_000; // about 11 MB per minute
    if (this.mimeType) opts.mimeType = this.mimeType;
    try {
      this.mr = new MediaRecorder(this.stream, opts);
    } catch {
      // Some browsers reject the bitrate or type options; let them choose.
      this.mr = new MediaRecorder(this.stream);
    }
    this.mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.mr.onerror = (e) => this.onerror?.(e.error || e);
    this.mr.start(1000); // one chunk a second (Safari hands out empty chunks below ~1 s)
    this.startedAt = performance.now();
  }

  /** Stops and resolves with { blob, mimeType, duration } (duration in seconds). */
  stop() {
    return new Promise((resolve) => {
      let done = false;
      const finish = async () => {
        if (done) return;
        done = true;
        this.stoppedAt = this.stoppedAt || performance.now();
        const type = this.mr?.mimeType || this.mimeType || this.chunks[0]?.type || (this.audioOnly ? 'audio/webm' : 'video/webm');
        const duration = Math.max(0, (this.stoppedAt - this.startedAt) / 1000);
        const blob = new Blob(this.chunks, { type });
        if (!blob.size && duration > 1 && this.mimeType) {
          // This format recorded nothing here: try the next one on the next take.
          brokenTypes.add(this.mimeType);
        }
        resolve({ blob, mimeType: type, duration });
      };
      if (!this.mr || this.mr.state === 'inactive') {
        finish();
        return;
      }
      this.mr.addEventListener('stop', finish, { once: true });
      // Safety net: if the browser never fires "stop", keep what we have.
      setTimeout(finish, 4000);
      this.stoppedAt = performance.now();
      try {
        this.mr.stop();
      } catch {
        finish();
      }
    });
  }

  /** Stop and throw the take away. */
  cancel() {
    try {
      if (this.mr && this.mr.state !== 'inactive') this.mr.stop();
    } catch {
      /* ignore */
    }
    this.chunks = [];
  }
}

/**
 * WebM files from Firefox (and some Chrome builds) have no duration, so the seek
 * bar shows "Infinity" until the clip has played once. Seeking far past the end
 * once makes the browser work out the real length. (No third-party code is
 * loaded for this, so recordings never pass through anyone else's script.)
 */
export function fixInfiniteDuration(media) {
  const handler = () => {
    if (Number.isFinite(media.duration)) return;
    const restore = () => {
      if (!Number.isFinite(media.duration)) return; // keep waiting for the real length
      media.removeEventListener('durationchange', restore);
      media.removeEventListener('timeupdate', restore);
      media.currentTime = 0;
    };
    media.addEventListener('durationchange', restore);
    media.addEventListener('timeupdate', restore);
    try {
      media.currentTime = 1e101;
    } catch {
      /* ignore */
    }
  };
  media.addEventListener('loadedmetadata', handler, { once: true });
}

// ---------- Speaker / headphone output ----------

/** Route an <audio>/<video> element to the chosen speaker. Returns true if it worked. */
export async function applySink(mediaEl, speakerId) {
  if (!mediaEl || !support.outputSelection) return false;
  const target = speakerId || '';
  try {
    // '' means the system default output.
    if (mediaEl.sinkId !== target) await mediaEl.setSinkId(target);
    return true;
  } catch {
    try {
      if (mediaEl.sinkId) await mediaEl.setSinkId('');
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** Firefox: open the browser's own speaker picker. Resolves with { deviceId, label } or null. */
export async function chooseSpeakerWithBrowserPicker() {
  if (!support.selectAudioOutput) return null;
  try {
    const info = await md().selectAudioOutput();
    return { deviceId: info.deviceId, label: info.label || 'Selected speaker' };
  } catch {
    return null;
  }
}

let testToneUrl = null;
/** A short, gentle two-note chime as a WAV file (built in code, nothing downloaded). */
function testTone() {
  if (testToneUrl) return testToneUrl;
  const rate = 44_100;
  const notes = [
    [659.25, 0.0, 0.45],
    [880, 0.35, 0.9],
  ]; // E5 then A5
  const length = Math.floor(rate * 1.0);
  const samples = new Float32Array(length);
  for (const [freq, start, end] of notes) {
    const s0 = Math.floor(start * rate);
    const s1 = Math.min(length, Math.floor(end * rate));
    for (let i = s0; i < s1; i += 1) {
      const t = (i - s0) / rate;
      const dur = (s1 - s0) / rate;
      const env = Math.min(1, t / 0.01) * Math.exp(-4 * (t / dur));
      samples[i] += 0.35 * env * Math.sin(2 * Math.PI * freq * t);
    }
  }
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, str) => [...str].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  testToneUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  return testToneUrl;
}

/** Plays the chime through the chosen speaker. Returns { routed } (false = system default). */
export async function playTestSound(speakerId) {
  const audio = new Audio(testTone());
  const routed = speakerId ? await applySink(audio, speakerId) : false;
  await audio.play();
  return { routed };
}

/** Sends the start-of-recording tone to the chosen speaker where the browser allows it (Chrome, Edge). */
export function setCueSink(speakerId) {
  try {
    const ctx = audioContext();
    if (typeof ctx?.setSinkId !== 'function') return;
    const wanted = speakerId && speakerId !== 'default' ? speakerId : '';
    if (ctx.sinkId !== wanted) ctx.setSinkId(wanted).catch(() => {});
  } catch {
    /* the default output is fine */
  }
}

/**
 * A short, soft tone that marks the start of recording. Plays through Web
 * Audio, which the first click on the page already unlocked, so Safari allows
 * it from a timer too. Never throws.
 */
export function playCue() {
  try {
    const ctx = audioContext();
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.01;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  } catch {
    /* no tone is fine */
  }
}

// ---------- Microphone level meter ----------

let sharedContext = null;
function audioContext() {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedContext || sharedContext.state === 'closed') sharedContext = new Ctx();
  return sharedContext;
}

/** Call from a click handler so Safari lets audio analysis start. */
export function unlockAudio() {
  try {
    const ctx = audioContext();
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
  } catch {
    /* ignore */
  }
}

export class LevelMeter {
  constructor(stream) {
    this.stream = stream;
    this.raf = 0;
    this.source = null;
    this.analyser = null;
  }

  /** cb receives a level from 0 (silent) to 1 (loud), about 30 times a second. */
  start(cb) {
    this.stop();
    const ctx = audioContext();
    const track = this.stream?.getAudioTracks()[0];
    if (!ctx || !track) return false;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      this.source = ctx.createMediaStreamSource(new MediaStream([track]));
    } catch {
      return false;
    }
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser); // not connected to the speakers: no echo
    const data = new Float32Array(this.analyser.fftSize);
    let smooth = 0;
    let last = 0;
    const tick = (now) => {
      this.raf = requestAnimationFrame(tick);
      if (now - last < 33 || !this.analyser) return;
      last = now;
      this.analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const db = 20 * Math.log10(rms || 1e-8);
      const level = Math.max(0, Math.min(1, (db + 60) / 50));
      smooth = level > smooth ? level : smooth * 0.85 + level * 0.15;
      cb(smooth);
    };
    this.raf = requestAnimationFrame(tick);
    return true;
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    this.source = null;
    this.analyser = null;
  }
}
