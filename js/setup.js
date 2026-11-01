// Setup screen: interview code, job posting, your questions, interview settings, past sessions.
import { $, el, debounce, uid, formatDate, formatDuration, formatBytes, questionKey } from './util.js';
import {
  state,
  saveSetup,
  codeWasUsed,
  likelyCount,
  interviewEstimate,
  prepOptions,
  answerOptions,
  retakeOptions,
  LIKELY_AUTO_OPTIONS,
  LIKELY_EXTRA_OPTIONS,
  MAX_QUESTIONS,
  MAX_POSTING_CHARS,
} from './state.js';
import { fillSelect, toast, confirmDialog } from './ui.js';
import { analyzePosting, FAMILIES, lowerLabel, withArticle } from './engine.js';
import { extractPdfText, isPdf } from './posting.js';
import * as db from './storage.js';
import { forgetSession, isOpenElsewhere, withSessionLock } from './interview.js';
import { decodeCode } from './code.js';

const MAX_PDF_BYTES = 25 * 1024 * 1024;

let callbacks = {};
let postingBlob = null; // the PDF for this tab, in case saving it failed
let readToken = 0;
let viewUrl = null;

const saveSoon = debounce(saveSetup, 300);

export function initSetup({ onContinue, onOpenSession, onResumeSession }) {
  callbacks = { onContinue, onOpenSession, onResumeSession };
  const s = state.setup;

  // ----- Interview code -----
  $('#coded-title').tabIndex = -1;
  $('#btn-code-open').addEventListener('click', openCodeBox);
  $('#btn-code-cancel').addEventListener('click', () => closeCodeBox({ focus: true }));
  $('#btn-code-use').addEventListener('click', useCode);
  $('#code-input').addEventListener('keydown', (e) => {
    // A code is one line: Enter uses it instead of adding a new line.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      useCode();
    }
  });
  $('#code-input').addEventListener('input', () => showCodeError(''));
  $('#btn-code-remove').addEventListener('click', () => {
    state.setup.coded = null;
    saveSetup();
    renderMode();
    toast('Code removed. Paste it again any time.');
    $('#btn-code-open').focus();
  });

  if (s.posting?.text) {
    try {
      state.analysis = analyzePosting(s.posting.text);
    } catch (err) {
      console.error(err);
      state.analysis = null;
    }
  }

  // ----- Job posting -----
  const input = $('#posting-file');
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) handleFile(file);
  });
  const zone = $('#dropzone');
  zone.tabIndex = 0;
  zone.setAttribute('role', 'button');
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
  // Dropping a file anywhere else should not navigate away from the page.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && !$('#screen-setup').hidden && !state.setup.posting && !state.setup.coded) handleFile(file);
  });

  $('#btn-paste-open').addEventListener('click', openPasteBox);
  $('#btn-paste-cancel').addEventListener('click', () => {
    $('#paste-box').hidden = true;
  });
  $('#btn-paste-use').addEventListener('click', () => {
    const text = $('#paste-text').value.trim();
    if (text.length < 40) {
      toast('Paste a bit more of the job description first.');
      return;
    }
    $('#paste-box').hidden = true;
    $('#paste-text').value = '';
    const current = state.setup.posting;
    if (current?.kind === 'pdf' && !current.text) {
      // The PDF could not be read (scanned or locked): keep it for viewing, use the pasted text.
      readToken += 1;
      applyPosting({ ...current, text: text.slice(0, MAX_POSTING_CHARS), pastedText: true });
      return;
    }
    readToken += 1;
    postingBlob = null;
    db.deleteFile('posting').catch(() => {});
    applyPosting({ kind: 'text', name: 'Pasted job description', pages: 0, text: text.slice(0, MAX_POSTING_CHARS) });
  });
  $('#btn-posting-view').addEventListener('click', viewPosting);
  $('#btn-posting-remove').addEventListener('click', removePosting);
  $('#dlg-posting').addEventListener('close', () => {
    $('#posting-frame').removeAttribute('src');
    if (viewUrl) URL.revokeObjectURL(viewUrl);
    viewUrl = null;
  });

  // ----- Company / role / role type -----
  fillSelect($('#f-family'), [['', 'Not sure (general questions)'], ...FAMILIES.filter((f) => f.id !== 'general').map((f) => [f.id, f.label])], s.family);
  $('#f-company').value = s.company;
  $('#f-role').value = s.role;
  $('#f-company').addEventListener('input', (e) => {
    s.company = e.target.value.trim();
    s.edited.company = true;
    saveSoon();
  });
  $('#f-role').addEventListener('input', (e) => {
    s.role = e.target.value.trim();
    s.edited.role = true;
    saveSoon();
  });
  $('#f-family').addEventListener('change', (e) => {
    s.family = e.target.value;
    s.edited.family = true;
    saveSetup();
  });

  // ----- Questions -----
  $('#q-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const field = $('#q-add-input');
    const text = field.value.trim();
    if (!text) {
      field.focus();
      return;
    }
    if (addQuestions([text]) > 0) field.value = '';
    field.focus();
  });
  $('#btn-bulk').addEventListener('click', () => {
    $('#bulk-text').value = '';
    $('#dlg-bulk').showModal();
    $('#bulk-text').focus();
  });
  $('#btn-bulk-add').addEventListener('click', () => {
    const lines = parseQuestionList($('#bulk-text').value);
    const before = state.setup.questions.length;
    const added = addQuestions(lines, { quiet: true });
    $('#dlg-bulk').close();
    if (!lines.length) return;
    let msg = added === 1 ? 'Added 1 question.' : `Added ${added} questions.`;
    if (added < lines.length) {
      const full = before + added >= MAX_QUESTIONS;
      msg += full ? ` The limit is ${MAX_QUESTIONS}.` : ' Duplicates were skipped.';
    }
    toast(msg);
  });
  $('#btn-clear').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Remove all your questions?', ok: 'Remove all', danger: true });
    if (!ok) return;
    s.questions = [];
    saveSetup();
    renderQuestions();
  });

  // ----- Settings -----
  fillSelect($('#s-prep'), prepOptions(), s.prep);
  fillSelect($('#s-answer'), answerOptions(), s.answer);
  fillSelect($('#s-retakes'), retakeOptions(), s.retakes);
  $('#s-curveball').checked = s.curveball;
  $('#s-speak').checked = s.speak;
  if (!('speechSynthesis' in window)) $('#s-speak').closest('.check').hidden = true;

  $('#s-prep').addEventListener('change', (e) => {
    s.prep = Number(e.target.value);
    saveSetup();
    renderQuestions();
  });
  $('#s-answer').addEventListener('change', (e) => {
    s.answer = Number(e.target.value);
    saveSetup();
    renderQuestions();
  });
  $('#s-retakes').addEventListener('change', (e) => {
    s.retakes = Number(e.target.value);
    saveSetup();
  });
  $('#s-likely').addEventListener('change', (e) => {
    const n = Number(e.target.value);
    if (s.questions.length) s.likelyExtra = n;
    else s.likelyAuto = n;
    saveSetup();
    renderSummary();
  });
  $('#s-curveball').addEventListener('change', (e) => {
    s.curveball = e.target.checked;
    saveSetup();
    renderSummary();
  });
  $('#s-speak').addEventListener('change', (e) => {
    s.speak = e.target.checked;
    saveSetup();
  });

  $('#btn-to-check').addEventListener('click', () => {
    saveSetup();
    callbacks.onContinue?.();
  });

  renderPosting();
  renderQuestions();
  renderMode();
  refreshHistory();
  restorePostingFile();

  // Question boxes grow to fit their text; re-fit them when the width changes.
  if ('ResizeObserver' in window) {
    let lastWidth = 0;
    new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      if (width === lastWidth) return;
      lastWidth = width;
      document.querySelectorAll('#q-list .q-text').forEach(autoSize);
    }).observe($('#q-list'));
  }
}

