// "Make an interview code": pick the questions and rules for someone else's
// practice interview and get a code (HV1-…) to send them. They paste it into
// OnCue and see each question only when it is asked. The code is made in this
// browser. An unfinished draft is kept only in this tab (sessionStorage), so the
// person the interview is for can't open this page later and read the questions.
import { $, el, prefs, debounce, formatDuration, questionKey as norm } from './util.js';
import { libraryFor, FAMILIES } from './engine.js';
import { encodeCode, decodeCode } from './code.js';
import { toast } from './ui.js';

const MAX_QUESTIONS = 60; // the most a code can hold
const MAX_TEXT = 500; // the longest question a code can hold
const MAX_CUSTOM = 100; // questions you can keep under "Added by you"
const DRAFT_KEY = 'setterDraft';
const THINK = { min: 0, max: 120, def: 30 };
const ANSWER = { min: 30, max: 300, def: 120 };
const TARGET = { min: 5, max: 600 };
const TARGET_RULE = 'A target must be 5 to 600 seconds. Leave it empty (or 0) for no target.';

/** An example interview with a target answer time (seconds) for each question. */
const EXAMPLE_SET = [
  { text: 'Tell me about yourself.', targetSec: 70 },
  { text: 'Why are you interested in Goldman Sachs?', targetSec: 40 },
  { text: 'Why Operations?', targetSec: 40 },
  { text: 'Tell me about a time you improved a process.', targetSec: 35 },
  { text: 'Describe a time you worked on a team. What was your role, and what was the outcome?', targetSec: 30 },
  { text: 'Tell me about a time you worked with a difficult teammate.', targetSec: 35 },
  { text: 'How do you handle competing deadlines?', targetSec: 35 },
  { text: 'What matters most when you communicate in a business setting?', targetSec: 30 },
  { text: 'Why do you want to work in this city?', targetSec: 25 },
  { text: 'Tell me about a time you worked under pressure.', targetSec: 30 },
  { text: 'What would you do if a client or a senior colleague asked you to break a rule?', targetSec: 30 },
  { text: 'Which part of Operations interests you most?', targetSec: 30 },
  { text: 'Tell me about a time you failed.', targetSec: 35 },
  { text: 'How do you stay accurate when the work is repetitive?', targetSec: 30 },
  { text: 'Tell me about an experience that isn’t on your resume that prepared you for this role.', targetSec: 45 },
  { text: 'Tell me about a time you disagreed with a decision.', targetSec: 30 },
  { text: 'Tell me about a time you worked with data.', targetSec: 25 },
  { text: 'How does Operations reduce risk for a firm?', targetSec: 15 },
  { text: 'How does Goldman Sachs make money?', targetSec: 15 },
  { text: 'Describe yourself in three words.', targetSec: 10 },
  { text: 'Tell me about a time you showed leadership.', targetSec: 10 },
  { text: 'Where do you see yourself in five years?', targetSec: 10 },
  { text: 'Tell me about a recent market story that interested you.', targetSec: 15 },
  { text: 'Tell me about a time you received tough feedback.', targetSec: 30 },
];

const freshState = () => ({
  role: 'general',
  group: 'common',
  custom: [], // questions typed here: { text, targetSec }
  selected: [], // the interview, in order: { text, targetSec }
  order: 'random',
  retakes: false,
  thinkSec: THINK.def,
  answerSec: ANSWER.def,
  name: '',
});
const state = freshState();
let groups = [];
let undoList = null; // what "Clear all" removed, until the list changes some other way

// ---------- Draft (this tab only) ----------

const draft = {
  key: `oncue:${DRAFT_KEY}`,
  get() {
    try {
      const raw = sessionStorage.getItem(this.key);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  },
  set(value) {
    try {
      sessionStorage.setItem(this.key, JSON.stringify(value));
    } catch {
      /* storage blocked: the page still works */
    }
  },
  remove() {
    try {
      sessionStorage.removeItem(this.key);
    } catch {
      /* ignore */
    }
  },
};

function validTarget(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= TARGET.min && n <= TARGET.max ? n : null;
}

/**
 * Reads a target field: { ok, value }. Empty or 0 means no target. Letters
 * (which some browsers let you type into number fields) or an out-of-range
 * number are not ok.
 */
function readTarget(input) {
  if (input.validity?.badInput) return { ok: false };
  const raw = input.value.trim();
  if (raw === '' || Number(raw) === 0) return { ok: true, value: null };
  const value = validTarget(raw);
  return value === null ? { ok: false } : { ok: true, value };
}

function cleanList(list, max) {
  const seen = new Set();
  const out = [];
  for (const q of Array.isArray(list) ? list : []) {
    const text = typeof q?.text === 'string' ? q.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '';
    const key = norm(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ text, targetSec: validTarget(q.targetSec) });
    if (out.length >= max) break;
  }
  return out;
}

