// Screen switching, toasts and the confirm dialog.
import { $ } from './util.js';

const SCREENS = ['setup', 'check', 'interview', 'review'];
const leaveHandlers = new Map();
let current = 'setup';

/** Register cleanup to run when a screen is left (stop timers, release URLs). */
export function onLeave(screen, fn) {
  leaveHandlers.set(screen, fn);
}

export function currentScreen() {
  return current;
}

export function showScreen(name) {
  if (current !== name) {
    try {
      leaveHandlers.get(current)?.(name);
    } catch (err) {
      console.error(err);
    }
  }
  for (const s of SCREENS) $(`#screen-${s}`).hidden = s !== name;
  current = name;
  const inInterview = name === 'interview';
  document.body.classList.toggle('in-interview', inInterview);
  $('#topbar-progress').hidden = !inInterview;
  $('#btn-leave').hidden = !inInterview;
  window.scrollTo({ top: 0 });
  // Move keyboard and screen-reader focus to the new screen's heading.
  const heading = name === 'interview' ? $('#iv-question') : $(`#screen-${name} h1`);
  heading?.focus({ preventScroll: true });
}

let toastTimer = 0;
export function toast(message, ms = 3800) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

/** Resolves true if the person confirms. */
export function confirmDialog({ title, text = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  const dlg = $('#dlg-confirm');
  $('#dlg-confirm-title').textContent = title;
  $('#dlg-confirm-text').textContent = text;
  $('#dlg-confirm-text').hidden = !text;
  const okBtn = $('#dlg-confirm-ok');
  const cancelBtn = $('#dlg-confirm-cancel');
  okBtn.textContent = ok;
  cancelBtn.textContent = cancel;
  okBtn.className = `btn ${danger ? 'danger' : 'primary'}`;
  return new Promise((resolve) => {
    const done = (value) => {
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(value);
    };
    okBtn.onclick = () => done(true);
    cancelBtn.onclick = () => done(false);
    dlg.onclose = () => done(false);
    dlg.showModal();
    cancelBtn.focus();
  });
}

/** Close buttons and click-outside for every <dialog>. */
export function wireDialogs() {
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) {
        dlg.close();
        return;
      }
      // A click on the backdrop lands on the dialog element itself.
      if (e.target === dlg && dlg.id !== 'dlg-confirm') {
        const r = dlg.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) dlg.close();
      }
    });
  });
}

/** Fill a <select> with [value, label] pairs and pick `selected`. */
export function fillSelect(select, options, selected) {
  select.replaceChildren(
    ...options.map(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = String(value);
      opt.textContent = label;
      return opt;
    }),
  );
  select.value = String(selected);
  if (select.value !== String(selected) && options.length) select.value = String(options[0][0]);
}
