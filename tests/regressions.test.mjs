// Regression tests for problems found in code review: messy pasted postings,
// ambiguous titles, Goldman matching, false skill matches and boilerplate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePosting, buildInterview, classifyQuestion, withArticle } from '../js/engine.js';
import { GOLDMAN_REPORTED } from '../js/bank-goldman.js';
import { questionKey } from '../js/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);
const gsTexts = new Set(GOLDMAN_REPORTED.map((q) => q.text));

test('company names never swallow the line above', () => {
  const cases = [
    ['Data Analyst\nBenefits\n- Paid Time Off\n\nSummit Ridge Capital is an equal opportunity employer.', 'Summit Ridge Capital'],
    ['Project Engineer\nEqual Opportunity Employer\nPinecrest Builders is an Equal Opportunity Employer.', 'Pinecrest Builders'],
    ['Data Analyst\n- Must live in Utah.\nSummit Ridge Capital is an equal opportunity employer.', 'Summit Ridge Capital'],
    ['Data Analyst\n- Strong Excel.\nDiversity, Equity & Inclusion\nBrightline Health is an equal opportunity employer.', 'Brightline Health'],
    ['Barista\nJoin us!\nBluebird Coffee Co. is an equal opportunity employer.', 'Bluebird Coffee'],
  ];
  for (const [text, want] of cases) assert.equal(analyzePosting(text).company, want, text);
});

test('generic "About ..." headings and places are not companies', () => {
  for (const heading of ['About The Hospital', 'About The Program', 'About Salt Lake City', 'About Working Here', 'About Utah']) {
    const a = analyzePosting(`Registered Nurse\n${heading}\nWe care for patients across the region with compassion and skill every day.`);
    assert.notEqual(a.company, heading.replace(/^About (The )?/, ''), heading);
    assert.ok(!/^(Hospital|Program|Salt Lake City|Working Here|Utah)$/.test(a.company), `${heading} -> ${a.company}`);
  }
});

test('copied job-board navigation is ignored', () => {
  const text = `Skip to main content\n0 notifications total\nHome\nJobs\nMessaging\n${fixture('teacher.txt')}`;
  const a = analyzePosting(text);
  assert.match(a.role, /teacher/i);
  assert.equal(a.family, 'education');
  const printed = analyzePosting('10/30/26, 4:12 PM Data Analyst - Salt Lake City, UT - Indeed.com\nWe need SQL, Python and Tableau for dashboards and data quality.');
  assert.equal(printed.role, 'Data Analyst');
});

test('ambiguous title words do not pick the wrong role type', () => {
  const tpm = analyzePosting('Technical Program Manager\nLumen Freight Software\nLead roadmap planning with engineering and product teams. Run agile ceremonies, manage the backlog, coordinate launches of new SaaS features with APIs and cloud services.');
  assert.ok(['product', 'software'].includes(tpm.family), tpm.family);
  const qa = analyzePosting('Quality Assurance Analyst\nTest web and mobile software. Write test cases, automate regression tests in Python and Selenium, file bugs in Jira, and join code reviews and agile sprints.');
  assert.equal(qa.family, 'software');
  const sysadmin = analyzePosting('Windows Server Administrator\nManage Active Directory, patching, firewalls and endpoint security. Handle tickets in ServiceNow and troubleshoot networking issues.');
  assert.equal(sysadmin.family, 'it_security');
  const principal = analyzePosting('Principal Engineer\nDesign distributed systems and microservices in Java and Kubernetes. Mentor engineers through code reviews and own CI/CD.');
  assert.notEqual(principal.family, 'education');
  const ba = analyzePosting('Business Analyst I\nWasatch Federal Bank - IT Department\nGather requirements, write user stories, test system changes and write SQL queries for reporting. Work with developers on the core banking platform.');
  assert.notEqual(ba.family, 'consulting');
});

test('job titles are cleaned of salary, job sites and hiring banners', () => {
  const role = (t) => analyzePosting(`${t}\nWe use SQL and Python to build dashboards and keep data accurate for the business every day.`).role;
  assert.equal(role('Data Analyst - Remote - $80,000/yr'), 'Data Analyst');
  assert.equal(role('Data Analyst #12345'), 'Data Analyst');
  assert.equal(role('IT AUDIT ANALYST'), 'IT Audit Analyst');
  assert.equal(role('SOFTWARE ENGINEER II'), 'Software Engineer II');
  assert.equal(analyzePosting('Job Title: Bank Teller\nHelp customers with deposits and withdrawals at our branch every day.').role, 'Bank Teller');
  const nurse = analyzePosting('Registered Nurse - ICU - $10,000 Sign-On Bonus\nCare for patients in the ICU with our hospital team.').role;
  assert.ok(!/\$|bonus/i.test(nurse), nurse);
});

test('only Goldman Sachs turns on the Goldman questions', () => {
  for (const company of ['Goldman Family Dental', 'Goldman Law Group', 'Goldman Properties']) {
    for (const seed of SEEDS.slice(0, 10)) {
      const { questions } = buildInterview({ company, family: 'general', likelyCount: 8, seed });
      assert.ok(!questions.some((q) => /Goldman Sachs/.test(q.text) || gsTexts.has(q.text) && /Goldman|financial markets/.test(q.text)), `${company}: ${questions.map((q) => q.text).join(' | ')}`);
    }
  }
  const gs = buildInterview({ company: 'Goldman Sachs', family: 'data', seed: 1 }).questions;
  assert.ok(gs.some((q) => q.text === 'Why do you want to work at Goldman Sachs?'));
});

