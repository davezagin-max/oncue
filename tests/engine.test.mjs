// Tests for the question engine. Run with: npm test  (or node --test tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzePosting,
  buildInterview,
  libraryFor,
  similarity,
  fillTemplate,
  classifyQuestion,
  FAMILIES,
  CATEGORIES,
} from '../js/engine.js';
import { ROLE_FAMILIES, COMPETENCIES, INDUSTRIES, UNIVERSAL } from '../js/bank.js';
import { GOLDMAN_REPORTED } from '../js/bank-goldman.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');

const EXPECTED = {
  'gs-data-analyst.txt': { family: 'data', company: 'Goldman Sachs', role: /data engineering/i },
  'gs-engineering-analyst.txt': { family: 'software', company: 'Goldman Sachs', role: /engineering analyst/i },
  'it-audit-analyst.txt': { family: 'risk_compliance', company: 'Kestrel & Lowe', role: /it audit/i },
  'ib-summer-analyst.txt': { family: 'investment_banking', company: 'Harborview Partners', role: /summer analyst/i },
  'registered-nurse.txt': { family: 'healthcare', company: 'Canyon View Hospital', role: /registered nurse/i },
  'teacher.txt': { family: 'education', company: 'Granite Peak School District', role: /teacher/i },
  'marketing-coordinator.txt': { family: 'marketing', company: 'Trailhead Outfitters', role: /marketing coordinator/i },
  'sales-development-rep.txt': { family: 'sales', company: 'Lumen Freight Software', role: /sales development/i },
  'supply-chain-analyst.txt': { family: 'operations', company: 'Bonneville Foods', role: /supply chain analyst/i },
  'consulting-business-analyst.txt': { family: 'consulting', company: 'Sterling Ridge Consulting', role: /business analyst/i },
  'barista.txt': { family: 'customer_service', company: 'Bluebird Coffee', role: /barista/i },
  'hospital-software-engineer.txt': { family: 'software', company: 'Summit Health', role: /software engineer/i },
};
const FIXTURES = Object.keys(EXPECTED);
const SEEDS = Array.from({ length: 25 }, (_, i) => i + 1);

function allBankItems() {
  const items = [];
  for (const f of ROLE_FAMILIES) items.push(...f.likely);
  for (const c of COMPETENCIES) items.push(...c.questions);
  for (const i of INDUSTRIES) items.push(...i.questions);
  items.push(...UNIVERSAL.openers, ...UNIVERSAL.whyCompany, ...UNIVERSAL.whyRole, ...UNIVERSAL.classics, ...UNIVERSAL.motivationExtra);
  return items;
}

function assertNoNearDuplicates(questions, label) {
  for (let i = 0; i < questions.length; i += 1) {
    for (let j = i + 1; j < questions.length; j += 1) {
      const s = similarity(questions[i].text, questions[j].text);
      assert.ok(s < 0.6, `${label}: near-duplicates (${s.toFixed(2)}):\n  ${questions[i].text}\n  ${questions[j].text}`);
    }
  }
}

test('every fixture is read as the right role type, company and title', () => {
  for (const name of FIXTURES) {
    const a = analyzePosting(fixture(name));
    const want = EXPECTED[name];
    assert.equal(a.family, want.family, `${name}: family`);
    assert.equal(a.company, want.company, `${name}: company`);
    assert.match(a.role, want.role, `${name}: role "${a.role}"`);
    assert.ok(a.role.length <= 90, `${name}: role too long`);
  }
});

test('skills, industry and seniority are picked up', () => {
  const data = analyzePosting(fixture('gs-data-analyst.txt'));
  for (const s of ['SQL', 'Python', 'Tableau', 'Snowflake']) assert.ok(data.skills.includes(s), `missing ${s}`);
  assert.equal(data.industry?.id, 'financial_services');
  assert.equal(data.seniority, 'entry');
  const nurse = analyzePosting(fixture('registered-nurse.txt'));
  assert.ok(nurse.skills.includes('Epic'), 'Epic EHR should count as a skill for nurses');
  assert.equal(analyzePosting(fixture('hospital-software-engineer.txt')).industry?.id, 'healthcare');
  // "R" and "Go" need context; plain English words must not count.
  const plain = analyzePosting('We are hiring. You will go to meetings and report results. Data Analyst role at a startup with Excel.');
  assert.ok(!plain.skills.includes('R') && !plain.skills.includes('Go'), plain.skills.join(','));
  assert.ok(analyzePosting('Data Analyst. Experience with Python and R, and SQL.').skills.includes('R'));
});

