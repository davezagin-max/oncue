// The interview itself, modeled on how one-way video interviews work:
// the question appears with a prep countdown ("Not recording"), then a 3-2-1
// countdown, then recording with a time limit. After a take you can watch it
// and either re-record (if you have retakes left) or move on. Only the latest
// take is kept. A practice mode runs the same flow without saving anything.
import { $, el, formatClock, formatDuration, uid, prefs, wait } from './util.js';
import { state, saveDevices } from './state.js';
import { showScreen, toast, confirmDialog } from './ui.js';
import * as media from './media.js';
import * as db from './storage.js';

const MIN_ANSWER_SECONDS = 2; // "Done answering" unlocks after this, to avoid double-click accidents
const COUNTDOWN_SECONDS = 3;

const PRACTICE_QUESTIONS = [
  'What is a place you would love to visit, and why?',
  'Tell us about a hobby you enjoy.',
  'What is the best piece of advice you have ever received?',
  'Describe your ideal weekend.',
  'What is something you learned recently that surprised you?',
];

/** Takes that could not be saved to the browser database (kept for this tab). */
const memoryTakes = new Map(); // recordingId -> { sessionId, blob }
export function memoryTake(recordingId) {
  return memoryTakes.get(recordingId)?.blob || null;
}

/** Drop unsaved takes kept in memory for a session that was deleted. */
export function forgetSession(sessionId) {
  for (const [id, entry] of memoryTakes) if (entry.sessionId === sessionId) memoryTakes.delete(id);
}

/** Drop one unsaved take kept in memory (its answer was deleted). */
export function forgetTake(recordingId) {
  memoryTakes.delete(recordingId);
}

let run = null;
let practiceIndex = Math.floor(Math.random() * PRACTICE_QUESTIONS.length);
let selfViewWired = false;

/**
 * Starts a real interview.
 * session: { id, questions: [{ id, text, prep, answer, source }], answers: {}, settings: { retakes, speak } }
 */
export async function startInterview(session, { onFinish }) {
  session.answers = session.answers || {};
  const release = await claimSession(session.id);
  if (!release) {
    toast('This interview is open in another tab. Finish it there, or close that tab and try again.', 6000);
    return false;
  }
  const firstOpen = session.questions.findIndex((q) => !session.answers[q.id]);
  if (firstOpen === -1) {
    // Every question already has an answer (the tab closed just before the end): finish.
    release();
    session.status = 'complete';
    session.updatedAt = Date.now();
    await db.saveSession(session).catch(() => {});
    onFinish(session.id);
    return true;
  }
  begin({ mode: 'real', session, onFinish, index: firstOpen, release });
  return true;
}

const LOCK_PREFIX = 'oncue-session:';

/**
 * Holds a lock while a session runs, so a second tab can't run or change it at
 * the same time. Resolves a function that releases it, or null when another
 * tab holds it. The browser releases it too when the tab closes.
 */
function claimSession(id) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    locks
      .request(LOCK_PREFIX + id, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        return new Promise((release) => resolve(release));
      })
      .catch(() => resolve(() => {}));
  });
}

/**
 * Runs `fn` while holding the session's lock, so no tab can start or resume the
 * interview meanwhile. Resolves { ok: true, value } or { ok: false } (fn not run)
 * when another tab is running it. Without lock support, fn just runs.
 */
export async function withSessionLock(id, fn) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return { ok: true, value: await fn() };
  let ran = false;
  try {
    return await locks.request(LOCK_PREFIX + id, { ifAvailable: true }, async (lock) => {
      if (!lock) return { ok: false };
      ran = true;
      return { ok: true, value: await fn() };
    });
  } catch (err) {
    if (ran) throw err;
    return { ok: true, value: await fn() }; // locks refused in this context: carry on without one
  }
}

/** True while some tab (another one, when called from the review or setup screen) is running this session. */
export async function isOpenElsewhere(id) {
  try {
    const snapshot = await globalThis.navigator?.locks?.query?.();
    return Boolean(snapshot?.held?.some((l) => l.name === LOCK_PREFIX + id));
  } catch {
    return false;
  }
}