function loadDraft() {
  prefs.remove(DRAFT_KEY); // an older version kept the draft in localStorage, where anyone could read it later
  const d = draft.get();
  if (!d || typeof d !== 'object') return;
  state.custom = cleanList(d.custom, MAX_CUSTOM);
  state.selected = cleanList(d.selected, MAX_QUESTIONS);
  if (FAMILIES.some((f) => f.id === d.role)) state.role = d.role;
  if (typeof d.group === 'string') state.group = d.group;
  if (d.order === 'random' || d.order === 'shown') state.order = d.order;
  state.retakes = d.retakes === true;
  if (Number.isInteger(d.thinkSec) && d.thinkSec >= THINK.min && d.thinkSec <= THINK.max) state.thinkSec = d.thinkSec;
  if (Number.isInteger(d.answerSec) && d.answerSec >= ANSWER.min && d.answerSec <= ANSWER.max) state.answerSec = d.answerSec;
  if (typeof d.name === 'string') state.name = d.name.slice(0, 60);
}

function saveNow() {
  const { role, group, custom, selected, order, retakes, thinkSec, answerSec, name } = state;
  draft.set({ role, group, custom, selected, order, retakes, thinkSec, answerSec, name });
}
const saveDraft = debounce(saveNow, 250);

// ---------- Question groups ----------

function buildGroups() {
  let lib = [];
  try {
    lib = libraryFor({ family: state.role });
  } catch (err) {
    console.error(err);
  }
  const from = (id) => lib.find((g) => g.id === id);
  groups = [
    from('common'),
    from('role'),
    from('behavioral'),
    from('motivation'),
    from('curveball'),
    from('goldman'),
    {
      id: 'example',
      title: 'Goldman Sachs Operations (example)',
      note: 'An example interview with a target answer time for each question. You can change any target in step 2.',
      questions: EXAMPLE_SET,
    },
    state.custom.length ? { id: 'custom', title: 'Added by you', note: 'Questions you typed here. Delete one with ×.', questions: state.custom } : null,
  ].filter((g) => g?.questions?.length);
  if (!groups.some((g) => g.id === state.group)) state.group = groups[0]?.id || '';
}

const currentGroup = () => groups.find((g) => g.id === state.group);
const findSelected = (text) => state.selected.find((q) => norm(q.text) === norm(text));
const isSelected = (text) => Boolean(findSelected(text));

function renderGroups() {
  $('#s-groups').replaceChildren(
    ...groups.map((g) =>
      el(
        'button',
        {
          class: 'chip',
          type: 'button',
          dataset: { group: g.id },
          'aria-pressed': String(g.id === state.group),
          onclick: () => {
            state.group = g.id;
            // Update the chips in place so keyboard focus stays on the one you picked.
            document.querySelectorAll('#s-groups .chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.group === state.group)));
            renderPickList();
            saveDraft();
          },
        },
        g.title,
      ),
    ),
  );
}

/** The target a row shows: the interview's own (once ticked), else the group's suggestion. */
function shownTarget(text, fallback) {
  const picked = findSelected(text);
  return picked ? picked.targetSec : validTarget(fallback);
}

function setTargetLabel(span, seconds) {
  span.hidden = !seconds;
  span.replaceChildren(el('span', { class: 'visually-hidden' }, ', target '), seconds ? `${seconds} sec` : '');
}

function renderPickList() {
  const group = currentGroup();
  $('#s-group-note').textContent = group?.note || '';
  $('#s-group-note').hidden = !group?.note;
  const list = $('#s-pick-list');
  if (!group) {
    list.replaceChildren(el('li', { class: 'pick-empty' }, 'No questions here.'));
    return;
  }
  list.replaceChildren(
    ...group.questions.map((q) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = isSelected(q.text);
      box.addEventListener('change', () => toggle(q, box));
      const target = el('span', { class: 'pick-target' });
      setTargetLabel(target, shownTarget(q.text, q.targetSec));
      // The target sits inside the label, so screen readers hear it with the question.
      const row = [el('label', { class: 'pick-label' }, box, el('span', { class: 'pick-text' }, q.text), target)];
      if (group.id === 'custom') row.push(iconButton('#i-x', `Delete “${q.text}” from your questions`, () => removeCustom(q)));
      return el('li', { dataset: { key: norm(q.text), def: q.targetSec ?? '' } }, ...row);
    }),
  );
  updateSelectAll();
}