test('Goldman division questions match the job', () => {
  const motivation = (family, role) =>
    SEEDS.map((seed) => buildInterview({ company: 'Goldman Sachs', family, role, seed }).questions.find((q) => q.category === 'motivation_role')?.text || '');
  assert.ok(motivation('risk_compliance', 'Compliance Analyst').every((t) => !/Why Risk/.test(t)));
  assert.ok(motivation('risk_compliance', 'Internal Audit Analyst').every((t) => !/Why Risk/.test(t)));
  assert.ok(motivation('markets', 'Sales & Trading Analyst').every((t) => t !== 'Why investment banking?'));
  assert.ok(motivation('accounting_audit', 'Controllers Analyst').every((t) => t !== 'Why Internal Audit?'));
});

test('everyday words are not counted as software skills', () => {
  const nurse = analyzePosting('ER Nurse\nYou react calmly and quickly in emergencies and help every patient excel in recovery.').skills;
  const teacher = analyzePosting('4th Grade Teacher\nHelp every student excel and spark curiosity throughout the workday.').skills;
  const barista = analyzePosting('Barista\nBrew a great cup of Java for every guest and keep the cafe clean.').skills;
  for (const s of [...nurse, ...teacher, ...barista]) assert.ok(!['React', 'Excel', 'Spark', 'Workday', 'Java'].includes(s), s);
  const tools = analyzePosting('Data Analyst\nBuild reports in Microsoft Excel and Power BI, and pipelines in Apache Spark.').skills;
  assert.ok(tools.includes('Excel') && tools.includes('Spark'));
});

test('benefits and EEO text do not decide the industry or competencies', () => {
  const benefits = '\nBenefits:\n- Medical, dental and vision insurance\n- Life insurance\n- Flexible schedule and flexible PTO\n- Mentorship program\n';
  const eeo = '\nWe are an equal opportunity employer. Applicants are considered without regard to any status protected by federal, state or local law. We participate in E-Verify with the federal government and the Department of Homeland Security.\n';
  const barista = analyzePosting(fixture('barista.txt') + benefits);
  assert.notEqual(barista.industry?.id, 'financial_services');
  const marketing = analyzePosting(fixture('marketing-coordinator.txt') + eeo);
  assert.notEqual(marketing.industry?.id, 'government_public');
  const ops = analyzePosting(fixture('supply-chain-analyst.txt') + benefits);
  assert.ok(!['adaptability', 'leadership'].includes(ops.competencies[0]?.id), ops.competencies[0]?.id);
});

test('knowledge areas get sensible questions', () => {
  const a = analyzePosting('Staff Accountant\nPrepare journal entries under GAAP. Apply GAAP to revenue recognition and keep GAAP reconciliations current.');
  for (const seed of SEEDS) {
    const { questions } = buildInterview({ analysis: a, likelyCount: 8, seed });
    assert.ok(!questions.some((q) => /GAAP trick|GAAP is bad at|used GAAP\. What/.test(q.text)), questions.map((q) => q.text).join(' | '));
  }
});

test('typed questions are recognized so they are not asked twice', () => {
  assert.equal(classifyQuestion('Why Supply Chain?'), 'motivation_role');
  assert.equal(classifyQuestion('Why Software Engineering?'), 'motivation_role');
  assert.equal(classifyQuestion('Why Goldman Sachs?'), 'motivation_company');
  assert.equal(classifyQuestion('Why do you want this job?'), 'motivation_role');
  assert.equal(classifyQuestion('What interests you about this position?'), 'motivation_role');
  assert.equal(classifyQuestion('What interests you about our firm?'), 'motivation_company');
  assert.equal(classifyQuestion('Give me a quick overview of your background.'), 'intro');
});

test('a/an before role labels', () => {
  assert.equal(withArticle('IT & cybersecurity'), 'an IT & cybersecurity');
  assert.equal(withArticle('HR & recruiting'), 'an HR & recruiting');
  assert.equal(withArticle('accounting, audit & tax'), 'an accounting, audit & tax');
  assert.equal(withArticle('data & analytics'), 'a data & analytics');
});

// ---------- Spotting the same question (setup list and the code page) ----------

test('questionKey ignores case, punctuation and spacing', () => {
  assert.equal(questionKey('Tell me about yourself.'), questionKey('  tell me ABOUT yourself '));
  assert.equal(questionKey('Why isn’t it?'), questionKey("Why isn't it?"));
});

test('questionKey keeps questions in other scripts, and symbols that change the meaning', () => {
  assert.notEqual(questionKey('请介绍一下你自己。'), '');
  assert.notEqual(questionKey('Расскажите о себе.'), questionKey('Почему вы хотите у нас работать?'));
  assert.notEqual(questionKey('What do you like about C++?'), questionKey('What do you like about C#?'));
  assert.notEqual(questionKey('What’s 17 × 3?'), questionKey('What’s 17 + 3?'));
  assert.notEqual(questionKey('आप कौन हैं?'), questionKey('आप कोन हैं?'));
  assert.equal(questionKey('???'), '');
});