// ---------- Interview code ----------
// Someone else picks the questions in the Interview Setter and sends a code.
// The questions stay hidden here: only the name, count and settings show.

function openCodeBox() {
  $('#code-box').hidden = false;
  $('#btn-code-open').hidden = true;
  $('#btn-code-open').setAttribute('aria-expanded', 'true');
  $('#code-input').focus();
}

function closeCodeBox({ focus = false } = {}) {
  $('#code-box').hidden = true;
  $('#btn-code-open').hidden = false;
  $('#btn-code-open').setAttribute('aria-expanded', 'false');
  $('#code-input').value = '';
  showCodeError('');
  if (focus) $('#btn-code-open').focus();
}

function showCodeError(message, action = null) {
  const line = $('#code-error');
  line.hidden = !message;
  line.replaceChildren(
    message ? el('span', {}, message) : '',
    action ? el('button', { class: 'btn sm', type: 'button', onclick: action.onClick }, action.label) : '',
  );
}

/** The saved interview made from this code, if it was started before. */
async function findCodedSession(codeId) {
  const sessions = await db.listSessions().catch(() => []);
  const matches = sessions.filter((x) => x.coded && x.codeId === codeId);
  return matches.find((x) => x.status !== 'complete') || matches[0] || null;
}

let decoding = false;
async function useCode() {
  if (decoding) return;
  decoding = true;
  const btn = $('#btn-code-use');
  btn.disabled = true;
  showCodeError('');
  try {
    const result = await decodeCode($('#code-input').value);
    if (!result.ok) {
      showCodeError(result.message);
      $('#code-input').focus();
      return;
    }
    const iv = result.interview;
    const existing = await findCodedSession(iv.id);
    if (existing?.status === 'complete') {
      showCodeError('You’ve already taken this interview. Ask for a new code to practice again.');
      return;
    }
    if (existing) {
      showCodeError('You’ve already started this interview.', {
        label: 'Resume it',
        onClick: () => {
          closeCodeBox();
          callbacks.onResumeSession?.(existing.id);
        },
      });
      return;
    }
    if (codeWasUsed(iv.id)) {
      showCodeError('This code was already used, and its interview was deleted. Ask for a new code to practice again.');
      return;
    }
    state.setup.coded = iv;
    saveSetup();
    closeCodeBox();
    renderMode();
    $('#coded-title').focus();
  } finally {
    decoding = false;
    btn.disabled = false;
  }
}