/** Ticks and targets again after the interview list changed elsewhere (keeps focus where it is). */
function syncChecks() {
  document.querySelectorAll('#s-pick-list li[data-key]').forEach((li) => {
    const picked = state.selected.find((q) => norm(q.text) === li.dataset.key);
    const box = li.querySelector('input[type="checkbox"]');
    if (box) box.checked = Boolean(picked);
    const target = li.querySelector('.pick-target');
    if (target) setTargetLabel(target, picked ? picked.targetSec : validTarget(li.dataset.def));
  });
  updateSelectAll();
}

function updateSelectAll() {
  const group = currentGroup();
  const btn = $('#s-select-all');
  btn.hidden = !group;
  if (!group) return;
  const all = group.questions.every((q) => isSelected(q.text));
  btn.textContent = all ? 'Unselect all in this group' : 'Select all in this group';
}

function toggle(q, box) {
  undoList = null;
  if (box.checked) {
    const picked = findSelected(q.text);
    if (picked) {
      // Already in the interview (picked in another group): give it this group's target if it has none.
      if (picked.targetSec === null) picked.targetSec = validTarget(q.targetSec);
    } else if (state.selected.length >= MAX_QUESTIONS) {
      box.checked = false;
      toast(`An interview can have up to ${MAX_QUESTIONS} questions.`);
      return;
    } else {
      state.selected.push({ text: q.text, targetSec: validTarget(q.targetSec) });
    }
  } else {
    state.selected = state.selected.filter((s) => norm(s.text) !== norm(q.text));
  }
  syncChecks();
  changed();
}

function removeCustom(q) {
  const key = norm(q.text);
  state.custom = state.custom.filter((c) => norm(c.text) !== key);
  state.selected = state.selected.filter((s) => norm(s.text) !== key);
  if (undoList) undoList = undoList.filter((s) => norm(s.text) !== key);
  buildGroups();
  renderGroups();
  renderPickList();
  changed();
  toast('Question deleted.');
  ($('#s-pick-list input[type="checkbox"]') || $('#s-add-text')).focus();
}

// ---------- The interview list ----------

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

function renderSelected() {
  const list = $('#s-selected');
  const n = state.selected.length;
  $('#s-count').textContent = n ? `${n} question${n === 1 ? '' : 's'}` : '';
  const clear = $('#s-clear');
  clear.hidden = !n && !undoList;
  clear.textContent = undoList && !n ? 'Undo clear' : 'Clear all';
  $('#s-order-random').setAttribute('aria-pressed', String(state.order === 'random'));
  $('#s-order-shown').setAttribute('aria-pressed', String(state.order === 'shown'));
  $('#s-order-hint').textContent =
    state.order === 'random' ? 'The interview shuffles these once when it starts.' : 'The interview asks them top to bottom. Use the arrows to reorder.';
  if (!n) {
    list.replaceChildren(el('li', { class: 'q-empty sel-empty' }, 'No questions yet. Tick some above, or add your own.'));
    return;
  }
  list.replaceChildren(
    ...state.selected.map((q, i) => {
      const num = i + 1;
      const target = el('input', {
        class: 'input sel-target',
        type: 'number',
        min: '0',
        max: String(TARGET.max),
        step: '5',
        inputmode: 'numeric',
        placeholder: 'None',
        'aria-label': `Target seconds for question ${num}`,
      });
      target.value = q.targetSec ?? '';
      target.addEventListener('change', () => {
        const read = readTarget(target);
        if (!read.ok) {
          toast(TARGET_RULE, 5000);
          target.value = q.targetSec ?? ''; // keep the last good value
          return;
        }
        q.targetSec = read.value;
        target.value = q.targetSec ?? '';
        // A typed question remembers its target if it is picked again later.
        const typed = state.custom.find((c) => norm(c.text) === norm(q.text));
        if (typed) typed.targetSec = q.targetSec;
        syncChecks();
        changed({ list: false });
      });
      const up = iconButton('#i-up', `Move question ${num} up`, () => move(i, -1));
      const down = iconButton('#i-down', `Move question ${num} down`, () => move(i, 1));
      const remove = iconButton('#i-x', `Remove question ${num}`, () => removeSelected(i));
      up.disabled = i === 0;
      down.disabled = i === n - 1;
      return el(
        'li',
        { class: 'q-item sel-item' },
        el('span', { class: 'q-num', 'aria-hidden': 'true' }, String(num)),
        el(
          'div',
          { class: 'q-body' },
          el('p', { class: 'sel-text' }, q.text),
          el('div', { class: 'q-times' }, el('label', {}, 'Target', target, 'sec'), el('span', { class: 'spacer' }), up, down, remove),
        ),
      );
    }),
  );
}