test('competencies come back sorted with counts', () => {
  const a = analyzePosting(fixture('gs-data-analyst.txt'));
  assert.ok(a.competencies.length > 2);
  for (let i = 1; i < a.competencies.length; i += 1) assert.ok(a.competencies[i - 1].hits >= a.competencies[i].hits);
  assert.ok(a.competencies.some((c) => c.id === 'detail'));
});

test('junk input never throws and gives blanks', () => {
  for (const input of [undefined, null, '', '   ', 12345, {}, [], '!!!!????', 'a', 'ÄÖÜ ß 日本語の求人 仕事 データ'.repeat(50)]) {
    const a = analyzePosting(input);
    assert.equal(typeof a.family, 'string');
    assert.ok(FAMILIES.some((f) => f.id === a.family));
  }
  assert.doesNotThrow(() => buildInterview());
  assert.doesNotThrow(() => buildInterview(null));
  assert.doesNotThrow(() => buildInterview({ userQuestions: 'not an array', analysis: 'nope', family: 'nonsense', likelyCount: 'x', defaults: null }));
});

test('reading a very long posting is fast', () => {
  const long = (fixture('gs-data-analyst.txt') + '\n').repeat(45).slice(0, 60_000);
  const t0 = performance.now();
  analyzePosting(long);
  const ms = performance.now() - t0;
  assert.ok(ms < 400, `took ${ms.toFixed(0)} ms`);
});

test('no questions typed: likely questions plus one curveball, never first', () => {
  for (const name of FIXTURES) {
    const analysis = analyzePosting(fixture(name));
    for (const seed of SEEDS) {
      const { questions } = buildInterview({ analysis, includeCurveball: true, defaults: { prep: 30, answer: 120 }, seed });
      assert.equal(questions.length, 6, `${name} seed ${seed}`);
      assert.equal(questions.filter((q) => q.source === 'likely').length, 5);
      const cb = questions.findIndex((q) => q.source === 'curveball');
      assert.ok(cb >= 1, `${name} seed ${seed}: curveball at ${cb}`);
      assert.equal(questions[0].category, 'intro', `${name}: should open with an intro question`);
    }
  }
});

test('likelyCount is respected, with a minimum of 3 when nothing is typed', () => {
  const analysis = analyzePosting(fixture('teacher.txt'));
  assert.equal(buildInterview({ analysis, likelyCount: 8, includeCurveball: false, seed: 3 }).questions.length, 8);
  assert.equal(buildInterview({ analysis, likelyCount: 1, includeCurveball: false, seed: 3 }).questions.length, 3);
  assert.equal(buildInterview({ analysis, likelyCount: 0, includeCurveball: false, seed: 3 }).questions.length, 5);
});

test('same seed, same interview; different seeds vary the curveball', () => {
  const analysis = analyzePosting(fixture('registered-nurse.txt'));
  const a = buildInterview({ analysis, seed: 42 });
  const b = buildInterview({ analysis, seed: 42 });
  assert.deepEqual(a, b);
  const curveballs = new Set(SEEDS.map((seed) => buildInterview({ analysis, seed }).questions.find((q) => q.source === 'curveball').text));
  assert.ok(curveballs.size >= 3, `only ${curveballs.size} different curveballs`);
});

test('the curveball is usually about the role', () => {
  const analysis = analyzePosting(fixture('it-audit-analyst.txt'));
  const whys = SEEDS.map((seed) => buildInterview({ analysis, seed }).questions.find((q) => q.source === 'curveball').why);
  const roleRelated = whys.filter((w) => !/think on your feet/.test(w)).length;
  assert.ok(roleRelated >= 18, `${roleRelated}/25 role-related`);
});

