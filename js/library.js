// "Browse examples" dialog: common questions grouped by type, including
// questions candidates report from Goldman Sachs HireVue interviews.
import { $, el } from './util.js';
import { libraryFor } from './engine.js';
import { GOLDMAN_FORMAT } from './bank-goldman.js';
import { addQuestions, hasQuestion, currentContext } from './setup.js';

let groups = [];
let activeGroup = '';

export function initLibrary() {
  $('#btn-examples').addEventListener('click', openLibrary);
}

function openLibrary() {
  try {
    groups = libraryFor(currentContext()).filter((g) => g.questions?.length);
  } catch (err) {
    console.error(err);
    groups = [];
  }
  if (!groups.some((g) => g.id === activeGroup)) activeGroup = groups[0]?.id || '';
  render();
  $('#dlg-examples').showModal();
}

function render() {
  renderTabs();
  renderList();
}

function renderTabs() {
  $('#lib-tabs').replaceChildren(
    ...groups.map((g) =>
      el(
        'button',
        {
          class: 'chip',
          type: 'button',
          dataset: { group: g.id },
          'aria-pressed': String(g.id === activeGroup),
          onclick: () => {
            activeGroup = g.id;
            // Update the chips in place so keyboard focus stays on the one you picked.
            document.querySelectorAll('#lib-tabs .chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.group === activeGroup)));
            renderList();
          },
        },
        g.title,
      ),
    ),
  );
}

function addedLabel() {
  return el('button', { class: 'btn sm', type: 'button', 'aria-disabled': 'true', tabindex: '-1' }, 'Added');
}

function renderList() {
  const group = groups.find((g) => g.id === activeGroup);
  let note = group?.note || '';
  if (group?.id === 'goldman' && GOLDMAN_FORMAT?.summary) note = `${note} ${GOLDMAN_FORMAT.summary}`.trim();
  $('#lib-note').textContent = note;
  $('#lib-note').hidden = !note;
  const list = $('#lib-list');
  if (!group) {
    list.replaceChildren(el('li', {}, 'No examples available.'));
    return;
  }
  list.replaceChildren(
    ...group.questions.map((q) => {
      const action = hasQuestion(q.text)
        ? addedLabel()
        : el(
            'button',
            {
              class: 'btn sm',
              type: 'button',
              'aria-label': `Add: ${q.text}`,
              onclick: (e) => {
                const btn = e.currentTarget;
                if (addQuestions([q.text]) === 0) return; // full, or already there (a message explains)
                // Move focus to the next Add button so keyboard users keep their place.
                const next = [...list.querySelectorAll('button:not([aria-disabled])')].find((b) => b !== btn && b.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_PRECEDING);
                btn.replaceWith(addedLabel());
                (next || $('#dlg-examples [data-close].btn'))?.focus();
              },
            },
            'Add',
          );
      return el('li', {}, el('span', { class: 'lib-q' }, q.text), action);
    }),
  );
}