/**
 * Starts an unsaved practice question with a generic prompt.
 * onStartReal(choice) is called with 'interview' (start the real one) or 'back'.
 */
export function startPractice({ prep = 20, answer = 60, speak = state.setup.speak, onStartReal }) {
  practiceIndex = (practiceIndex + 1) % PRACTICE_QUESTIONS.length;
  const question = { id: 'practice', text: PRACTICE_QUESTIONS[practiceIndex], prep, answer, source: 'practice' };
  begin({
    mode: 'practice',
    session: { id: 'practice', questions: [question], answers: {}, settings: { retakes: Infinity, speak } },
    onStartReal,
    index: 0,
  });
}

function begin(options) {
  if (run) teardown({ keepStream: true });
  run = {
    ...options,
    phase: 'idle',
    takesUsed: 0, // takes recorded for the current question that counted
    take: null, // { blob, mimeType, duration, url }
    recorder: null,
    timer: null,
    meter: null,
    unwatch: null,
    unwatchDevices: null,
    interrupted: false,
    busy: false,
  };
  showScreen('interview');
  wireSelfView();
  media.setAudioSession('play-and-record');
  media.setCueSink(state.devices.speakerId);
  if (run.mode === 'real') window.addEventListener('beforeunload', beforeUnload);
  attachLive();
  startMeter();
  run.unwatch = media.watchTracks(state.media.stream, onTrackEnded, onTrackMuted);
  run.unwatchDevices = media.onDeviceChange(onDevicesChanged);
  hideBanner();
  updateDeviceLine();
  $('#topbar-progress').hidden = run.mode === 'practice';
  $('#btn-leave').textContent = run.mode === 'practice' ? 'Back to camera check' : 'Leave interview';
  beginQuestion(run.index);
}

/** Asks before leaving mid-interview. Resolves true if the person left. */
export async function requestLeave() {
  if (!run) return true;
  if (run.mode === 'practice') {
    const { onStartReal } = run;
    run.recorder?.cancel();
    teardown({ keepStream: true });
    onStartReal?.('back');
    return true;
  }
  if (isSaving()) {
    toast('Saving your answer… try again in a moment.');
    return false;
  }
  const myRun = run;
  const coded = isCoded();
  const recorded = () => Object.values(myRun.session.answers).filter((a) => a && !a.skipped && !a.deleted).length;
  const ok = await confirmLeave(
    coded
      ? {
          // Like closing the tab: the interview stays open and picks up at the next unanswered question.
          title: 'Leave the interview?',
          text: `${recorded() ? 'Your submitted answers are saved. ' : ''}You can resume later from Past practice sessions. The question on screen now will be asked again.`,
          ok: 'Leave interview',
          cancel: 'Keep going',
          danger: true,
        }
      : {
          title: 'Leave the interview?',
          text: recorded()
            ? 'The answers you already submitted are saved. The current question will not be saved.'
            : 'Nothing has been submitted yet, so this practice session will be discarded.',
          ok: 'Leave interview',
          cancel: 'Keep going',
          danger: true,
        },
  );
  if (!ok || run !== myRun) return false;
  // Time may have run out behind the dialog: let that answer finish saving first (up to 8 s).
  for (let i = 0; i < 80 && run === myRun && isSaving(); i += 1) await wait(100);
  if (run !== myRun) return true; // that answer ended the interview, and the review is showing
  const answered = recorded();
  const { session, onFinish } = run;
  run.recorder?.cancel();
  session.updatedAt = Date.now();
  if (!coded) session.status = 'left';
  teardown();
  if (coded || answered) {
    await db.saveSession(session).catch(() => {});
    onFinish(answered ? session.id : null);
  } else {
    await db.deleteSession(session.id).catch(() => {});
    onFinish(null);
  }
  return true;
}

/** A take is being finished or an answer saved: leaving now could lose it. */
function isSaving() {
  return Boolean(run) && (run.busy || run.phase === 'stopping' || run.phase === 'saving');
}

