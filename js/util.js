// Small DOM and formatting helpers shared by every screen.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Create an element. `attrs` keys: class, text, html is NOT supported on purpose
 * (all user text goes in through textContent), on<Event> handlers, dataset, and
 * anything else becomes an attribute (booleans toggle the attribute).
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 75 -> "1:15" */
export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** 75 -> "1 min 15 sec", 40 -> "40 sec", 120 -> "2 min" */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r} sec`;
  if (r === 0) return `${m} min`;
  return `${m} min ${r} sec`;
}

/** Short label for a time option: 0 -> "None", 30 -> "30 sec", 90 -> "1 min 30 sec" */
export function timeLabel(seconds) {
  if (!seconds) return 'None';
  return formatDuration(seconds);
}

export function formatDate(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
}

export function uid(prefix = 'id') {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function randomSeed() {
  if (globalThis.crypto?.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 2 ** 32);
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function slugify(text, max = 40) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'answer';
}

/** localStorage that never throws (private mode, blocked storage, full quota). */
export const prefs = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`oncue:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`oncue:${key}`, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(`oncue:${key}`);
    } catch {
      /* ignore */
    }
  },
};

/** Promise that resolves after `ms`. */
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Key for spotting the same question twice: ignores case, punctuation and
 * spacing, but keeps letters, marks, digits and symbols in every script, so
 * "C++" and "C#" (or two questions in Chinese) stay different.
 */
export function questionKey(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{S}#]+/gu, ' ')
    .trim();
}

/** 2048 -> "2 KB", 5e6 -> "4.8 MB", 3e9 -> "2.8 GB" */
export function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** A name that is safe in a downloaded file name: "Why Operations?" -> "Why Operations" */
export function fileSafe(text, max = 60) {
  const clean = String(text || '')
    .replace(/[\\/:*?"<>|#%&{}$!`=@+^~\[\];,]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return (cut.lastIndexOf(' ') > max * 0.5 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(/[.\s]+$/, '');
}

/** File extension for a recording MIME type. */
export function extensionFor(mimeType = '') {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}
