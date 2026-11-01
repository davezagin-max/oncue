// Review screen: watch every submitted answer, download or delete it, or practice again.
// Interviews from a code also show the spoken time against each question's target.
import { $, el, formatClock, formatDuration, formatDate, formatBytes, downloadBlob, extensionFor, slugify, fileSafe } from './util.js';
import { state } from './state.js';
import { showScreen, toast, confirmDialog } from './ui.js';
import * as media from './media.js';
import * as db from './storage.js';
import { memoryTake, forgetSession, forgetTake, isOpenElsewhere, withSessionLock } from './interview.js';
import { targetVerdict } from './code.js';

let callbacks = {};
let urls = [];
let currentId = null;
let fromHistoryView = false;
let renderToken = 0;

/** An answer with a recording: not skipped (empty take) and not deleted. */
const hasRecording = (a) => Boolean(a) && !a.deleted && !a.skipped;

const OPEN_ELSEWHERE = 'This interview is open in another tab. Finish or leave it there first.';

const SOURCE_LABEL = {
  user: ['Your question', ''],
  likely: ['Likely question', 'likely'],
  curveball: ['Curveball', 'curve'],
};

export function initReview({ onPracticeAgain, onEdit, onDeleted, onResume }) {
  callbacks = { onPracticeAgain, onEdit, onDeleted, onResume };
  $('#btn-again').addEventListener('click', () => callbacks.onPracticeAgain?.());
  $('#btn-edit').addEventListener('click', () => callbacks.onEdit?.());
  $('#btn-resume').addEventListener('click', () => {
    if (currentId) callbacks.onResume?.(currentId);
  });
  $('#btn-delete-session').addEventListener('click', async () => {
    if (!currentId) return;
    if (await isOpenElsewhere(currentId)) {
      toast(OPEN_ELSEWHERE);
      return;
    }
    const ok = await confirmDialog({
      title: 'Delete this practice session?',
      text: 'All of its recordings will be removed from this browser. This cannot be undone.',
      ok: 'Delete',
      danger: true,
    });
    if (!ok || !currentId) return;
    const id = currentId;
    try {
      // Held while deleting, so no tab can start this interview halfway through.
      const outcome = await withSessionLock(id, () => db.deleteSession(id));
      if (!outcome.ok) {
        toast(OPEN_ELSEWHERE);
        return;
      }
    } catch {
      toast('This browser could not delete the session. Try again, or clear this site’s data in your browser settings.');
      return;
    }
    forgetSession(id);
    toast('Session deleted.');
    callbacks.onDeleted?.();
  });
}

function releaseMedia() {
  document.querySelectorAll('#answers video, #answers audio').forEach((m) => m.pause?.());
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
}

export function leaveReview() {
  renderToken += 1;
  releaseMedia();
  $('#answers').replaceChildren();
  currentId = null;
}

/** fromHistory: opened from Past sessions rather than right after an interview. */
export async function showReview(sessionId, { fromHistory = false } = {}) {
  let session = null;
  try {
    session = await db.getSession(sessionId);
  } catch {
    session = null;
  }
  if (!session) {
    toast('That practice session could not be found.');
    if (callbacks.onEdit) callbacks.onEdit(); // back to setup, redrawn
    else showScreen('setup');
    return;
  }
  showScreen('review');
  currentId = session.id;
  fromHistoryView = fromHistory;
  await render(session);
  showStorage();
}