test('no near-duplicates anywhere, with or without your own questions', () => {
  const mine = [
    { text: 'Tell me about yourself.' },
    { text: 'Why Goldman Sachs?' },
    { text: 'Tell me about a time you worked on a team.' },
  ];
  for (const name of FIXTURES) {
    const analysis = analyzePosting(fixture(name));
    for (const seed of SEEDS) {
      assertNoNearDuplicates(buildInterview({ analysis, seed, likelyCount: 8 }).questions, `${name} seed ${seed}`);
      assertNoNearDuplicates(buildInterview({ analysis, seed, userQuestions: mine, likelyCount: 5 }).questions, `${name} (mine) seed ${seed}`);
    }
  }
});

test('your questions keep their order and times; likely ones avoid repeating them', () => {
  const analysis = analyzePosting(fixture('gs-data-analyst.txt'));
  const userQuestions = [
    { text: 'Why Goldman Sachs?', prep: 45, answer: 90 },
    { text: 'Tell me about a time you failed.', prep: 0, answer: 60 },
    { text: 'What is your favorite SQL function?' },
  ];
  for (const seed of SEEDS) {
    const { questions } = buildInterview({ analysis, userQuestions, likelyCount: 4, defaults: { prep: 30, answer: 120 }, seed });
    const mine = questions.filter((q) => q.source === 'user');
    assert.deepEqual(mine.map((q) => q.text), userQuestions.map((q) => q.text));
    assert.deepEqual(mine.map((q) => [q.prep, q.answer]), [[45, 90], [0, 60], [30, 120]]);
    const likely = questions.filter((q) => q.source === 'likely');
    assert.equal(likely.length, 4);
    assert.ok(!likely.some((q) => q.category === 'motivation_company'), 'should not ask why-company twice');
    assert.ok(!likely.some((q) => q.category === 'behavioral_failure'), 'should not ask about failure twice');
    // Openers go before your questions; everything else after.
    const firstUser = questions.findIndex((q) => q.source === 'user');
    questions.slice(0, firstUser).forEach((q) => assert.ok(q.category === 'intro' || q.source === 'curveball'));
  }
});

test('with your own questions and no extras, only the curveball is added', () => {
  const { questions } = buildInterview({ userQuestions: [{ text: 'Q one?' }, { text: 'Q two?' }], likelyCount: 0, seed: 9 });
  assert.equal(questions.length, 3);
  assert.equal(questions.filter((q) => q.source === 'curveball').length, 1);
  assert.notEqual(questions[0].source, 'curveball');
  const one = buildInterview({ userQuestions: ['Only question?'], likelyCount: 0, seed: 1 }).questions;
  assert.equal(one[1].source, 'curveball', 'with one question the curveball goes after it');
  const none = buildInterview({ userQuestions: ['Only question?'], likelyCount: 0, includeCurveball: false }).questions;
  assert.equal(none.length, 1);
});

test('25 typed questions work', () => {
  const userQuestions = Array.from({ length: 25 }, (_, i) => ({ text: `Custom question number ${i + 1} about topic ${i * 7}?` }));
  const { questions } = buildInterview({ userQuestions, likelyCount: 2, seed: 5 });
  assert.equal(questions.filter((q) => q.source === 'user').length, 25);
  assert.equal(questions.length, 28);
});

test('templates are always fully filled, for every role type', () => {
  const contexts = [
    { company: '', role: '' },
    { company: 'Acme Corp', role: 'Analyst' },
    { company: 'Goldman Sachs', role: '2027 Summer Analyst Program' },
  ];
  for (const fam of FAMILIES) {
    for (const ctx of contexts) {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const { questions } = buildInterview({ family: fam.id, ...ctx, likelyCount: 8, seed });
        for (const q of questions) {
          assert.ok(!/[{}]/.test(q.text), `${fam.id}: leftover brace in "${q.text}"`);
          assert.ok(!/\s{2,}|\bat \?|\bat \.|\bthis {2}| ,/.test(q.text), `${fam.id}: awkward "${q.text}"`);
          assert.ok(/[?.!]$/.test(q.text), `${fam.id}: no end punctuation "${q.text}"`);
          assert.ok(Number.isInteger(q.prep) && q.prep >= 0 && Number.isInteger(q.answer) && q.answer > 0);
          assert.ok(CATEGORIES.includes(q.category), `${q.category}`);
          assert.ok(q.why.length <= 90, `why too long: ${q.why}`);
        }
      }
    }
  }
});