/** Shows either the coded interview or the usual posting, questions and settings. */
export function renderMode() {
  if ($('#code-error button')) closeCodeBox();
  const c = state.setup.coded;
  $('#code-entry').hidden = Boolean(c);
  $('#coded-card').hidden = !c;
  for (const id of ['#card-posting', '#card-questions', '#card-settings']) $(id).hidden = Boolean(c);
  if (c) {
    const n = c.questions.length;
    $('#coded-title').textContent = c.name;
    const facts = [
      `${n} question${n === 1 ? '' : 's'}`,
      c.thinkSec ? `${formatDuration(c.thinkSec)} to prepare` : 'No prep time',
      `Up to ${formatDuration(c.answerSec)} to answer`,
      c.retakes ? 'Retakes allowed' : 'Retakes: none',
    ];
    $('#coded-facts').replaceChildren(...facts.map((t) => el('li', {}, t)));
    const targets = c.questions.some((q) => q.targetSec);
    $('#coded-note').textContent = `You won’t see the questions until each one appears.${targets ? ' Target answer times show on the review screen afterward.' : ''}`;
  }
  renderSummary();
}

// ---------- Job posting ----------

async function restorePostingFile() {
  if (state.setup.posting?.kind !== 'pdf') return;
  try {
    const rec = await db.getFile('posting');
    if (rec?.blob) postingBlob = rec.blob;
  } catch {
    /* the extracted text is still available */
  }
}