function move(index, delta) {
  const list = state.selected;
  const to = index + delta;
  if (to < 0 || to >= list.length) return;
  [list[index], list[to]] = [list[to], list[index]];
  changed();
  // Keep keyboard focus with the moved question: the same arrow if it still works, otherwise the other one.
  const item = document.querySelectorAll('#s-selected .sel-item')[to];
  const [up, down] = item ? item.querySelectorAll('.icon-btn') : [];
  const wanted = delta < 0 ? up : down;
  const other = delta < 0 ? down : up;
  (wanted && !wanted.disabled ? wanted : other && !other.disabled ? other : item?.querySelector('.sel-target'))?.focus();
}

function removeSelected(index) {
  undoList = null;
  state.selected.splice(index, 1);
  syncChecks();
  changed();
  const items = document.querySelectorAll('#s-selected .sel-item');
  const next = items[Math.min(index, items.length - 1)];
  (next ? next.querySelectorAll('.icon-btn')[2] : $('#s-add-text'))?.focus();
}

// ---------- Rules and summary ----------

/** Whole seconds from a number field, or null when it is empty or not a number. */
function seconds(input) {
  if (input.validity?.badInput) return null;
  const raw = input.value.trim();
  if (raw === '') return null;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? n : null;
}

function renderRules() {
  $('#s-think').value = state.thinkSec;
  $('#s-answer').value = state.answerSec;
  $('#s-name').value = state.name;
  $('#s-retake-off').setAttribute('aria-pressed', String(!state.retakes));
  $('#s-retake-on').setAttribute('aria-pressed', String(state.retakes));
}

function renderEstimate() {
  const n = state.selected.length;
  const think = seconds($('#s-think')) ?? state.thinkSec;
  const answer = seconds($('#s-answer')) ?? state.answerSec;
  const minutes = Math.max(1, Math.round((n * (Math.max(0, think) + Math.max(0, answer) + 15)) / 60));
  $('#s-estimate').textContent = n ? `${n} question${n === 1 ? '' : 's'} · about ${minutes} min` : 'No questions yet';
}

/** Something changed: an old code no longer matches, so hide it. */
function changed({ list = true } = {}) {
  if (list) renderSelected();
  renderEstimate();
  $('#s-output').hidden = true;
  $('#s-create-error').hidden = true;
  saveDraft();
}

/** Clears everything on this page, including the draft, so the questions don't stay on this computer. */
function startOver() {
  Object.assign(state, freshState());
  undoList = null;
  draft.remove();
  $('#s-role').value = state.role;
  $('#s-add-text').value = '';
  $('#s-add-target').value = '';
  showError('#s-add-error', '');
  $('#s-code').value = '';
  buildGroups();
  renderGroups();
  renderPickList();
  renderRules();
  changed();
  window.scrollTo({ top: 0 });
  $('#setter-title').focus({ preventScroll: true });
  toast('Started over. This page no longer holds any questions.');
}

// ---------- Making the code ----------

function showError(id, message) {
  const line = $(id);
  line.textContent = message;
  line.hidden = !message;
}

const siteUrl = () => new URL('./', window.location.href).href;

