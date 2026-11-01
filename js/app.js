// OnCue entry point: wires the four screens together.
//   setup  → check (camera, mic, speaker) → interview → review
import { $, uid, randomSeed } from './util.js';
import { state, likelyCount, saveSetup, codeWasUsed, markCodeUsed } from './state.js';
import { showScreen, wireDialogs, onLeave, currentScreen, toast } from './ui.js';
import { initSetup, refreshHistory, renderMode } from './setup.js';
import { initCheck, enterCheck, leaveCheck } from './check.js';
import { startInterview, startPractice, requestLeave, isRunning } from './interview.js';
import { initReview, showReview, leaveReview } from './review.js';
import { initLibrary } from './library.js';
import { buildInterview } from './engine.js';
import { unlockAudio, stopStream } from './media.js';
import * as db from './storage.js';

function goToSetup() {
  state.resume = null;
  renderMode(); // a coded interview that just started no longer shows here
  showScreen('setup');
  refreshHistory();
}

const onFinish = (id) => (id ? showReview(id) : goToSetup());

/** Continue a coded interview that was left (or whose tab was closed) partway. */
async function resumeSession(id) {
  unlockAudio(); // inside the click, before anything async, so Safari allows the tone later
  let session = null;
  try {
    session = await db.getSession(id);
  } catch {
    session = null;
  }
  if (!session?.coded || session.status === 'complete') {
    toast(session ? 'This interview is already complete.' : 'That interview could not be found.');
    goToSetup();
    return;
  }
  if (await closeIfAllAnswered(session)) return;
  state.resume = session;
  goToCheck();
}

/**
 * Every question has an answer, but the tab closed before the interview was
 * marked complete: mark it now and show the review instead of asking again.
 */
async function closeIfAllAnswered(session) {
  if (!session.questions.every((q) => session.answers?.[q.id])) return false;
  session.status = 'complete';
  session.updatedAt = Date.now();
  await db.saveSession(session).catch(() => {});
  showReview(session.id, { fromHistory: true });
  return true;
}

function goToCheck() {
  unlockAudio(); // must happen inside the click so Safari allows audio
  // Ask to keep recordings safe now, not during a timed question (Firefox shows a prompt).
  db.requestPersist();
  showScreen('check');
  enterCheck();
}

function backToCheck() {
  showScreen('check');
  enterCheck();
}

function beginPractice() {
  const coded = state.resume?.settings || (state.setup.coded && { prep: state.setup.coded.thinkSec });
  startPractice({
    prep: Math.min(coded ? coded.prep : state.setup.prep || 20, 30),
    answer: 60,
    speak: coded ? false : state.setup.speak,
    onStartReal: async (choice) => {
      if (choice !== 'interview' || !(await beginInterview())) backToCheck();
    },
  });
}

let starting = false;

/** Resolves true once an interview is running (or finished elsewhere and shown). */
async function beginInterview() {
  if (starting) return false; // a second click while the first one is still starting
  starting = true;
  try {
    if (state.resume) return await continueInterview();
    if (state.setup.coded) return await beginCodedInterview();
    return await beginRegularInterview();
  } finally {
    starting = false;
  }
}