async function handleFile(file) {
  if (!isPdf(file)) {
    toast('Please choose a PDF. For a Word file or web page, paste the text instead.');
    return;
  }
  if (file.size > MAX_PDF_BYTES) {
    toast('That PDF is larger than 25 MB. Try a smaller file, or paste the text instead.');
    return;
  }
  const token = ++readToken;
  postingBlob = file;
  state.setup.posting = { kind: 'pdf', name: file.name, pages: 0, text: '', size: file.size };
  state.analysis = null;
  renderPosting();
  setStatus('loading', 'Reading the job posting…');

  db.saveFile('posting', file, { name: file.name }).catch(() => {
    /* kept in memory for this tab */
  });

  try {
    const { text, pages } = await extractPdfText(file);
    if (token !== readToken) return;
    applyPosting({ kind: 'pdf', name: file.name, pages, size: file.size, text: text.slice(0, MAX_POSTING_CHARS) });
  } catch (err) {
    if (token !== readToken) return;
    state.setup.posting.unreadable = true;
    saveSetup();
    setStatus('warn', err?.message || 'Could not read this PDF. Paste the job description instead.', {
      label: 'Paste the text',
      onClick: openPasteBox,
    });
  }
}

function applyPosting(posting) {
  const s = state.setup;
  s.posting = posting;
  try {
    state.analysis = posting.text ? analyzePosting(posting.text) : null;
  } catch (err) {
    console.error(err);
    state.analysis = null;
  }
  const a = state.analysis;
  if (a) {
    // A new posting replaces the details it can detect. Where it finds nothing,
    // keep what you typed yourself, but clear values detected from an older posting.
    const detected = { company: a.company, role: a.role, family: a.family && a.family !== 'general' ? a.family : '' };
    for (const key of ['company', 'role', 'family']) {
      if (detected[key]) {
        s[key] = detected[key];
        s.edited[key] = false;
      } else if (!s.edited[key]) {
        s[key] = '';
      }
    }
    syncDetailFields();
  }
  saveSetup();
  renderPosting();
}

function syncDetailFields() {
  const s = state.setup;
  $('#f-company').value = s.company;
  $('#f-role').value = s.role;
  $('#f-family').value = s.family;
}

function describeAnalysis() {
  const a = state.analysis;
  const p = state.setup.posting;
  if (!p) return '';
  const parts = [];
  if (p.kind === 'pdf' && p.pastedText) parts.push('Using the text you pasted.');
  else if (p.kind === 'pdf' && p.pages) parts.push(`Read ${p.pages} page${p.pages === 1 ? '' : 's'}.`);
  else if (p.kind === 'text') parts.push('Using your pasted text.');
  if (a) {
    if (a.family && a.family !== 'general') parts.push(`Looks like ${withArticle(lowerLabel(a.familyLabel))} role.`);
    if (a.skills?.length) parts.push(`Mentions ${a.skills.slice(0, 4).join(', ')}.`);
    if (a.company || a.role) parts.push('Check the details below.');
  }
  return parts.join(' ');
}

function renderPosting() {
  const p = state.setup.posting;
  $('#posting-empty').hidden = Boolean(p);
  $('#posting-loaded').hidden = !p;
  if (!p) {
    setStatus(null);
    return;
  }
  $('#posting-name').textContent = p.name || 'Job posting';
  const meta = [];
  if (p.kind === 'pdf') {
    meta.push('PDF');
    if (p.pages) meta.push(`${p.pages} page${p.pages === 1 ? '' : 's'}`);
    if (p.size) meta.push(formatBytes(p.size));
  } else {
    meta.push('Pasted text', `${p.text.length.toLocaleString()} characters`);
  }
  $('#posting-meta').textContent = meta.join(' · ');
  if (p.text) setStatus('ok', describeAnalysis());
  else if (p.unreadable) setStatus('warn', 'We could not read text from this PDF.', { label: 'Paste the text', onClick: openPasteBox });
}

function openPasteBox() {
  $('#paste-box').hidden = false;
  $('#paste-text').focus();
}

