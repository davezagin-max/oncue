// Interview codes: OnCue must read exactly what the Interview Setter makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCode, encodeCode, targetVerdict } from '../js/code.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Made by the Interview Setter page itself (questions 3, 1, 7 of its bank plus one typed question).
const SETTER_CODE = fs.readFileSync(path.join(here, 'fixtures', 'setter-code.txt'), 'utf8').trim();

test('reads a code made by the Interview Setter', async () => {
  const r = await decodeCode(SETTER_CODE);
  assert.equal(r.ok, true, r.message);
  const iv = r.interview;
  assert.equal(iv.name, 'Fixture interview');
  assert.equal(iv.thinkSec, 20);
  assert.equal(iv.answerSec, 90);
  assert.equal(iv.retakes, true);
  assert.equal(iv.order, 'shown');
  assert.deepEqual(iv.questions.map((q) => q.text), [
    'Why Operations?',
    'Tell me about yourself.',
    'How do you handle competing deadlines?',
    'What did you learn from your last job?',
  ]);
  assert.deepEqual(iv.questions.map((q) => q.targetSec), [40, 70, 35, null]);
  assert.match(iv.id, /^iv-[0-9a-f]{8}$/);
});

test('the code does not show the questions', () => {
  for (const word of ['Operations', 'yourself', 'deadlines', 'last job', 'Fixture']) {
    assert.ok(!SETTER_CODE.toLowerCase().includes(word.toLowerCase()), word);
  }
  assert.ok(SETTER_CODE.startsWith('HV1-'));
});

test('codes wrapped across lines still work; the same code gives the same id', async () => {
  const wrapped = SETTER_CODE.replace(/(.{30})/g, '$1\n  ');
  const a = await decodeCode(SETTER_CODE);
  const b = await decodeCode(wrapped);
  assert.equal(b.ok, true);
  assert.equal(a.interview.id, b.interview.id);
});

test('bad, cut-off and changed codes are refused with a clear message', async () => {
  const cases = [
    ['', /Paste the interview code/],
    ['hello there', /Codes start with HV1-/],
    ['HV1-', /incomplete/],
    ['HV1-abc', /incomplete/],
    [SETTER_CODE.slice(0, -10), /incomplete/],
    [SETTER_CODE.slice(0, 40) + (SETTER_CODE[40] === 'A' ? 'B' : 'A') + SETTER_CODE.slice(41), /incomplete/],
    [SETTER_CODE + '!!', /incomplete/],
  ];
  for (const [input, message] of cases) {
    const r = await decodeCode(input);
    assert.equal(r.ok, false, `accepted: ${input.slice(0, 30)}`);
    assert.match(r.message, message);
  }
});

test('round trip, including limits the Setter enforces', async () => {
  const iv = {
    v: 1, name: 'Round trip', createdAt: '2026-11-01T00:00:00.000Z', thinkSec: 0, answerSec: 300, retakes: false, order: 'random',
    questions: [{ text: 'Q one?', targetSec: 30 }, { text: 'Q two?', targetSec: null }],
  };
  const r = await decodeCode(await encodeCode(iv));
  assert.equal(r.ok, true);
  assert.equal(r.interview.thinkSec, 0);
  assert.equal(r.interview.retakes, false);
  const bad = await decodeCode(await encodeCode({ ...iv, answerSec: 20 }));
  assert.equal(bad.ok, false);
  const newer = await decodeCode(await encodeCode({ ...iv, v: 2 }));
  assert.match(newer.message, /different version/);
});

test('target verdicts', () => {
  assert.equal(targetVerdict(45, 40).tone, 'ok');
  assert.equal(targetVerdict(45, 40).words, '5 sec over target');
  assert.equal(targetVerdict(55, 40).tone, 'warn');
  assert.equal(targetVerdict(61, 40).tone, 'bad');
  assert.equal(targetVerdict(20, 40).tone, 'neutral');
  assert.equal(targetVerdict(40, 40).words, 'On target');
  assert.equal(targetVerdict(40, null), null);
});