export function isRunning() {
  return Boolean(run);
}

/**
 * Asks before leaving. While the question is open, timers keep running, but the
 * countdown or recording doesn't start behind the dialog: it waits for "Keep going".
 */
async function confirmLeave(options) {
  const myRun = run;
  myRun.leaving = true;
  const ok = await confirmDialog(options);
  if (run !== myRun) return false;
  run.leaving = false;
  if (!ok) {
    const held = run.held;
    run.held = null;
    held?.();
  }
  return ok;
}

/** Runs `fn` now, or after the leave dialog closes with "Keep going". */
function unlessLeaving(fn) {
  if (run?.leaving) run.held = fn;
  else fn();
}

/** The next question after `from` without an answer, or -1 when none is left. */
function nextOpen(from) {
  const { questions, answers } = run.session;
  for (let i = from + 1; i < questions.length; i += 1) if (!answers[questions[i].id]) return i;
  return -1;
}

/** An interview from a code: no hints on screen, a tone when recording starts. */
function isCoded() {
  return Boolean(run?.session?.coded);
}

function startNowButton() {
  return button('Start recording now', 'primary lg', startCountdown);
}

// ---------- Question flow ----------

function current() {
  return run.session.questions[run.index];
}

function beginQuestion(index) {
  run.index = index;
  run.takesUsed = 0;
  run.interrupted = false;
  discardTake();
  const total = run.session.questions.length;
  if (run.mode === 'practice') {
    $('#iv-kicker').textContent = 'Practice question';
  } else {
    $('#progress-text').textContent = `Question ${index + 1} of ${total}`;
    const bar = $('#progress-bar');
    bar.setAttribute('aria-valuenow', String(Math.round((index / total) * 100)));
    bar.querySelector('span').style.width = `${(index / total) * 100}%`;
    $('#iv-kicker').textContent = `Question ${index + 1} of ${total}`;
  }
  $('#iv-question').textContent = current().text;
  startPrep();
  $('#iv-question').focus({ preventScroll: true });
}

function startPrep() {
  const q = current();
  run.phase = 'prep';
  stopTimer();
  showLive();
  setBadge('Not recording', 'idle');
  const where = run.mode === 'practice' ? 'Practice question.' : `Question ${run.index + 1}.`;
  announce(`${where} ${q.text}${q.prep ? ` You have ${formatDuration(q.prep)} to prepare.` : ''}`);
  const reading = run.session.settings?.speak ? speak(q.text) : null;

  setActions([startNowButton()]);
  setNote(
    run.mode === 'practice'
      ? 'Practice answers are not saved. Recording starts on its own when prep time ends.'
      : isCoded()
        ? ''
        : 'Recording starts on its own when prep time ends.',
  );
  if (!q.prep) {
    // No prep time: let the question finish being read aloud, then count down.
    const myRun = run;
    if (reading) reading.then(() => run === myRun && run.phase === 'prep' && unlessLeaving(startCountdown));
    else unlessLeaving(startCountdown);
    return;
  }
  run.timer = countdown(q.prep, (left) => setTimer('Prep time', left, left / q.prep, 'prep'), () => unlessLeaving(startCountdown));
}

/** The 3-2-1 before recording, as in the real thing. */
function startCountdown() {
  if (!run || run.phase !== 'prep') return;
  stopTimer();
  if (!isLive(state.media.stream)) {
    showBanner('Your camera or microphone is not connected. Reconnect it, then try again.', 'Reconnect', () => reconnect());
    return;
  }
  run.phase = 'countdown';
  setActions([button('Get ready…', 'primary lg', null, true)]);
  setBadge(null);
  const overlay = $('#iv-countdown');
  overlay.hidden = false;
  let shown = -1;
  run.timer = countdown(
    COUNTDOWN_SECONDS,
    (left) => {
      const n = Math.max(1, Math.ceil(left));
      if (n !== shown) {
        shown = n;
        overlay.textContent = String(n);
      }
      setTimer('Recording starts in', left, left / COUNTDOWN_SECONDS, 'prep');
    },
    () =>
      unlessLeaving(() => {
        // A device may have dropped while the leave dialog was open.
        if (run?.phase !== 'countdown') return;
        overlay.hidden = true;
        if (!isCoded()) {
          startRecording();
          return;
        }
        // A soft tone marks the start, then recording begins once it has faded.
        media.playCue();
        const timeout = setTimeout(() => unlessLeaving(startRecording), 220);
        run.timer = { stop: () => clearTimeout(timeout) };
      }),
  );
}