function setStatus(kind, message = '', action = null) {
  const line = $('#posting-status');
  if (!kind || !message) {
    line.hidden = true;
    line.replaceChildren();
    return;
  }
  line.hidden = false;
  line.className = `status-line ${kind === 'warn' ? 'warn' : ''}`;
  line.replaceChildren(
    kind === 'loading' ? el('span', { class: 'spinner', 'aria-hidden': 'true' }) : '',
    el('span', { text: message }),
    action ? el('button', { class: 'link', type: 'button', onclick: action.onClick }, action.label) : '',
  );
}

async function viewPosting() {
  const p = state.setup.posting;
  if (!p) return;
  const frame = $('#posting-frame');
  const textWrap = $('#posting-text-wrap');
  $('#dlg-posting-title').textContent = p.name || 'Job posting';
  if (p.kind === 'pdf' && !postingBlob) {
    try {
      postingBlob = (await db.getFile('posting'))?.blob || null;
    } catch {
      postingBlob = null;
    }
  }
  if (p.kind === 'pdf' && postingBlob) {
    const blob = postingBlob.type === 'application/pdf' ? postingBlob : new Blob([postingBlob], { type: 'application/pdf' });
    viewUrl = URL.createObjectURL(blob);
    frame.src = viewUrl;
    frame.hidden = false;
    textWrap.hidden = true;
  } else {
    $('#posting-text').textContent = p.text || 'No text was found in this posting.';
    frame.hidden = true;
    textWrap.hidden = false;
  }
  $('#dlg-posting').showModal();
}

function removePosting() {
  readToken += 1;
  const s = state.setup;
  s.posting = null;
  state.analysis = null;
  postingBlob = null;
  // Details detected from this posting go with it; anything you typed stays.
  for (const key of ['company', 'role', 'family']) if (!s.edited[key]) s[key] = '';
  syncDetailFields();
  db.deleteFile('posting').catch(() => {});
  saveSetup();
  renderPosting();
  toast('Job posting removed.');
}

// ---------- Questions ----------

const norm = questionKey;

/** Strip numbering and bullets: "1. Tell me…", "Q2) Why…", "- Why…" */
export function parseQuestionList(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:q(?:uestion)?\s*)?(?:\d{1,2}\s*[.):\-]|[-*•·–—]|\(\d{1,2}\))\s*/i, '').trim())
    .filter((line) => line.length > 2);
}

/** Adds questions, skipping duplicates. Returns how many were added. */
export function addQuestions(texts, { quiet = false } = {}) {
  const s = state.setup;
  const hadNone = s.questions.length === 0;
  const existing = new Set(s.questions.map((q) => norm(q.text)));
  let added = 0;
  for (const raw of texts) {
    const text = String(raw).replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!text) continue;
    if (s.questions.length >= MAX_QUESTIONS) {
      if (!quiet) toast(`You can add up to ${MAX_QUESTIONS} questions.`);
      break;
    }
    const key = norm(text);
    if (existing.has(key)) continue;
    existing.add(key);
    s.questions.push({ id: uid('q'), text, prep: null, answer: null });
    added += 1;
  }
  if (added) {
    saveSetup();
    renderQuestions();
    if (hadNone && !quiet) {
      toast('Your own questions are asked now instead of the automatic ones. You can still add likely questions under Interview settings.', 6000);
    }
  } else if (!quiet && texts.length === 1 && s.questions.length < MAX_QUESTIONS) {
    toast('That question is already on your list.');
  }
  return added;
}

export function hasQuestion(text) {
  const key = norm(text);
  return state.setup.questions.some((q) => norm(q.text) === key);
}