async function beginRegularInterview() {
  const s = state.setup;
  let built;
  try {
    built = buildInterview({
      userQuestions: s.questions.map((q) => ({ text: q.text, prep: q.prep ?? s.prep, answer: q.answer ?? s.answer })),
      // What the fields show is what the interview uses: company, role and role
      // type come from the form (they were filled in from the posting).
      analysis: state.analysis ? { ...state.analysis, company: '', role: '' } : null,
      company: s.company,
      role: s.role,
      family: s.family || 'general',
      likelyCount: likelyCount(s),
      includeCurveball: s.curveball,
      defaults: { prep: s.prep, answer: s.answer },
      seed: randomSeed(),
    });
  } catch (err) {
    console.error(err);
    toast('Something went wrong building your questions. Try removing any unusual characters.');
    return false;
  }
  if (!built?.questions?.length) {
    toast('Add at least one question to start.');
    return false;
  }
  const now = Date.now();
  const session = {
    id: uid('s'),
    createdAt: now,
    updatedAt: now,
    status: 'in_progress',
    company: s.company || '',
    role: s.role || '',
    family: built.family,
    familyLabel: built.familyLabel,
    settings: { prep: s.prep, answer: s.answer, retakes: s.retakes, speak: s.speak },
    questions: built.questions,
    answers: {},
    audioOnly: state.media.audioOnly,
  };
  await db.saveSession(session).catch(() => {});
  return startInterview(session, { onFinish });
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = randomSeed() % (i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** An interview from a code: its questions, times and retake rule, nothing added. */
async function beginCodedInterview() {
  const c = state.setup.coded;
  // The same code may have been started already (another tab, or before a reload).
  const sessions = await db.listSessions().catch(() => []);
  const existing = sessions.find((x) => x.coded && x.codeId === c.id && x.status !== 'complete') || sessions.find((x) => x.coded && x.codeId === c.id);
  if (existing) {
    if (existing.status === 'complete') {
      state.setup.coded = null;
      saveSetup();
      toast('You’ve already taken this interview. Ask for a new code to practice again.', 6000);
      goToSetup();
      return true;
    }
    const started = await startInterview(existing, { onFinish });
    if (started) {
      // Kept while another tab has it open, so Start can be tried again.
      state.setup.coded = null;
      saveSetup();
    }
    return started;
  }
  if (codeWasUsed(c.id)) {
    // Its interview was deleted: to practice again, the person who made it sends a new code.
    state.setup.coded = null;
    saveSetup();
    toast('This code was already used. Ask for a new code to practice again.', 6000);
    goToSetup();
    return true;
  }
  const questions = c.questions.map((q, i) => ({
    id: `q${i + 1}`,
    text: q.text,
    prep: c.thinkSec,
    answer: c.answerSec,
    source: 'coded',
    targetSec: q.targetSec || null,
  }));
  // Shuffled once and saved, so a resumed interview keeps the same order.
  if (c.order === 'random') shuffle(questions);
  const now = Date.now();
  const session = {
    id: uid('s'),
    createdAt: now,
    updatedAt: now,
    status: 'in_progress',
    coded: true,
    codeId: c.id,
    name: c.name,
    company: '',
    role: '',
    family: 'general',
    familyLabel: '',
    // retakes: -1 means as many as you like; 0 means one take.
    settings: { prep: c.thinkSec, answer: c.answerSec, retakes: c.retakes ? -1 : 0, speak: false },
    questions,
    answers: {},
    audioOnly: state.media.audioOnly,
  };
  const stored = await db.saveSession(session).then(
    () => true,
    () => false,
  );
  // Only when the interview survives a reload; otherwise the code would be locked out with nothing to resume.
  if (stored && (await db.isPersistent())) markCodeUsed(c.id);
  state.setup.coded = null;
  saveSetup();
  return startInterview(session, { onFinish });
}

async function continueInterview() {
  const saved = state.resume;
  // Read it again in case another tab moved it on (or deleted it).
  let session;
  try {
    session = await db.getSession(saved.id);
  } catch {
    session = saved; // the database hiccuped: carry on with the copy we have
  }
  if (!session) {
    toast('That interview was deleted.');
    goToSetup();
    return true;
  }
  if (session.status === 'complete') {
    state.resume = null;
    toast('This interview is already complete.');
    showReview(session.id);
    return true;
  }
  if (await closeIfAllAnswered(session)) {
    state.resume = null;
    return true;
  }
  const started = await startInterview(session, { onFinish });
  if (started) state.resume = null; // kept if another tab has it open, so Start can be tried again
  return started;
}

function init() {
  wireDialogs();
  initSetup({ onContinue: goToCheck, onOpenSession: (id) => showReview(id, { fromHistory: true }), onResumeSession: resumeSession });
  initLibrary();
  initCheck({ onStartInterview: beginInterview, onPractice: beginPractice, onBack: goToSetup });
  initReview({ onPracticeAgain: goToCheck, onEdit: goToSetup, onDeleted: goToSetup, onResume: resumeSession });
  onLeave('check', leaveCheck);
  onLeave('review', leaveReview);
  // Leaving the interview screen any way other than back to the camera check turns the camera off.
  onLeave('interview', (next) => {
    if (next !== 'check' && !isRunning()) {
      stopStream(state.media.stream);
      state.media.stream = null;
    }
  });

  $('#brand').addEventListener('click', async () => {
    if (currentScreen() === 'interview' && isRunning()) {
      await requestLeave();
      return;
    }
    goToSetup();
  });
  $('#btn-leave').addEventListener('click', () => requestLeave());

  // Escape closes dialogs natively; it should never end an interview.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentScreen() === 'interview') e.stopPropagation();
  });
}

init();
