// Interview codes ("HV1-…") made by the Interview Setter. The code is the
// interview as JSON, compressed, scrambled with a fixed key and Base64url
// encoded, with a checksum so a cut-off code is caught. It hides the
// questions from a glance; it is not encryption. The same format is read by
// the Practice Studio page, so keep the two in step.

const CODE_PREFIX = 'HV1-';
const SCRAMBLE_KEY = new TextEncoder().encode('oncue-practice-interview-v1');

export function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** XOR with a position-dependent key; running it twice gives the input back. */
function scramble(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] ^ SCRAMBLE_KEY[i % SCRAMBLE_KEY.length] ^ ((i * 151 + 7) & 0xff);
  return out;
}

function toBase64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function pipe(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Makes a code (the Setter's job; used here by the tests). */
export async function encodeCode(interview) {
  const json = new TextEncoder().encode(JSON.stringify(interview));
  let body = json;
  let flag = 0;
  if (typeof CompressionStream === 'function') {
    try {
      const packed = await pipe(json, new CompressionStream('deflate-raw'));
      if (packed.length < json.length) {
        body = packed;
        flag = 1;
      }
    } catch {
      /* keep it uncompressed */
    }
  }
  const sum = fnv1a(body);
  const raw = new Uint8Array(1 + body.length + 4);
  raw[0] = flag;
  raw.set(body, 1);
  raw[raw.length - 4] = (sum >>> 24) & 0xff;
  raw[raw.length - 3] = (sum >>> 16) & 0xff;
  raw[raw.length - 2] = (sum >>> 8) & 0xff;
  raw[raw.length - 1] = sum & 0xff;
  return CODE_PREFIX + toBase64url(scramble(raw));
}

const INCOMPLETE = 'This code is incomplete or was changed. Copy the whole code from the message and paste it again.';

/**
 * Reads a code. Resolves { ok: true, interview } or { ok: false, message }.
 * interview: { id, name, createdAt, thinkSec, answerSec, retakes, order, questions: [{ text, targetSec }] }
 * `id` is stable for a given code, so the same code can be recognized later.
 */
export async function decodeCode(input) {
  const fail = (message) => ({ ok: false, message });
  const cleaned = String(input || '').replace(/\s+/g, '');
  if (!cleaned) return fail('Paste the interview code first.');
  if (!/^HV1-/i.test(cleaned)) return fail('That doesn’t look like an interview code. Codes start with HV1-.');
  const bytes = fromBase64url(cleaned.slice(CODE_PREFIX.length));
  if (!bytes || bytes.length < 8) return fail(INCOMPLETE);
  const raw = scramble(bytes);
  const flag = raw[0];
  const body = raw.subarray(1, raw.length - 4);
  const t = raw.length;
  const sum = ((raw[t - 4] << 24) | (raw[t - 3] << 16) | (raw[t - 2] << 8) | raw[t - 1]) >>> 0;
  if ((flag !== 0 && flag !== 1) || fnv1a(body) !== sum) return fail(INCOMPLETE);
  let json = body;
  if (flag === 1) {
    if (typeof DecompressionStream !== 'function') return fail('This browser can’t open interview codes. Update Chrome or Safari, then try again.');
    try {
      json = await pipe(body, new DecompressionStream('deflate-raw'));
    } catch {
      return fail(INCOMPLETE);
    }
  }
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(json));
  } catch {
    return fail(INCOMPLETE);
  }
  const int = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!data || data.v !== 1) return fail('This code was made by a different version of the Interview Setter.');
  if (!Array.isArray(data.questions) || !data.questions.length || data.questions.length > 60) return fail(INCOMPLETE);
  const questions = [];
  for (const q of data.questions) {
    const text = typeof q?.text === 'string' ? q.text.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    if (!text) return fail(INCOMPLETE);
    const targetSec = Number.isFinite(q.targetSec) && q.targetSec > 0 ? Math.round(q.targetSec) : null;
    questions.push({ text, targetSec });
  }
  if (!int(data.thinkSec, 0, 120) || !int(data.answerSec, 30, 300)) return fail(INCOMPLETE);
  if (data.order !== 'random' && data.order !== 'shown') return fail(INCOMPLETE);
  return {
    ok: true,
    interview: {
      id: `iv-${sum.toString(16).padStart(8, '0')}`,
      name: (typeof data.name === 'string' && data.name.trim().slice(0, 80)) || 'Practice interview',
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
      thinkSec: data.thinkSec,
      answerSec: data.answerSec,
      retakes: data.retakes === true,
      order: data.order,
      questions,
    },
  };
}

/** Spoken-time verdict for the review screen: within 10 s is on target. */
export function targetVerdict(spokeSec, targetSec) {
  if (!targetSec) return null;
  const diff = Math.round(spokeSec - targetSec);
  if (diff > 20) return { tone: 'bad', words: `${diff} sec over target` };
  if (diff > 10) return { tone: 'warn', words: `${diff} sec over target` };
  if (diff >= -10) return { tone: 'ok', words: diff === 0 ? 'On target' : diff > 0 ? `${diff} sec over target` : `${-diff} sec under target` };
  return { tone: 'neutral', words: `${-diff} sec under target` };
}