function startRecording() {
  if (!run || run.phase !== 'countdown') return;
  const q = current();
  stopTimer();
  stopSpeaking(); // never record the computer's voice
  $('#iv-countdown').hidden = true;
  if (!isLive(state.media.stream)) {
    run.phase = 'prep';
    showBanner('Your camera or microphone is not connected. Reconnect it, then try again.', 'Reconnect', () => reconnect());
    setActions([startNowButton()]);
    return;
  }
  run.phase = 'recording';
  run.interrupted = false;
  run.recorder = new media.Recorder(state.media.stream, { audioOnly: state.media.audioOnly });
  run.recorder.onerror = () => {
    if (run?.phase === 'recording') {
      run.interrupted = true;
      stopRecording();
    }
  };
  try {
    run.recorder.start();
  } catch (err) {
    console.error(err);
    run.phase = 'prep';
    run.recorder = null;
    showBanner('Recording could not start in this browser. Try a current version of Chrome, Edge, Firefox or Safari.', null, null);
    setActions([startNowButton()]);
    return;
  }
  announce('Recording.');
  const doneBtn = button('Done answering', 'danger lg', () => stopRecording());
  doneBtn.disabled = true;
  setTimeout(() => {
    doneBtn.disabled = false;
    const active = document.activeElement;
    if (doneBtn.isConnected && (!active || active === document.body || $('#iv-actions').contains(active))) doneBtn.focus({ preventScroll: true });
  }, MIN_ANSWER_SECONDS * 1000);
  setActions([doneBtn]);
  setNote(isCoded() ? '' : 'Recording stops on its own when time runs out.');
  let warned = false;
  run.timer = countdown(
    q.answer,
    (left, fraction, elapsed) => {
      setTimer('Time remaining', left, fraction, 'recording');
      setBadge(`Recording ${formatClock(elapsed)}`, 'rec');
      if (!warned && left <= 10 && q.answer > 20) {
        warned = true;
        announce('10 seconds left.');
      }
    },
    () => stopRecording(true),
  );
}

async function stopRecording(auto = false) {
  if (!run || run.phase !== 'recording') return;
  run.phase = 'stopping';
  stopTimer();
  setBadge(null);
  setActions([button('Saving your answer…', 'lg', null, true)]);
  const myRun = run;
  const recorder = run.recorder;
  const take = await recorder.stop();
  if (run !== myRun) return; // the person left while the take was finishing
  run.recorder = null;
  // An empty file is the browser's fault, not yours: it doesn't use up a retake.
  if (!take.blob.size) run.interrupted = true;
  if (!run.interrupted) run.takesUsed += 1;
  if (run.mode === 'real' && retakesLeft() === 0 && run.takesUsed === 1 && !run.interrupted && take.blob.size) {
    // Retakes are off: like the real thing, the answer is submitted straight away.
    run.take = { ...take, url: '' };
    toast(auto ? 'Time’s up. Answer saved.' : 'Answer saved.', 2200);
    submit(true);
    return;
  }
  showTake(take, auto);
}

function retakesLeft() {
  const allowed = Number(run.session.settings?.retakes ?? 1);
  if (allowed < 0 || allowed === Infinity) return Infinity; // as many as you like
  // The first take is free; every take after that uses a retake.
  return Math.max(0, allowed - Math.max(0, run.takesUsed - 1));
}