async function render(session, { focusIndex = -1 } = {}) {
  const token = ++renderToken;
  const coded = Boolean(session.coded);
  const complete = session.status === 'complete';
  const answers = session.answers || {};
  const total = session.questions.length;
  const answered = session.questions.filter((q) => answers[q.id]); // reached: answered, skipped or deleted
  const kept = answered.filter((q) => hasRecording(answers[q.id]));
  const seconds = kept.reduce((sum, q) => sum + (answers[q.id].duration || 0), 0);
  const savedCount = kept.filter((q) => answers[q.id].saved !== false).length;

  if (coded) {
    $('#review-title').textContent = complete ? 'Interview complete' : 'Interview in progress';
    $('#review-sub').textContent = [
      complete ? `${savedCount} answer${savedCount === 1 ? '' : 's'} saved` : null,
      session.name || 'Practice interview',
      complete ? null : `${kept.length} of ${total} answered`,
      kept.length ? `${formatDuration(seconds)} recorded` : null,
      formatDate(session.createdAt),
    ]
      .filter(Boolean)
      .join(' · ');
  } else {
    $('#review-title').textContent = complete ? 'Your interview is complete. Great job!' : 'Interview ended early';
    const who = [session.role, session.company].filter(Boolean).join(' at ');
    $('#review-sub').textContent = [who || null, `${kept.length} of ${total} answered`, `${formatDuration(seconds)} recorded`, formatDate(session.createdAt)]
      .filter(Boolean)
      .join(' · ');
  }
  // To practice a coded interview again, the person who made it sends a new code.
  $('#btn-resume').hidden = !(coded && !complete);
  $('#btn-again').hidden = coded;
  // "Practice again" uses your current setup, so say so when this is an older session.
  $('#btn-again').textContent = fromHistoryView ? 'Start a new practice' : 'Practice again';
  $('#btn-edit').textContent = coded ? 'Back to start' : 'Change questions';

  const unsaved = kept.filter((q) => answers[q.id].saved === false && memoryTake(answers[q.id].recordingId)).length;
  $('#review-unsaved').hidden = !unsaved;
  $('#review-unsaved').textContent = unsaved
    ? `${unsaved === 1 ? 'One answer' : `${unsaved} answers`} could not be saved in this browser (it may be out of space). Download ${unsaved === 1 ? 'it' : 'them'} now: ${unsaved === 1 ? 'it disappears' : 'they disappear'} when you close this tab.`
    : '';

  let recordings = [];
  try {
    recordings = await db.getRecordingsForSession(session.id);
  } catch {
    recordings = [];
  }
  // The person navigated away, or a newer render started, meanwhile.
  if (currentId !== session.id || token !== renderToken) return;
  releaseMedia();
  const byId = new Map(recordings.map((r) => [r.id, r]));

  // Deleted answers are gone. In an open coded interview, questions not reached yet stay hidden.
  const shown = session.questions
    .map((q, i) => ({ q, n: i + 1 }))
    .filter(({ q }) => !answers[q.id]?.deleted && (complete || !coded || answers[q.id]));
  const list = $('#answers');
  list.replaceChildren(...shown.map(({ q, n }) => renderAnswer(session, q, n, byId)));
  if (focusIndex >= 0) {
    // After a delete: the answer that took its place, or the one before it, or the heading.
    const items = list.querySelectorAll('.answer-num');
    const next = items[Math.min(focusIndex, items.length - 1)];
    if (next) next.focus({ preventScroll: true });
    else $('#review-title').focus();
  }
}