async function create() {
  showError('#s-create-error', '');
  const think = seconds($('#s-think'));
  const answer = seconds($('#s-answer'));
  const problems = [];
  let focus = null;
  if (!state.selected.length) {
    problems.push('Pick at least one question.');
    focus = focus || $('#s-groups .chip[aria-pressed="true"]');
  }
  if (think === null || think < THINK.min || think > THINK.max) {
    problems.push('Prep time must be 0 to 120 seconds.');
    focus = focus || $('#s-think');
  }
  if (answer === null || answer < ANSWER.min || answer > ANSWER.max) {
    problems.push('Answer limit must be 30 to 300 seconds.');
    focus = focus || $('#s-answer');
  }
  if (problems.length) {
    showError('#s-create-error', problems.join(' '));
    focus?.focus();
    return;
  }
  state.thinkSec = think;
  state.answerSec = answer;
  renderRules();
  const interview = {
    v: 1,
    name: state.name.trim() || 'Practice interview',
    createdAt: new Date().toISOString(),
    thinkSec: think,
    answerSec: answer,
    retakes: state.retakes,
    order: state.order,
    questions: state.selected.map((q) => ({ text: q.text, targetSec: q.targetSec ?? null })),
  };
  const btn = $('#s-create');
  btn.disabled = true;
  let code = '';
  try {
    code = await encodeCode(interview);
    // Read it back with the same reader OnCue uses, so a bad code is never handed out.
    const check = await decodeCode(code);
    if (!check.ok || check.interview.questions.length !== interview.questions.length) throw new Error(check.message || 'mismatch');
  } catch (err) {
    console.error(err);
    showError('#s-create-error', 'This browser could not make the code. Try a current version of Chrome, Edge, Firefox or Safari.');
    return;
  } finally {
    btn.disabled = false;
  }
  saveNow();
  showOutput(interview, code);
}

function showOutput(interview, code) {
  const { questions } = interview;
  $('#s-code').value = code;
  $('#s-copy-status').textContent = '';
  $('#s-howto').textContent = `Send the whole code. They open OnCue at ${siteUrl()}, click “Enter code” under “Got an interview code?”, and paste it.`;
  const targeted = questions.filter((q) => q.targetSec);
  const total = targeted.reduce((sum, q) => sum + q.targetSec, 0);
  const missing = questions.length - targeted.length;
  const rows = [
    ['Name', interview.name],
    ['Questions', String(questions.length)],
    ['Target answer time', targeted.length ? `${formatDuration(total)}${missing ? ` (${missing} without a target)` : ''}` : 'None set'],
    ['Prep time', interview.thinkSec ? `${formatDuration(interview.thinkSec)} per question` : 'None'],
    ['Answer limit', `${formatDuration(interview.answerSec)} per question`],
    ['Retakes', interview.retakes ? 'Allowed' : 'One take'],
    ['Order', interview.order === 'random' ? 'Random' : 'As listed'],
  ];
  $('#s-summary').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
  const out = $('#s-output');
  out.hidden = false;
  out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#s-copy').focus({ preventScroll: true });
}

/** Copies text: the clipboard API, then the older copy command, then select-and-tell. */
async function copyText(text, done) {
  const status = $('#s-copy-status');
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = done;
    return;
  } catch {
    /* try the older way */
  }
  const area = el('textarea', { class: 'visually-hidden', readonly: true, 'aria-hidden': 'true' });
  area.value = text;
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  if (ok) {
    status.textContent = done;
    return;
  }
  const box = $('#s-code');
  box.focus();
  box.select();
  status.textContent = 'Selected. Press Cmd+C (or Ctrl+C) to copy the code.';
}

// ---------- Wiring ----------