function showTake(take, auto) {
  run.phase = 'review';
  discardTake();
  run.take = { ...take, url: URL.createObjectURL(take.blob) };
  const playback = $('#iv-playback');
  media.fixInfiniteDuration(playback);
  playback.src = run.take.url;
  media.applySink(playback, state.devices.speakerId);
  showPlayback();
  setTimer(auto ? 'Time’s up. Your answer' : 'Your answer', take.duration, 1, 'done');

  if (run.mode === 'practice') {
    setActions([
      button('Start the interview', 'primary lg', () => {
        if (!run) return;
        const { onStartReal } = run;
        teardown({ keepStream: true });
        onStartReal?.('interview');
      }),
      button('Practice again', 'lg', () => {
        if (!run) return;
        practiceIndex = (practiceIndex + 1) % PRACTICE_QUESTIONS.length;
        const q = current();
        q.text = PRACTICE_QUESTIONS[practiceIndex];
        $('#iv-question').textContent = q.text;
        discardTake();
        startPrep();
      }),
    ]);
    setNote('Watch your practice take, then start the real interview when you’re ready. Practice answers are not saved.');
    announce('Practice answer recorded.');
    return;
  }

  const left = retakesLeft();
  const last = nextOpen(run.index) === -1;
  let actions;
  if (!take.blob.size) {
    // Nothing was recorded: don't let an empty answer be saved by accident.
    actions = [button('Re-record (free)', 'primary lg', retake), button(last ? 'Skip and finish' : 'Skip this question', 'lg', skipQuestion)];
  } else {
    const useLabel = isCoded() ? 'Use this answer' : last ? 'Finish interview' : 'Next question';
    actions = [button(useLabel, 'primary lg', () => submit())];
    if (run.interrupted) actions.push(button('Re-record (free)', 'lg', retake));
    else if (left === Infinity) actions.push(button('Retake', 'lg', retake));
    else if (left > 0) actions.push(button(`Re-record (${left} left)`, 'lg', retake));
  }
  setActions(actions);
  if (!take.blob.size) {
    setNote('This take came out empty, which is usually a browser hiccup. Re-recording will not use up a retake.');
  } else if (run.interrupted) {
    setNote('This take was cut short when a device disconnected, so re-recording will not use up a retake.');
  } else if (isCoded()) {
    setNote('');
  } else {
    setNote(left > 0 ? 'Watch it back if you like. Your latest take is the one that’s saved.' : 'No retakes left for this question.');
  }
  announce(auto ? 'Time is up. Your answer was recorded.' : 'Answer recorded.');
}

/** Move on without saving anything for this question (used when a take came out empty). */
async function skipQuestion() {
  if (!run || run.phase !== 'review' || run.busy) return;
  run.busy = true;
  run.phase = 'saving';
  setActions([button('Skipping…', 'lg', null, true)]);
  const myRun = run;
  const session = run.session;
  discardTake();
  if (run.mode === 'real') {
    // Recorded as skipped, so a resumed interview moves on instead of asking it again.
    session.answers[current().id] = { skipped: true, recordingId: null, duration: 0, takes: run.takesUsed, submittedAt: Date.now() };
    session.updatedAt = Date.now();
    await db.saveSession(session).catch(() => {});
    if (run !== myRun) return;
  }
  run.busy = false;
  const next = nextOpen(run.index);
  if (next !== -1) beginQuestion(next);
  else finish();
}

async function retake() {
  if (!run || run.phase !== 'review' || run.busy) return;
  const free = run.interrupted;
  const left = retakesLeft();
  if (!free && left !== Infinity) {
    const ok = await confirmDialog({
      title: 'Re-record this answer?',
      text: `Your current take will be deleted. ${left === 1 ? 'This is your last retake for this question.' : `You have ${left} retakes left.`}`,
      ok: 'Re-record',
      cancel: 'Keep this take',
    });
    if (!ok || !run || run.phase !== 'review') return;
  }
  run.interrupted = false;
  discardTake();
  startPrep();
}

