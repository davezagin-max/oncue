// App state that survives a reload (saved in localStorage via prefs).
import { prefs, uid, timeLabel } from './util.js';

export const PREP_OPTIONS = [0, 15, 30, 45, 60, 90, 120, 180];
export const ANSWER_OPTIONS = [30, 45, 60, 90, 120, 180, 240, 300];
export const RETAKE_OPTIONS = [0, 1, 2, 3];
export const LIKELY_AUTO_OPTIONS = [3, 4, 5, 6, 7, 8];
export const LIKELY_EXTRA_OPTIONS = [0, 1, 2, 3, 4, 5];
export const MAX_QUESTIONS = 25;
export const MAX_POSTING_CHARS = 60_000;

const DEFAULT_SETUP = {
  company: '',
  role: '',
  family: '',
  // Fields the person typed themselves are never overwritten by detection.
  edited: { company: false, role: false, family: false },
  questions: [], // { id, text, prep: number|null, answer: number|null } (null = use the default)
  prep: 30,
  answer: 120,
  retakes: 1,
  likelyAuto: 5, // used when there are no questions of your own
  likelyExtra: 0, // added on top of your own questions
  curveball: true,
  speak: false,
  posting: null, // { kind: 'pdf' | 'text', name, pages, text }
  // An interview from a code (HV1-…). While set, it replaces the questions and settings above.
  coded: null, // { id, name, createdAt, thinkSec, answerSec, retakes, order, questions: [{ text, targetSec }] }
};

function loadSetup() {
  const saved = prefs.get('setup', null);
  const setup = { ...structuredCloneSafe(DEFAULT_SETUP), ...(saved && typeof saved === 'object' ? saved : {}) };
  setup.edited = { ...DEFAULT_SETUP.edited, ...(setup.edited || {}) };
  setup.questions = Array.isArray(setup.questions)
    ? setup.questions
        .filter((q) => q && typeof q.text === 'string' && q.text.trim())
        .slice(0, MAX_QUESTIONS)
        .map((q) => ({
          id: q.id || uid('q'),
          text: q.text,
          prep: PREP_OPTIONS.includes(q.prep) ? q.prep : null,
          answer: ANSWER_OPTIONS.includes(q.answer) ? q.answer : null,
        }))
    : [];
  if (!PREP_OPTIONS.includes(setup.prep)) setup.prep = DEFAULT_SETUP.prep;
  if (!ANSWER_OPTIONS.includes(setup.answer)) setup.answer = DEFAULT_SETUP.answer;
  if (!RETAKE_OPTIONS.includes(setup.retakes)) setup.retakes = DEFAULT_SETUP.retakes;
  if (!LIKELY_AUTO_OPTIONS.includes(setup.likelyAuto)) setup.likelyAuto = DEFAULT_SETUP.likelyAuto;
  if (!LIKELY_EXTRA_OPTIONS.includes(setup.likelyExtra)) setup.likelyExtra = DEFAULT_SETUP.likelyExtra;
  if (setup.posting && typeof setup.posting.text !== 'string') setup.posting = null;
  if (!validCoded(setup.coded)) setup.coded = null;
  return setup;
}

function validCoded(c) {
  return Boolean(
    c && typeof c === 'object' && typeof c.id === 'string' &&
    Array.isArray(c.questions) && c.questions.length > 0 &&
    c.questions.every((q) => q && typeof q.text === 'string' && q.text) &&
    Number.isInteger(c.thinkSec) && Number.isInteger(c.answerSec),
  );
}

function structuredCloneSafe(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export const state = {
  setup: loadSetup(),
  analysis: null, // result of analyzePosting(), rebuilt from setup.posting.text
  devices: { cameraId: '', micId: '', speakerId: '', ...prefs.get('devices', {}) },
  media: { stream: null, audioOnly: false },
  resume: null, // a saved coded session to continue after the camera check
};

export function saveSetup() {
  const ok = prefs.set('setup', state.setup);
  if (!ok && state.setup.posting?.text?.length > 20_000) {
    // Storage is tight: keep everything except the long posting text.
    prefs.set('setup', { ...state.setup, posting: { ...state.setup.posting, text: state.setup.posting.text.slice(0, 20_000) } });
  }
}

/** Codes whose interview was started in this browser. A code is taken once, even after its interview is deleted. */
export function codeWasUsed(codeId) {
  const used = prefs.get('usedCodes', []);
  return Array.isArray(used) && used.includes(codeId);
}

export function markCodeUsed(codeId) {
  const used = prefs.get('usedCodes', []);
  const list = (Array.isArray(used) ? used : []).filter((x) => x !== codeId);
  list.push(codeId);
  prefs.set('usedCodes', list.slice(-200));
}

export function saveDevices() {
  prefs.set('devices', state.devices);
}

/** Number of likely questions the interview will add. */
export function likelyCount(setup = state.setup) {
  return setup.questions.length ? setup.likelyExtra : setup.likelyAuto;
}

/** Totals for the summary line under the setup form. */
export function interviewEstimate(setup = state.setup) {
  if (setup.coded) {
    const c = setup.coded;
    const seconds = c.questions.length * (c.thinkSec + c.answerSec + 15);
    return { count: c.questions.length, minutes: Math.max(1, Math.round(seconds / 60)) };
  }
  const own = setup.questions.map((q) => ({ prep: q.prep ?? setup.prep, answer: q.answer ?? setup.answer }));
  const extra = likelyCount(setup) + (setup.curveball ? 1 : 0);
  for (let i = 0; i < extra; i += 1) own.push({ prep: setup.prep, answer: setup.answer });
  const seconds = own.reduce((sum, q) => sum + q.prep + q.answer + 15, 0);
  return { count: own.length, minutes: Math.max(1, Math.round(seconds / 60)) };
}

export function prepOptions(withDefault = false, def = 30) {
  const opts = PREP_OPTIONS.map((s) => [s, s === 0 ? 'No prep time' : timeLabel(s)]);
  return withDefault ? [['', `Prep: default`], ...opts.map(([v, l]) => [v, `Prep: ${v === 0 ? 'none' : l}`])] : opts;
}

export function answerOptions(withDefault = false, def = 120) {
  const opts = ANSWER_OPTIONS.map((s) => [s, timeLabel(s)]);
  return withDefault ? [['', `Answer: default`], ...opts.map(([v, l]) => [v, `Answer: ${l}`])] : opts;
}

export function retakeOptions() {
  return RETAKE_OPTIONS.map((n) => [n, n === 0 ? 'No retakes' : n === 1 ? '1 retake' : `${n} retakes`]);
}