function autoSize(area) {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight + 2}px`;
}

function renderQuestions() {
  const s = state.setup;
  const list = $('#q-list');
  list.replaceChildren(
    ...s.questions.map((q, i) => {
      const n = i + 1;
      const area = el('textarea', { class: 'q-text', rows: '1', 'aria-label': `Question ${n}`, maxlength: '400' });
      area.value = q.text;
      area.addEventListener('input', () => {
        q.text = area.value.replace(/\s+/g, ' ');
        autoSize(area);
        saveSoon();
      });
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          area.blur();
        }
      });
      area.addEventListener('blur', () => {
        q.text = area.value.replace(/\s+/g, ' ').trim();
        if (!q.text) removeQuestion(q.id);
        else saveSetup();
      });

      const prep = el('select', { class: 'select sm', 'aria-label': `Prep time for question ${n}` });
      fillSelect(prep, prepOptions(true, s.prep), q.prep ?? '');
      prep.addEventListener('change', () => {
        q.prep = prep.value === '' ? null : Number(prep.value);
        saveSetup();
        renderSummary();
      });
      const answer = el('select', { class: 'select sm', 'aria-label': `Answer time for question ${n}` });
      fillSelect(answer, answerOptions(true, s.answer), q.answer ?? '');
      answer.addEventListener('change', () => {
        q.answer = answer.value === '' ? null : Number(answer.value);
        saveSetup();
        renderSummary();
      });

      const up = iconButton('#i-up', `Move question ${n} up`, () => moveQuestion(i, -1));
      const down = iconButton('#i-down', `Move question ${n} down`, () => moveQuestion(i, 1));
      const remove = iconButton('#i-x', `Remove question ${n}`, () => removeQuestion(q.id));
      up.disabled = i === 0;
      down.disabled = i === s.questions.length - 1;

      const item = el(
        'li',
        { class: 'q-item', dataset: { id: q.id } },
        el('span', { class: 'q-num', 'aria-hidden': 'true' }, String(n)),
        el('div', { class: 'q-body' }, area, el('div', { class: 'q-times' }, prep, answer, el('span', { class: 'spacer' }), up, down, remove)),
      );
      requestAnimationFrame(() => autoSize(area));
      return item;
    }),
  );
  $('#q-empty').hidden = s.questions.length > 0;
  $('#btn-clear').hidden = s.questions.length < 2;
  renderLikely();
  renderSummary();
}

function iconButton(icon, label, onClick) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svgNS, 'use');
  use.setAttribute('href', icon);
  svg.append(use);
  const btn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, onclick: onClick });
  btn.append(svg);
  return btn;
}

function moveQuestion(index, delta) {
  const list = state.setup.questions;
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  saveSetup();
  renderQuestions();
  // Keep keyboard focus with the moved question: same arrow if it still works, otherwise the other one.
  const item = document.querySelectorAll('#q-list .q-item')[target];
  const [up, down] = item ? item.querySelectorAll('.icon-btn') : [];
  const wanted = delta < 0 ? up : down;
  const other = delta < 0 ? down : up;
  (wanted && !wanted.disabled ? wanted : other && !other.disabled ? other : item?.querySelector('.q-text'))?.focus();
}

function removeQuestion(id) {
  const s = state.setup;
  const index = s.questions.findIndex((q) => q.id === id);
  if (index === -1) return;
  const hadFocus = document.activeElement?.closest?.('#q-list');
  s.questions.splice(index, 1);
  saveSetup();
  renderQuestions();
  if (hadFocus) {
    const items = document.querySelectorAll('#q-list .q-text');
    (items[Math.min(index, items.length - 1)] || $('#q-add-input')).focus();
  }
}

function renderLikely() {
  const s = state.setup;
  const own = s.questions.length > 0;
  $('#likely-label').textContent = own ? 'Also add likely questions' : 'Likely questions to ask';
  const source = s.posting ? 'the job posting and the most common interview questions' : 'the role type and the most common interview questions';
  $('#likely-hint').textContent = own
    ? `Mixed in with your questions (an opener like “Tell me about yourself” may come first). Picked from ${source}. You won’t see them in advance.`
    : `Picked from ${source}. You won’t see them in advance.`;
  const options = (own ? LIKELY_EXTRA_OPTIONS : LIKELY_AUTO_OPTIONS).map((n) => [n, n === 0 ? 'None' : String(n)]);
  fillSelect($('#s-likely'), options, own ? s.likelyExtra : s.likelyAuto);
}

function renderSummary() {
  const s = state.setup;
  const { count, minutes } = interviewEstimate(s);
  let text = `${count} question${count === 1 ? '' : 's'} · about ${minutes} min`;
  if (!s.coded) {
    const hidden = likelyCount(s) + (s.curveball ? 1 : 0);
    if (hidden && s.questions.length) text += ` · ${hidden} you won’t see in advance`;
  }
  $('#setup-summary').textContent = text;
}

// ---------- Past sessions ----------

export async function refreshHistory() {
  let sessions = [];
  try {
    sessions = await db.listSessions();
  } catch {
    sessions = [];
  }
  const persistent = await db.isPersistent().catch(() => false);
  $('#history-note').textContent = persistent
    ? 'Saved only in this browser.'
    : 'Private browsing: recordings are kept only until you close this tab.';
  const list = $('#history-list');
  // Coded interviews that are still open show even before the first answer, so they can be resumed.
  const resumable = (s) => Boolean(s.coded) && s.status !== 'complete';
  const shown = sessions.filter((s) => Object.keys(s.answers || {}).length > 0 || resumable(s)).slice(0, 20);
  $('#history').hidden = shown.length === 0;
  list.replaceChildren(
    ...shown.map((session) => {
      const total = session.questions?.length || 0;
      const kept = Object.values(session.answers || {}).filter((a) => a && !a.deleted && !a.skipped);
      const answered = kept.length;
      const seconds = kept.reduce((sum, a) => sum + (a.duration || 0), 0);
      const title = session.coded
        ? session.name || 'Practice interview'
        : [session.role || 'Practice interview', session.company].filter(Boolean).join(' · ');
      const meta = [formatDate(session.createdAt)];
      if (session.coded) meta.push(session.status === 'complete' ? 'Completed' : 'In progress');
      meta.push(`${answered} of ${total} answered`);
      if (kept.length) meta.push(formatDuration(seconds));
      const del = iconButton('#i-trash', 'Delete this session', async () => {
        if (await isOpenElsewhere(session.id)) {
          toast('This interview is open in another tab. Finish or leave it there first.');
          return;
        }
        const ok = await confirmDialog({
          title: 'Delete this practice session?',
          text: 'Its recordings will be removed from this browser.',
          ok: 'Delete',
          danger: true,
        });
        if (!ok) return;
        const index = [...$('#history-list').children].indexOf(del.closest('li'));
        try {
          // Held while deleting, so no tab can start this interview halfway through.
          const outcome = await withSessionLock(session.id, () => db.deleteSession(session.id));
          if (outcome.ok) forgetSession(session.id);
          else toast('This interview is open in another tab. Finish or leave it there first.');
        } catch {
          toast('This browser could not delete the session. Try again in a moment.');
        }
        await refreshHistory();
        // Keep keyboard focus nearby: the row that took its place, the one before it, or the page heading.
        const rows = $('#history-list').children;
        const row = $('#history').hidden ? null : rows[Math.min(Math.max(0, index), rows.length - 1)];
        (row?.querySelector('button') || $('#setup-title')).focus();
      });
      return el(
        'li',
        {},
        el(
          'div',
          { style: 'flex:1;min-width:0' },
          el('div', { class: 'history-title' }, title),
          el('div', { class: 'history-meta' }, meta.join(' · ')),
        ),
        resumable(session)
          ? el('button', { class: 'btn sm primary', type: 'button', onclick: () => callbacks.onResumeSession?.(session.id) }, 'Resume')
          : null,
        answered || !resumable(session)
          ? el('button', { class: 'btn sm', type: 'button', onclick: () => callbacks.onOpenSession?.(session.id) }, 'Watch')
          : null,
        del,
      );
    }),
  );
}

/** Current role context for the example library. */
export function currentContext() {
  const s = state.setup;
  return {
    family: s.family || 'general',
    company: s.company,
    role: s.role,
  };
}

export { renderQuestions };