async function submit(skipReview = false) {
  if (!run || run.busy || (!skipReview && run.phase !== 'review')) return;
  run.busy = true;
  run.phase = 'saving';
  const q = current();
  const take = run.take;
  const session = run.session;
  setActions([button('Saving…', 'primary lg', null, true)]);
  const recordingId = uid('rec');
  let saved = true;
  try {
    await db.saveRecording({
      id: recordingId,
      sessionId: session.id,
      questionId: q.id,
      blob: take.blob,
      mimeType: take.mimeType,
      duration: take.duration,
      createdAt: Date.now(),
    });
  } catch (err) {
    saved = false;
    memoryTakes.set(recordingId, { sessionId: session.id, blob: take.blob });
    toast('This answer could not be saved in your browser (it may be out of space). It is kept until you close this tab, and you can download it on the review screen.', 7000);
    void err;
  }
  if (!run) return;
  session.answers[q.id] = {
    recordingId,
    duration: take.duration,
    mimeType: take.mimeType,
    takes: Math.max(1, run.takesUsed),
    saved,
    submittedAt: Date.now(),
  };
  session.updatedAt = Date.now();
  await db.saveSession(session).catch(() => {});
  if (!run) return;
  run.busy = false;
  discardTake();
  const next = nextOpen(run.index);
  if (next !== -1) beginQuestion(next);
  else finish();
}

async function finish() {
  const { session, onFinish } = run;
  session.status = 'complete';
  session.updatedAt = Date.now();
  $('#progress-bar span').style.width = '100%';
  teardown();
  await db.saveSession(session).catch(() => {});
  onFinish(session.id);
}

function teardown({ keepStream = false } = {}) {
  if (!run) return;
  stopTimer();
  stopSpeaking();
  run.meter?.stop();
  run.unwatch?.();
  run.unwatchDevices?.();
  discardTake();
  $('#iv-countdown').hidden = true;
  window.removeEventListener('beforeunload', beforeUnload);
  if (!keepStream) {
    // Releasing the mic also lets Bluetooth headsets switch back to full-quality sound.
    media.stopStream(state.media.stream);
    state.media.stream = null;
    $('#iv-live').srcObject = null;
    media.setAudioSession('auto');
  }
  hideBanner();
  run.release?.();
  run = null;
}

function beforeUnload(e) {
  if (!run || run.mode !== 'real') return;
  e.preventDefault();
  e.returnValue = '';
}

// ---------- Devices during the interview ----------

function isLive(stream) {
  return Boolean(stream) && stream.getAudioTracks().some((t) => t.readyState === 'live');
}

function attachLive() {
  const video = $('#iv-live');
  video.srcObject = state.media.audioOnly ? null : state.media.stream;
  video.play?.().catch(() => {});
  $('#iv-audio-only').hidden = !state.media.audioOnly;
  applySelfView();
}

function startMeter() {
  run.meter?.stop();
  run.meter = new media.LevelMeter(state.media.stream);
  const bars = [...document.querySelectorAll('#iv-meter i')];
  const ok = run.meter.start((level) => {
    bars.forEach((bar, i) => {
      const on = level > (i + 0.5) / (bars.length + 1);
      bar.style.height = on ? `${6 + i * 3}px` : '4px';
      bar.style.background = on ? '#ffffff' : 'rgba(255,255,255,0.35)';
    });
  });
  $('#iv-meter').hidden = !ok;
}

function updateDeviceLine() {
  const ids = media.activeDeviceIds(state.media.stream);
  const parts = [];
  if (ids.micLabel) parts.push(`Mic: ${ids.micLabel}`);
  if (ids.cameraLabel && !state.media.audioOnly) parts.push(`Camera: ${ids.cameraLabel}`);
  $('#iv-devices').textContent = parts.join(' · ');
}

function onTrackEnded(kind) {
  if (!run) return;
  const what = kind === 'audio' ? 'microphone' : 'camera';
  if (run.phase === 'recording') {
    run.interrupted = true;
    stopRecording();
  } else if (run.phase === 'countdown') {
    stopTimer();
    $('#iv-countdown').hidden = true;
    run.phase = 'prep';
    setActions([startNowButton()]);
  }
  showBanner(`Your ${what} disconnected. Reconnecting to the default ${what}…`, null, null);
  reconnect(kind);
}