function renderAnswer(session, q, n, byId) {
  const coded = Boolean(session.coded);
  const answer = session.answers?.[q.id];
  const rec = answer?.recordingId ? byId.get(answer.recordingId) : null;
  const blob = rec?.blob || (answer?.recordingId ? memoryTake(answer.recordingId) : null);

  const meta = el('div', { class: 'answer-meta' });
  if (!coded) {
    const [label, tone] = SOURCE_LABEL[q.source] || SOURCE_LABEL.user;
    meta.append(el('span', { class: `pill ${tone}` }, label));
  }
  if (hasRecording(answer)) {
    if (coded) {
      const spoke = Math.round(answer.duration || 0);
      // Targets stay hidden until the whole interview is done (never during it).
      const target = session.status === 'complete' ? q.targetSec : null;
      // Plain seconds, like the targets in the Interview Setter, so the two compare at a glance.
      meta.append(el('span', {}, `Spoke ${spoke} sec${target ? ` · target ${target} sec` : ''}`));
      const verdict = targetVerdict(spoke, target);
      if (verdict) meta.append(el('span', { class: `pill ${verdict.tone}` }, verdict.words));
    } else {
      meta.append(el('span', {}, formatClock(answer.duration || 0)));
    }
    if (answer.takes > 1) meta.append(el('span', {}, answer.takes === 2 ? 'Retaken once' : `${answer.takes} takes`));
  }

  const head = el(
    'div',
    { class: 'answer-head' },
    el('span', { class: 'answer-num', tabindex: '-1' }, `Question ${n}`),
    el('p', { class: 'answer-q' }, q.text),
    meta.childNodes.length ? meta : null,
    q.why && q.source !== 'user' && !coded ? el('p', { class: 'answer-why' }, q.why) : null,
  );

  let player;
  const tools = el('div', { class: 'answer-tools' });
  if (answer?.skipped) {
    player = el('div', { class: 'answer-missing' }, 'Skipped: the recording came out empty.');
  } else if (blob && blob.size) {
    const url = URL.createObjectURL(blob);
    urls.push(url);
    const type = rec?.mimeType || answer.mimeType || blob.type || '';
    player = el(type.startsWith('audio/') ? 'audio' : 'video', {
      controls: true,
      preload: 'metadata',
      playsinline: true,
      'aria-label': `Your answer to question ${n}`,
    });
    media.fixInfiniteDuration(player);
    player.src = url;
    media.applySink(player, state.devices.speakerId);
    player.addEventListener('play', () => {
      // Some browsers only switch speakers during a click, so apply it again on play.
      media.applySink(player, state.devices.speakerId);
      document.querySelectorAll('#answers video, #answers audio').forEach((m) => {
        if (m !== player) m.pause();
      });
    });
    const ext = extensionFor(type);
    const filename = coded
      ? `${fileSafe(session.name) || 'Interview'} - Q${n} - ${fileSafe(q.text, 50) || 'Answer'}.${ext}`
      : `oncue-q${n}-${slugify(q.text)}.${ext}`;
    tools.append(
      el('button', { class: 'btn sm', type: 'button', 'aria-label': `Download your answer to question ${n}`, onclick: () => downloadBlob(blob, filename) }, 'Download'),
    );
  } else if (answer && blob && !blob.size) {
    player = el('div', { class: 'answer-missing' }, 'This take came out empty, so there is nothing to play.');
  } else if (answer) {
    player = el('div', { class: 'answer-missing' }, 'This recording is no longer available in this browser.');
  } else {
    player = el('div', { class: 'answer-missing' }, 'Not answered');
  }
  if (hasRecording(answer)) {
    tools.append(
      el(
        'button',
        { class: 'btn sm ghost', type: 'button', 'aria-label': `Delete your answer to question ${n}`, onclick: () => deleteAnswer(session, q, n) },
        'Delete',
      ),
    );
  }

  return el('li', { class: 'answer', dataset: { qid: q.id } }, head, el('div', {}, player, tools.childNodes.length ? tools : null));
}

async function deleteAnswer(session, q, n) {
  if (await isOpenElsewhere(session.id)) {
    toast(OPEN_ELSEWHERE);
    return;
  }
  const ok = await confirmDialog({
    title: `Delete your answer to question ${n}?`,
    text: 'The recording will be removed from this browser. This cannot be undone.',
    ok: 'Delete',
    danger: true,
  });
  const shown = session.answers?.[q.id]; // the take this row was drawn for
  if (!ok || currentId !== session.id || !hasRecording(shown)) return;
  const position = [...document.querySelectorAll('#answers > li')].findIndex((li) => li.dataset.qid === q.id);
  // Another tab may have moved this interview on since this screen loaded: change the
  // latest saved copy, holding its lock so no tab starts the interview meanwhile.
  let outcome;
  try {
    outcome = await withSessionLock(session.id, async () => {
      const fresh = await db.getSession(session.id);
      const answer = fresh?.answers?.[q.id];
      if (!fresh || !hasRecording(answer) || answer.recordingId !== shown.recordingId) return { fresh, changed: false };
      if (answer.recordingId) await db.deleteRecording(answer.recordingId);
      // Only a marker stays, so a resumed interview does not ask the question again.
      fresh.answers[q.id] = { deleted: true, submittedAt: answer.submittedAt || Date.now() };
      fresh.updatedAt = Date.now();
      await db.saveSession(fresh);
      return { fresh, changed: true, recordingId: answer.recordingId };
    });
  } catch {
    toast('This browser could not delete the recording. Try again in a moment.');
    return;
  }
  if (!outcome.ok) {
    toast(OPEN_ELSEWHERE);
    return;
  }
  const { fresh, changed, recordingId } = outcome.value;
  if (recordingId) forgetTake(recordingId);
  if (currentId !== session.id) return;
  if (!fresh) {
    toast('This practice session was deleted.');
    callbacks.onDeleted?.();
    return;
  }
  toast(changed ? 'Answer deleted.' : 'This answer had already changed. Showing the latest.');
  await render(fresh, { focusIndex: Math.max(0, position) });
  showStorage();
}

async function showStorage() {
  const line = $('#review-storage');
  const { usage = 0, quota = 0 } = await db.estimate();
  line.hidden = !quota;
  line.textContent = quota ? `Storage used: ${formatBytes(usage)} of ${formatBytes(quota)}` : '';
}
