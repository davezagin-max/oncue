// Device check: pick camera, microphone and speaker (Bluetooth included),
// watch the mic level, play a test sound, and record a 5-second test clip.
import { $, el, prefs, wait, formatDuration } from './util.js';
import { state, saveDevices, interviewEstimate } from './state.js';
import { fillSelect, toast } from './ui.js';
import * as media from './media.js';

let callbacks = {};
let meter = null;
let unwatchDevices = null;
let unwatchTracks = null;
let opening = false;
let testing = false;
let testUrl = null;
let knownIds = new Set();
let lastLoud = 0;
let enteredAt = 0;
let active = false;

export function initCheck({ onStartInterview, onPractice, onBack }) {
  callbacks = { onStartInterview, onPractice, onBack };

  $('#btn-allow').addEventListener('click', () => {
    media.unlockAudio();
    openDevices();
  });
  $('#d-camera').addEventListener('change', () => openDevices({ cameraId: $('#d-camera').value, micId: state.devices.micId, exact: true }));
  $('#d-mic').addEventListener('change', () => openDevices({ cameraId: state.devices.cameraId, micId: $('#d-mic').value, exact: true }));
  $('#d-speaker').addEventListener('change', async () => {
    state.devices.speakerId = $('#d-speaker').value;
    state.devices.speakerLabel = $('#d-speaker').selectedOptions[0]?.dataset.raw || '';
    saveDevices();
    await media.applySink($('#check-playback'), state.devices.speakerId);
    updateBluetoothNote();
  });
  $('#btn-pick-speaker').addEventListener('click', async () => {
    const picked = await media.chooseSpeakerWithBrowserPicker();
    if (!picked) return;
    state.devices.speakerId = picked.deviceId;
    state.devices.speakerLabel = picked.label;
    saveDevices();
    await refreshDeviceLists();
    toast(`Sound will play through ${picked.label}.`);
  });
  $('#btn-test-sound').addEventListener('click', testSound);
  $('#btn-test-record').addEventListener('click', () => {
    if (!$('#check-playback').hidden) closeTestPlayback();
    else recordTest();
  });
  $('#btn-refresh-devices').addEventListener('click', async () => {
    await refreshDeviceLists();
    toast('Device list updated.');
  });
  $('#btn-check-back').addEventListener('click', () => callbacks.onBack?.());
  $('#btn-start').addEventListener('click', () => {
    if (!state.media.stream) return;
    callbacks.onStartInterview?.();
  });
  $('#btn-practice').addEventListener('click', () => {
    if (!state.media.stream) return;
    callbacks.onPractice?.();
  });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Rules for an interview from a code, or for continuing one. */
function codedRules() {
  const r = state.resume;
  const c = state.setup.coded;
  const prep = r ? r.settings.prep : c.thinkSec;
  const answer = r ? r.settings.answer : c.answerSec;
  const retakes = r ? r.settings.retakes !== 0 : c.retakes;
  const total = r ? r.questions.length : c.questions.length;
  const left = r ? r.questions.filter((q) => !r.answers?.[q.id]).length : total;
  const minutes = Math.max(1, Math.round((left * (prep + answer + 15)) / 60));
  return [
    r
      ? `${left} of ${plural(total, 'question')} left, about ${plural(minutes, 'minute')}. You’ll start at the next question you haven’t answered.`
      : `${plural(total, 'question')}, about ${plural(minutes, 'minute')} in total.`,
    prep
      ? `${formatDuration(prep)} to prepare for each question. Recording starts on its own when it ends.`
      : 'No prep time: recording starts right after a 3-second countdown.',
    `Up to ${formatDuration(answer)} to answer each question.`,
    retakes
      ? 'Retakes allowed: watch each answer, then use it or record it again.'
      : 'One take per question: each answer is saved as soon as you finish.',
    `When you click ${r ? 'Resume' : 'Start'}, the ${r ? 'next' : 'first'} question appears. You can’t pause, and you can’t go back to a question.`,
  ];
}

/** The "Before you start" list, like the attempts page before a real interview. */
function renderRules() {
  $('#btn-start').textContent = state.resume ? 'Resume interview' : 'Start interview';
  if (state.resume || state.setup.coded) {
    $('#check-rules-list').replaceChildren(...codedRules().map((t) => el('li', {}, t)));
    return;
  }
  const s = state.setup;
  const { count, minutes } = interviewEstimate(s);
  const answerTimes = new Set([s.answer, ...s.questions.map((q) => q.answer ?? s.answer)]);
  const prepTimes = new Set([s.prep, ...s.questions.map((q) => q.prep ?? s.prep)]);
  const items = [
    `${count} question${count === 1 ? '' : 's'}, about ${minutes} minute${minutes === 1 ? '' : 's'} in total.${s.curveball ? ' One is a surprise curveball.' : ''}`,
    prepTimes.size === 1
      ? s.prep
        ? `${formatDuration(s.prep)} to prepare for each question. Recording starts on its own when it ends.`
        : 'No prep time: recording starts right after a 3-second countdown.'
      : 'Prep time varies by question. Recording starts on its own when it ends.',
    answerTimes.size === 1 ? `Up to ${formatDuration(s.answer)} to answer each question.` : 'Answer time varies by question.',
    s.retakes === 0
      ? 'No retakes: each answer is saved as soon as you finish.'
      : `${s.retakes === 1 ? 'One retake' : `${s.retakes} retakes`} per question. Your latest take is the one that\u2019s saved.`,
    'Once you move on, you can\u2019t go back to a question.',
  ];
  $('#check-rules-list').replaceChildren(...items.map((t) => el('li', {}, t)));
}

/** Called right after the check screen is shown. */
export async function enterCheck() {
  active = true;
  enteredAt = performance.now();
  lastLoud = 0;
  renderRules();
  $('#tick-camera').hidden = true;
  $('#tick-mic').hidden = true;
  unwatchDevices?.();
  unwatchDevices = media.onDeviceChange(handleDeviceChange);
  closeTestPlayback();
  setReady(false);
  hideError();

  if (!media.support.secure || !media.support.getUserMedia || !media.support.recorder) {
    const info = media.describeMediaError({ name: !media.support.secure ? 'InsecureContext' : 'Unsupported' });
    showError(info);
    setEmpty(info.title, false);
    return;
  }

  if (isLive(state.media.stream)) {
    attachPreview();
    unwatchTracks?.();
    unwatchTracks = media.watchTracks(state.media.stream, onTrackEnded);
    await refreshDeviceLists();
    setReady(true);
    return;
  }
  // The person just clicked "Continue to camera check", so ask for access right away.
  await openDevices();
}

/** Called when leaving the check screen. Keeps the camera on if the interview is next. */
export function leaveCheck(next) {
  active = false;
  meter?.stop();
  meter = null;
  unwatchDevices?.();
  unwatchDevices = null;
  unwatchTracks?.();
  unwatchTracks = null;
  closeTestPlayback();
  if (next !== 'interview') {
    media.stopStream(state.media.stream);
    state.media.stream = null;
    $('#check-video').srcObject = null;
  }
}

/** Usable means the microphone is still live (video is optional). */
function isLive(stream) {
  return Boolean(stream) && stream.getAudioTracks().some((t) => t.readyState === 'live');
}

async function openDevices({ cameraId = state.devices.cameraId, micId = state.devices.micId, exact = false } = {}) {
  if (opening) return;
  opening = true;
  hideError();
  setReady(false);
  meter?.stop();
  unwatchTracks?.();
  media.stopStream(state.media.stream);
  state.media.stream = null;
  $('#check-video').srcObject = null;
  setEmpty('Starting your camera…', false);
  try {
    const { stream, audioOnly, fellBack } = await media.openStream({ cameraId, micId, exact });
    if (!active) {
      media.stopStream(stream);
      return;
    }
    state.media.stream = stream;
    state.media.audioOnly = audioOnly;
    const ids = media.activeDeviceIds(stream);
    if (!audioOnly && ids.cameraId) state.devices.cameraId = ids.cameraId;
    if (ids.micId) state.devices.micId = ids.micId;
    saveDevices();
    prefs.set('granted', true);
    attachPreview();
    unwatchTracks = media.watchTracks(stream, onTrackEnded);
    await refreshDeviceLists();
    if (fellBack && exact && !audioOnly) toast('That device was not available, so the default is being used.');
    setReady(true);
  } catch (err) {
    const info = media.describeMediaError(err);
    showError(info);
    setEmpty(info.title, true, 'Try again');
    $('#d-meter-hint').textContent = 'Allow microphone access to see your level.';
    for (const id of ['#d-camera', '#d-mic']) fillSelect($(id), [['', 'Waiting for access']], '');
  } finally {
    opening = false;
  }
}

function attachPreview() {
  const stream = state.media.stream;
  const video = $('#check-video');
  video.srcObject = state.media.audioOnly ? null : stream;
  video.hidden = state.media.audioOnly;
  $('#check-audio-only').hidden = !state.media.audioOnly;
  $('#check-empty').hidden = true;
  video.play?.().catch(() => {});
  const markCamera = () => {
    $('#tick-camera').hidden = !(video.videoWidth > 0);
  };
  video.addEventListener('loadeddata', markCamera, { once: true });
  markCamera();
  startMeter();
}

function startMeter() {
  meter?.stop();
  meter = new media.LevelMeter(state.media.stream);
  const bar = $('#d-meter > span');
  const meterEl = $('#d-meter');
  const hint = $('#d-meter-hint');
  let lastHint = '';
  const ok = meter.start((level) => {
    bar.style.width = `${Math.round(level * 100)}%`;
    meterEl.setAttribute('aria-valuenow', String(Math.round(level * 100)));
    const now = performance.now();
    if (level > 0.22) {
      lastLoud = now;
      $('#tick-mic').hidden = false;
    }
    let text = 'Say something. The bar should move.';
    if (lastLoud && now - lastLoud < 2500) text = 'Sounds good.';
    else if (now - enteredAt > 9000 && (!lastLoud || now - lastLoud > 9000)) {
      text = 'We can’t hear much. Speak up, or pick a different microphone.';
    }
    if (text !== lastHint) {
      hint.textContent = text;
      lastHint = text;
    }
  });
  if (!ok) hint.textContent = 'Mic level is not available in this browser, but recording still works.';
}

async function refreshDeviceLists() {
  const { cameras, mics, speakers } = await media.listDevices();
  const announce = knownIds.size > 0;
  const fresh = [...mics, ...speakers].filter((d) => d.deviceId && !knownIds.has(d.deviceId) && d.hasLabel && !/^default$|^communications$/.test(d.deviceId));
  knownIds = new Set([...cameras, ...mics, ...speakers].map((d) => d.deviceId));
  if (announce && fresh.length) toast(`Connected: ${fresh[0].label}`);

  const cam = $('#d-camera');
  if (cameras.length && !state.media.audioOnly) {
    fillSelect(cam, cameras.map((d) => [d.deviceId, d.label]), state.devices.cameraId);
    cam.disabled = false;
  } else if (cameras.length) {
    // Audio only right now, but a camera is available: let the person turn it back on.
    fillSelect(cam, [['', 'Camera off'], ...cameras.map((d) => [d.deviceId, d.label])], '');
    cam.disabled = false;
    $('#check-audio-only').textContent = 'Camera off. Pick a camera above to turn video back on.';
  } else {
    fillSelect(cam, [['', 'No camera found']], '');
    cam.disabled = true;
    $('#check-audio-only').textContent = 'No camera found. You can still practice with audio only.';
  }

  const mic = $('#d-mic');
  if (mics.length) {
    fillSelect(mic, mics.map((d) => [d.deviceId, d.label]), state.devices.micId);
    mic.disabled = false;
  } else {
    fillSelect(mic, [['', 'No microphone found']], '');
    mic.disabled = true;
  }

  const spk = $('#d-speaker');
  const note = $('#d-speaker-note');
  const pick = $('#btn-pick-speaker');
  pick.hidden = true;
  note.hidden = true;
  if (!media.support.outputSelection) {
    spk.hidden = true;
    note.hidden = false;
    note.textContent = 'This browser plays sound through your computer’s current output. To use Bluetooth headphones, choose them in your system sound settings (on a Mac: Control Center → Sound).';
  } else if (speakers.length === 0) {
    spk.hidden = true;
    pick.hidden = !media.support.selectAudioOutput;
    note.hidden = false;
    note.textContent = 'Using your system\u2019s default output.';
  } else {
    pick.hidden = !media.support.selectAudioOutput; // Firefox: lets you add other outputs
    spk.hidden = false;
    const hasDefault = speakers.some((d) => d.deviceId === 'default');
    const options = speakers.map((d) => [d.deviceId, d.label]);
    if (!hasDefault) options.unshift(['', 'System default']);
    let wanted = hasDefault ? 'default' : '';
    if (speakers.some((d) => d.deviceId === state.devices.speakerId)) {
      wanted = state.devices.speakerId;
    } else if (state.devices.speakerLabel) {
      // Device ids change when site data is cleared; the name usually doesn't.
      const byName = speakers.find((d) => d.deviceId !== 'default' && d.rawLabel === state.devices.speakerLabel);
      if (byName) wanted = byName.deviceId;
    }
    fillSelect(spk, options, wanted);
    [...spk.options].forEach((opt) => {
      opt.dataset.raw = speakers.find((d) => d.deviceId === opt.value)?.rawLabel || '';
    });
    spk.disabled = false;
    // What the list shows is what plays: keep the saved choice in step with it.
    const effective = wanted === 'default' && state.devices.speakerId !== 'default' ? '' : wanted;
    if (effective !== state.devices.speakerId) {
      const gone = Boolean(state.devices.speakerId) && (wanted === 'default' || wanted === '');
      state.devices.speakerId = effective;
      saveDevices();
      if (gone && state.devices.speakerLabel) toast(`${state.devices.speakerLabel} is not connected, so sound will play through the default output.`);
    }
  }
  updateBluetoothNote(mics, speakers);
}

function updateBluetoothNote(mics, speakers) {
  const micLabel = $('#d-mic').selectedOptions[0]?.textContent || '';
  const spkLabel = $('#d-speaker').hidden ? '' : $('#d-speaker').selectedOptions[0]?.textContent || '';
  const note = $('#d-bt-note');
  const btMic = media.looksBluetooth(micLabel);
  const btSpk = media.looksBluetooth(spkLabel);
  if (btMic) {
    note.hidden = false;
    note.replaceChildren(
      el('strong', {}, 'Bluetooth mic selected. '),
      'It works, but many headsets switch to lower “call quality” sound while their mic is on. If your test sounds muffled, pick your computer’s microphone and keep the headset for listening.',
    );
  } else if (btSpk) {
    note.hidden = false;
    note.replaceChildren(el('strong', {}, 'Bluetooth headphones selected. '), 'Your playback and test sounds will play there.');
  } else {
    note.hidden = true;
  }
  void mics;
  void speakers;
}

async function handleDeviceChange() {
  if (!active) return;
  await refreshDeviceLists();
}

function onTrackEnded(kind) {
  if (!active) return;
  toast(`Your ${kind === 'audio' ? 'microphone' : 'camera'} disconnected. Switching to the default.`);
  openDevices({
    cameraId: kind === 'video' ? '' : state.devices.cameraId,
    micId: kind === 'audio' ? '' : state.devices.micId,
  });
}

async function testSound() {
  try {
    const { routed } = await media.playTestSound(state.devices.speakerId);
    const label = $('#d-speaker').hidden ? '' : $('#d-speaker').selectedOptions[0]?.textContent;
    if (routed && label) toast(`Playing through ${label}.`);
    else toast('Playing through your system’s sound output.');
  } catch {
    toast('Could not play the test sound. Check your volume and output device.');
  }
}

async function recordTest() {
  if (testing || !isLive(state.media.stream)) return;
  testing = true;
  const btn = $('#btn-test-record');
  const badge = $('#check-badge');
  const badgeText = $('#check-badge-text');
  btn.disabled = true;
  $('#btn-start').disabled = true;
  $('#btn-practice').disabled = true;
  $('#d-camera').disabled = true;
  $('#d-mic').disabled = true;
  const rec = new media.Recorder(state.media.stream, { audioOnly: state.media.audioOnly });
  try {
    rec.start();
  } catch {
    toast('Recording is not available in this browser.');
    testing = false;
    btn.disabled = false;
    setReady(true);
    return;
  }
  badge.hidden = false;
  const seconds = 5;
  const start = performance.now();
  while (performance.now() - start < seconds * 1000) {
    const left = Math.ceil(seconds - (performance.now() - start) / 1000);
    badgeText.textContent = `Recording test · ${left}`;
    await wait(200);
    if (!active) break;
  }
  const { blob } = await rec.stop();
  badge.hidden = true;
  testing = false;
  if (!active) return;
  if (!blob.size) {
    toast('The test recording came out empty. Try again (a different video format will be used) or pick another camera or microphone.');
    btn.disabled = false;
    setReady(true);
    await refreshDeviceLists();
    return;
  }
  if (testUrl) URL.revokeObjectURL(testUrl);
  testUrl = URL.createObjectURL(blob);
  const playback = $('#check-playback');
  media.fixInfiniteDuration(playback);
  playback.src = testUrl;
  playback.hidden = false;
  $('#check-video').hidden = true;
  await media.applySink(playback, state.devices.speakerId);
  playback.onplay = () => media.applySink(playback, state.devices.speakerId);
  playback.play().catch(() => {});
  btn.textContent = 'Back to live camera';
  btn.disabled = false;
  setReady(true);
  await refreshDeviceLists();
}

function closeTestPlayback() {
  const playback = $('#check-playback');
  playback.pause?.();
  playback.removeAttribute('src');
  playback.load?.();
  playback.hidden = true;
  if (testUrl) URL.revokeObjectURL(testUrl);
  testUrl = null;
  $('#check-video').hidden = state.media.audioOnly;
  $('#btn-test-record').textContent = 'Record a 5-second test';
}

function setReady(ready) {
  $('#btn-start').disabled = !ready || testing;
  $('#btn-practice').disabled = !ready || testing;
  $('#btn-test-record').disabled = !ready || testing;
  if (!ready) {
    $('#d-camera').disabled = true;
    $('#d-mic').disabled = true;
  }
  $('#check-summary').textContent = ready && state.media.audioOnly ? 'Audio only' : '';
}

function setEmpty(text, showButton, buttonLabel = 'Allow camera and microphone') {
  $('#check-empty').hidden = false;
  $('#check-empty-text').textContent = text;
  const btn = $('#btn-allow');
  btn.hidden = !showButton;
  btn.textContent = buttonLabel;
  $('#check-audio-only').hidden = true;
}

function showError(info) {
  $('#check-error').hidden = false;
  $('#check-error-title').textContent = info.title;
  $('#check-error-text').textContent = info.message;
}

function hideError() {
  $('#check-error').hidden = true;
}