test('unknown role type falls back to general; the typed company is used', () => {
  const b = buildInterview({ family: 'astronaut', company: 'Initech', seed: 2 });
  assert.equal(b.family, 'general');
  assert.ok(b.questions.some((q) => q.text.includes('Initech')));
});

test('Goldman Sachs postings draw on reported Goldman questions', () => {
  const analysis = analyzePosting(fixture('gs-data-analyst.txt'));
  const reported = new Set(GOLDMAN_REPORTED.map((q) => q.text));
  for (const seed of SEEDS.slice(0, 10)) {
    const { questions } = buildInterview({ analysis, seed });
    assert.ok(questions.filter((q) => reported.has(q.text)).length >= 2, `seed ${seed}`);
    assert.ok(questions.some((q) => q.text === 'Why do you want to work at Goldman Sachs?'));
  }
});

test('fillTemplate and classifyQuestion', () => {
  assert.equal(fillTemplate({ t: 'Why {company}?', a: 'Why us?' }, { company: 'Acme' }), 'Why Acme?');
  assert.equal(fillTemplate({ t: 'Why {company}?', a: 'Why us?' }, {}), 'Why us?');
  assert.equal(fillTemplate('Why {company}?', {}), null);
  assert.equal(classifyQuestion('Why Goldman Sachs?'), 'motivation_company');
  assert.equal(classifyQuestion('Why Risk?'), 'motivation_role');
  assert.equal(classifyQuestion('Tell me about yourself.'), 'intro');
  assert.equal(classifyQuestion('Walk me through your resume'), 'intro');
  assert.equal(classifyQuestion('Tell me about a time you failed.'), 'behavioral_failure');
  assert.equal(classifyQuestion('What is your greatest weakness?'), 'strengths_weaknesses');
  assert.equal(similarity('Tell me about yourself.', 'Tell me about yourself.'), 1);
  assert.ok(similarity('Tell me about a time you led a team.', 'Explain recursion simply.') < 0.2);
});

test('example library: expected groups, no empty or duplicate questions', () => {
  const groups = libraryFor({ family: 'data', company: 'Goldman Sachs', role: 'Data Analyst' });
  assert.deepEqual(groups.map((g) => g.id), ['common', 'role', 'goldman', 'behavioral', 'motivation', 'curveball']);
  for (const g of groups) {
    assert.ok(g.questions.length > 0, g.id);
    const texts = g.questions.map((q) => q.text.toLowerCase());
    assert.equal(new Set(texts).size, texts.length, `${g.id} has duplicates`);
    for (const q of g.questions) assert.ok(!/[{}]/.test(q.text), q.text);
  }
  assert.ok(groups[0].questions.some((q) => q.text === 'Why do you want to work at Goldman Sachs?'));
  const general = libraryFor({});
  assert.ok(!general.some((g) => g.id === 'role'));
  assert.ok(general.find((g) => g.id === 'goldman').questions.length >= 30);
});

test('every bank question has a valid category and ends with punctuation', () => {
  for (const item of allBankItems()) {
    const [text, cat] = Array.isArray(item) ? item : [item.t, item.c];
    assert.ok(CATEGORIES.includes(cat), `bad category "${cat}" for "${text}"`);
    assert.ok(/[?.!]$/.test(text), `no end punctuation: ${text}`);
  }
  for (const q of GOLDMAN_REPORTED) assert.ok(CATEGORIES.includes(q.category), q.text);
  for (const f of ROLE_FAMILIES) {
    if (f.id === 'general') continue;
    assert.ok(f.likely.length >= 8, `${f.id} needs more likely questions`);
    assert.ok(f.curveballs.length >= 5, `${f.id} needs more curveballs`);
  }
});