function init() {
  loadDraft();
  const roles = [...FAMILIES].sort((a, b) => (a.id === 'general' ? -1 : b.id === 'general' ? 1 : 0));
  const role = $('#s-role');
  role.replaceChildren(...roles.map((f) => el('option', { value: f.id }, f.id === 'general' ? 'Any role' : f.label)));
  role.value = state.role;
  role.addEventListener('change', () => {
    state.role = role.value;
    // Show the questions for the role just picked.
    state.group = state.role === 'general' ? 'common' : 'role';
    buildGroups();
    renderGroups();
    renderPickList();
    saveDraft();
  });

  $('#s-select-all').addEventListener('click', () => {
    const group = currentGroup();
    if (!group) return;
    let changedAny = false;
    if (group.questions.every((q) => isSelected(q.text))) {
      const keys = new Set(group.questions.map((q) => norm(q.text)));
      state.selected = state.selected.filter((s) => !keys.has(norm(s.text)));
      changedAny = true;
    } else {
      let full = false;
      for (const q of group.questions) {
        const picked = findSelected(q.text);
        if (picked) {
          // Picked earlier in another group: fill in this group's target if it has none.
          if (picked.targetSec === null && validTarget(q.targetSec) !== null) {
            picked.targetSec = validTarget(q.targetSec);
            changedAny = true;
          }
          continue;
        }
        if (state.selected.length >= MAX_QUESTIONS) {
          full = true;
          continue; // keep filling targets for the ones already in
        }
        state.selected.push({ text: q.text, targetSec: validTarget(q.targetSec) });
        changedAny = true;
      }
      if (full) toast(`An interview can have up to ${MAX_QUESTIONS} questions, so not all of this group was added.`, 5000);
    }
    if (!changedAny) return; // nothing changed, so a code already made still matches
    undoList = null;
    syncChecks();
    changed();
  });

  $('#s-clear').addEventListener('click', () => {
    if (!state.selected.length && undoList) {
      state.selected = undoList;
      undoList = null;
      toast('Questions put back.');
    } else {
      undoList = state.selected;
      state.selected = [];
      toast('Cleared. Use “Undo clear” to put them back.');
    }
    syncChecks();
    changed();
    $('#s-clear').focus();
  });

  // An error about the typed question goes away once you change it.
  for (const id of ['#s-add-text', '#s-add-target']) $(id).addEventListener('input', () => showError('#s-add-error', ''));
  $('#s-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    showError('#s-add-error', '');
    const textInput = $('#s-add-text');
    const targetInput = $('#s-add-target');
    const text = textInput.value.replace(/\s+/g, ' ').trim();
    if (!norm(text)) {
      showError('#s-add-error', 'Type the question first.');
      textInput.focus();
      return;
    }
    if (text.length > MAX_TEXT) {
      showError('#s-add-error', `A question can be up to ${MAX_TEXT} characters. This one has ${text.length}.`);
      textInput.focus();
      return;
    }
    const target = readTarget(targetInput);
    if (!target.ok) {
      showError('#s-add-error', TARGET_RULE);
      targetInput.focus();
      return;
    }
    if (isSelected(text)) {
      showError('#s-add-error', 'That question is already in this interview.');
      textInput.focus();
      return;
    }
    if (state.selected.length >= MAX_QUESTIONS) {
      showError('#s-add-error', `An interview can have up to ${MAX_QUESTIONS} questions.`);
      return;
    }
    const known = state.custom.find((c) => norm(c.text) === norm(text));
    if (!known && state.custom.length >= MAX_CUSTOM) {
      showError('#s-add-error', `You can keep up to ${MAX_CUSTOM} of your own questions. Delete one under “Added by you” first.`);
      return;
    }
    if (known) known.targetSec = target.value;
    else state.custom.push({ text, targetSec: target.value });
    state.selected.push({ text, targetSec: target.value });
    undoList = null;
    textInput.value = '';
    targetInput.value = '';
    buildGroups();
    renderGroups();
    renderPickList();
    changed();
    textInput.focus();
  });

  const setOrder = (order) => {
    state.order = order;
    changed();
  };
  $('#s-order-random').addEventListener('click', () => setOrder('random'));
  $('#s-order-shown').addEventListener('click', () => setOrder('shown'));
  const setRetakes = (on) => {
    state.retakes = on;
    renderRules();
    changed({ list: false });
  };
  $('#s-retake-off').addEventListener('click', () => setRetakes(false));
  $('#s-retake-on').addEventListener('click', () => setRetakes(true));
  for (const [id, key] of [
    ['#s-think', 'thinkSec'],
    ['#s-answer', 'answerSec'],
  ]) {
    $(id).addEventListener('input', () => {
      const n = seconds($(id));
      if (n !== null) state[key] = n;
      changed({ list: false });
    });
  }
  $('#s-name').addEventListener('input', () => {
    state.name = $('#s-name').value.slice(0, 60);
    changed({ list: false });
  });

  $('#s-create').addEventListener('click', create);
  $('#s-copy').addEventListener('click', () => copyText($('#s-code').value, 'Copied'));
  $('#s-copy-message').addEventListener('click', () => {
    const name = state.name.trim();
    const message = `Here’s a practice interview for you${name ? `: ${name}` : ''}. Open ${siteUrl()}, click “Enter code” under “Got an interview code?”, and paste this code:\n\n${$('#s-code').value}`;
    copyText(message, 'Message copied');
  });
  for (const id of ['#s-reset', '#s-reset-after']) $(id).addEventListener('click', startOver);

  // Save the last edit even when the tab is left right after it.
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });

  buildGroups();
  renderGroups();
  renderPickList();
  renderSelected();
  renderRules();
  renderEstimate();
}

init();