function onTrackMuted(kind, muted) {
  if (!run || kind !== 'audio') return;
  if (muted) showBanner('Your microphone is muted by your computer or headset. Unmute it so your answer has sound.', null, null);
  else if ($('#iv-banner-text').textContent.startsWith('Your microphone is muted')) hideBanner();
}

async function onDevicesChanged() {
  if (!run || !state.devices.speakerId || state.devices.speakerId === 'default') return;
  const { speakers } = await media.listDevices();
  if (run && speakers.length && !speakers.some((d) => d.deviceId === state.devices.speakerId)) {
    state.devices.speakerId = '';
    saveDevices();
    media.applySink($('#iv-playback'), '');
    media.setCueSink('');
    toast('Your headphones disconnected. Sound will play through your default output.');
  }
}

async function reconnect(kind) {
  if (!run) return;
  if (run.reconnecting) return; // one reconnect at a time
  const myRun = run;
  run.reconnecting = true;
  $('#iv-banner .btn')?.setAttribute('disabled', '');
  run.unwatch?.();
  run.unwatch = null;
  const old = state.media.stream;
  media.stopStream(old);
  try {
    const { stream, audioOnly } = await media.openStream({
      cameraId: kind === 'video' ? '' : state.devices.cameraId,
      micId: kind === 'audio' ? '' : state.devices.micId,
    });
    if (run !== myRun) {
      // The interview ended (or a new one started) while we were reconnecting.
      media.stopStream(stream);
      return;
    }
    if (state.media.stream && state.media.stream !== old && state.media.stream !== stream) media.stopStream(state.media.stream);
    state.media.stream = stream;
    state.media.audioOnly = audioOnly;
    const ids = media.activeDeviceIds(stream);
    if (ids.micId) state.devices.micId = ids.micId;
    if (ids.cameraId) state.devices.cameraId = ids.cameraId;
    saveDevices();
    run.unwatch = media.watchTracks(stream, onTrackEnded, onTrackMuted);
    attachLive();
    startMeter();
    // Don't cover a take that is being watched with the live view or the meter.
    if (['review', 'stopping', 'saving'].includes(run.phase)) showPlayback();
    else showLive();
    updateDeviceLine();
    showBanner(`Reconnected${ids.micLabel ? ` using ${ids.micLabel}` : ''}.`, null, null);
    setTimeout(() => {
      if (run && $('#iv-banner-text').textContent.startsWith('Reconnected')) hideBanner();
    }, 5000);
    if (run.phase === 'prep') setActions([startNowButton()]);
  } catch (err) {
    if (run !== myRun) return;
    const info = media.describeMediaError(err);
    showBanner(`${info.title}. ${info.message}`, 'Try again', () => reconnect(kind));
  } finally {
    if (myRun) myRun.reconnecting = false;
  }
}

// ---------- Self-view (some people find watching themselves distracting) ----------

function wireSelfView() {
  if (selfViewWired) return;
  selfViewWired = true;
  $('#iv-hide-self').addEventListener('click', () => {
    prefs.set('hideSelf', !prefs.get('hideSelf', false));
    applySelfView();
  });
}

function applySelfView() {
  const hidden = prefs.get('hideSelf', false) && !state.media.audioOnly;
  const liveVisible = !$('#iv-live').hidden;
  $('#iv-self-hidden').hidden = !(hidden && liveVisible);
  $('#iv-hide-self').textContent = hidden ? 'Show self-view' : 'Hide self-view';
  $('#iv-hide-self').hidden = state.media.audioOnly || !liveVisible;
}

// ---------- Rendering helpers ----------

function countdown(seconds, onTick, onDone) {
  const start = performance.now();
  const end = start + seconds * 1000;
  let finished = false;
  let interval = 0;
  let backstop = 0;
  const clear = () => {
    clearInterval(interval);
    clearTimeout(backstop);
    document.removeEventListener('visibilitychange', tick);
  };
  function tick() {
    if (finished) return;
    const now = performance.now();
    const left = Math.max(0, (end - now) / 1000);
    onTick(left, seconds > 0 ? left / seconds : 0, (now - start) / 1000);
    if (left <= 0) {
      finished = true;
      clear();
      onDone();
    }
  }
  interval = setInterval(tick, 100);
  // Backstop: finish on time even if the browser delays the regular ticks.
  backstop = setTimeout(tick, Math.max(0, seconds * 1000) + 30);
  document.addEventListener('visibilitychange', tick);
  tick();
  return {
    stop() {
      finished = true;
      clear();
    },
  };
}

function stopTimer() {
  run?.timer?.stop();
  if (run) run.timer = null;
}

function setTimer(label, seconds, fraction, mode) {
  const timer = $('#iv-timer');
  timer.classList.toggle('recording', mode === 'recording');
  timer.classList.toggle('done', mode === 'done');
  timer.classList.toggle('low', mode === 'recording' && seconds <= 10);
  $('#iv-timer-label').replaceChildren(mode === 'recording' ? el('span', { class: 'rec-dot', 'aria-hidden': 'true' }) : '', label);
  $('#iv-timer-value').textContent = formatClock(seconds);
  $('#iv-timer-bar').style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
}

function setActions(buttons) {
  const box = $('#iv-actions');
  const hadFocus = box.contains(document.activeElement) || document.activeElement === document.body || !document.activeElement;
  box.replaceChildren(...buttons);
  // Keep keyboard users on the main action as the buttons change.
  if (hadFocus) buttons.find((b) => !b.disabled)?.focus({ preventScroll: true });
}

function button(label, classes, onClick, disabled = false) {
  const btn = el('button', { class: `btn ${classes}`, type: 'button' }, label);
  if (onClick) btn.addEventListener('click', onClick);
  btn.disabled = disabled;
  return btn;
}

function setNote(text) {
  $('#iv-note').textContent = text;
}

/** kind: 'idle' (grey "Not recording") or 'rec' (red, pulsing). */
function setBadge(text, kind = 'rec') {
  const badge = $('#iv-badge');
  badge.hidden = !text;
  badge.classList.toggle('idle', kind === 'idle');
  if (text) $('#iv-badge-text').textContent = text;
}

function showLive() {
  const playback = $('#iv-playback');
  playback.pause?.();
  playback.hidden = true;
  $('#iv-live').hidden = state.media.audioOnly;
  $('#iv-audio-only').hidden = !state.media.audioOnly;
  $('#iv-meter').hidden = false;
  applySelfView();
}

function showPlayback() {
  $('#iv-live').hidden = true;
  $('#iv-audio-only').hidden = true;
  $('#iv-meter').hidden = true;
  $('#iv-playback').hidden = false;
  applySelfView();
}

function discardTake() {
  const playback = $('#iv-playback');
  playback.pause?.();
  playback.removeAttribute('src');
  playback.load?.();
  if (run?.take?.url) URL.revokeObjectURL(run.take.url);
  if (run) run.take = null;
}

function showBanner(text, actionLabel, action) {
  const banner = $('#iv-banner');
  banner.hidden = false;
  $('#iv-banner-text').textContent = text;
  banner.querySelector('.btn')?.remove();
  if (actionLabel && action) banner.append(button(actionLabel, 'sm', action));
}

function hideBanner() {
  $('#iv-banner').hidden = true;
  $('#iv-banner').querySelector('.btn')?.remove();
}

function announce(text) {
  const region = $('#iv-live-region');
  region.textContent = '';
  setTimeout(() => {
    region.textContent = text;
  }, 50);
}

/** Reads the question aloud. Resolves when it finishes (or after a time limit). */
function speak(text) {
  return new Promise((resolve) => {
    try {
      if (!('speechSynthesis' in window)) {
        resolve();
        return;
      }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.98;
      const done = () => resolve();
      u.onend = done;
      u.onerror = done;
      setTimeout(done, Math.min(15000, 2000 + text.length * 80));
      window.speechSynthesis.speak(u);
    } catch {
      resolve();
    }
  });
}

function stopSpeaking() {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
}
