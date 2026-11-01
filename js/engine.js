// Reads a job posting and builds the interview: the questions most likely to
// come up, plus one hidden curveball. Pure logic: no DOM, no network, runs in
// browsers and in Node (see tests/engine.test.mjs).
import {
  ROLE_FAMILIES,
  COMPETENCIES,
  SKILLS,
  SKILL_LIKELY,
  SKILL_CURVEBALLS,
  KNOWLEDGE_LIKELY,
  KNOWLEDGE_CURVEBALLS,
  INDUSTRIES,
  UNIVERSAL,
  GENERIC_CURVEBALLS,
  STOPWORDS,
} from './bank.js';
import { GOLDMAN_REPORTED } from './bank-goldman.js';

export const FAMILIES = ROLE_FAMILIES.map(({ id, label }) => ({ id, label }));
const FAMILY = new Map(ROLE_FAMILIES.map((f) => [f.id, f]));
const COMPETENCY = new Map(COMPETENCIES.map((c) => [c.id, c]));
const INDUSTRY = new Map(INDUSTRIES.map((i) => [i.id, i]));
const SKILL_KIND = new Map(SKILLS.map((s) => [s.name, s.kind || 'tool']));
const skillLikely = (skill) => (SKILL_KIND.get(skill) === 'knowledge' ? KNOWLEDGE_LIKELY : SKILL_LIKELY);
const skillCurveballs = (skill) => (SKILL_KIND.get(skill) === 'knowledge' ? KNOWLEDGE_CURVEBALLS : SKILL_CURVEBALLS);

export const CATEGORIES = [
  'intro', 'motivation_company', 'motivation_role', 'behavioral_teamwork', 'behavioral_leadership',
  'behavioral_failure', 'behavioral_conflict', 'behavioral_challenge', 'behavioral_ethics',
  'behavioral_initiative', 'behavioral_pressure', 'behavioral_communication', 'behavioral_detail',
  'behavioral_learning', 'commercial_awareness', 'technical', 'situational', 'strengths_weaknesses',
  'curveball', 'other',
];

const GS_WHY = 'Commonly reported in Goldman Sachs HireVue interviews';

// ---------- Small helpers ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tidy = (s) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([?.!,;:])/g, '$1')
    .trim();
const cleanText = (s) => tidy(s).slice(0, 100);

function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Seeded random numbers, so the same seed always builds the same interview. */
function mulberry32(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same items, starting from a random point among the first `span`. */
function rotate(arr, rng, span = arr.length) {
  if (!arr.length) return [];
  const start = Math.floor(rng() * Math.max(1, Math.min(span, arr.length)));
  return [...arr.slice(start), ...arr.slice(0, start)];
}

function shuffle(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Bank items come as 'text', [text, category] or { t, a, c }. */
function normalizeItem(item) {
  if (typeof item === 'string') return { t: item, a: '', c: '' };
  if (Array.isArray(item)) return { t: item[0], a: '', c: item[1] || '' };
  return { t: item.t, a: item.a || '', c: item.c || '' };
}

/**
 * Fills {company}, {role}, {field} and {skill}. If a needed value is empty,
 * uses the alternate wording, or returns null when there is none.
 */
export function fillTemplate(template, ctx = {}) {
  const item = normalizeItem(template);
  const fill = (s) => {
    if (!s) return null;
    let missing = false;
    const out = s.replace(/\{(company|role|field|skill)\}/g, (_, key) => {
      const value = cleanText(ctx[key]);
      if (!value) missing = true;
      return value;
    });
    return missing ? null : tidy(out);
  };
  return fill(item.t) ?? fill(item.a);
}

/** Role titles read naturally only when short and plain ("this Data Analyst role"). */
function roleForTemplate(role) {
  let r = cleanText(role).replace(/^(?:19|20)\d{2}\s+/, '');
  if (!r || r.length > 48 || r.split(/\s+/).length > 6) return '';
  if (/[$!?:#]/.test(r)) return '';
  if (/\b(?:role|position|job|program|programme|opportunity|internship|hiring)\b/i.test(r)) return '';
  if (r === r.toUpperCase() && /[A-Z]{4,}/.test(r)) r = smartTitleCase(r);
  return r;
}

// ---------- Matching posting text ----------

function termPattern(term) {
  const prefix = term.endsWith('*');
  const core = prefix ? term.slice(0, -1) : term;
  const body = core
    .split(/\s+/)
    .map(escapeRe)
    .join('[\\s-]+');
  const start = /^[a-z0-9]/i.test(core) ? '\\b' : '';
  if (prefix) return `${start}${body}[a-z-]*`;
  const plural = /[a-z]$/i.test(core) ? '(?:s|es)?' : '';
  const end = /[a-z0-9]$/i.test(core) ? '\\b' : '(?![a-z0-9])';
  return `${start}${body}${plural}${end}`;
}

const termCache = new Map();
function termRe(term) {
  let re = termCache.get(term);
  if (!re) {
    re = new RegExp(termPattern(term), 'gi');
    termCache.set(term, re);
  }
  return re;
}

function countTerm(text, term, cap = 50) {
  const re = termRe(term);
  re.lastIndex = 0;
  let n = 0;
  while (n < cap && re.exec(text)) n += 1;
  return n;
}

const hasTerm = (text, term) => countTerm(text, term, 1) > 0;

// ---------- Reading the posting ----------

const ROLE_WORDS = /\b(?:analyst|engineer|developer|manager|associate|specialist|coordinator|consultant|nurse|teacher|representative|assistant|intern|internship|director|designer|scientist|technician|officer|administrator|accountant|auditor|advisor|adviser|planner|recruiter|architect|therapist|pharmacist|cashier|barista|clerk|supervisor|agent|strategist|writer|editor|producer|attorney|paralegal|counsel|tutor|instructor|professor|educator|aide|operator|mechanic|electrician|driver|server|host|bartender|cook|chef|receptionist|executive|trader|banker|economist|actuary|underwriter|buyer|controller|bookkeeper|programmer|tester|caregiver|lead|crew|member|apprentice|fellow|paraprofessional|hygienist|phlebotomist|paramedic|emt|lpn|rn|cna|sdr|bdr|teller|scribe|lifeguard|welder|dispatcher|custodian|housekeeper|machinist|janitor|nanny|carpenter|plumber|installer|inspector|estimator|surveyor|coach|counselor|librarian|photographer|translator|interpreter|courier|stocker|merchandiser)s?\b/i;
const NOT_A_TITLE = /^(?:about|we\b|we're|our\b|the company|company|location|job description|description|overview|summary|who we are|what you|responsibilities|requirements|qualifications|benefits|apply|salary|pay)/i;
const LOCATION_WORDS = /\b(?:remote|hybrid|on-?site|in-?office|united states|usa|u\.s\.?|new york|salt lake city|san francisco|los angeles|chicago|dallas|houston|london|seattle|boston|atlanta|denver|austin|phoenix|miami|washington,?\s*d\.?c\.?|lehi|provo|ogden|sandy|draper|toronto)\b/i;
const US_STATE = /^(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/i;
const CITY_STATE = /^[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5})?$/;
const isLocation = (s) => LOCATION_WORDS.test(s) || CITY_STATE.test(s.trim()) || US_STATE.test(s.trim());

// Lines that come from copying a job-board page rather than from the posting.
const NAV_LINE = /^(?:skip to (?:main )?content|jump to (?:main )?content|\d+ notifications? total|notifications|sign in|sign up|join now|log ?in|home|jobs|my network|messaging|me|for business|try premium.*|easy apply|apply(?: now)?|save|saved|share|show (?:more|less)|see more|report this job|promoted|reposted .*|actively (?:recruiting|reviewing applicants)|be an early applicant|(?:over )?\d+ applicants|\d+ (?:minutes?|hours?|days?|weeks?) ago|people you can reach out to|meet the hiring team|message|follow|about the job|job details|full job description|https?:\/\/\S+|\d+\s*\/\s*\d+)$/i;
const PRINT_HEADER = /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}\s*(?:AM|PM)?\s*/i;

// Boilerplate that should not decide the role type, industry or competencies.
const EEO_LINE = /\b(?:equal (?:employment )?opportunity|affirmative action|e-verify|protected veteran|veteran status|sexual orientation|gender identity|national origin|reasonable accommodation|pay transparency|background check|drug[- ]free|without regard to|applicants? with disabilities|genetic information|marital status)\b/i;
const BENEFITS_HEAD = /^(?:benefits|perks|perks (?:and|&) benefits|our benefits|what we offer|we offer|compensation(?: (?:and|&) benefits)?|pay(?: range)?|salary(?: range)?|total rewards|why (?:you'?ll love )?work(?:ing)? (?:here|with us)|what'?s in it for you|eeo statement|equal opportunity(?: employer)?|legal(?: notice)?)\b[^.]{0,40}:?$/i;
const CONTENT_HEAD = /^(?:responsibilities|requirements|qualifications|what you(?:'ll| will) do|who you are|what we(?:'re| are) looking for|about (?:the|this) (?:role|job|team|position)|the role|duties|skills|(?:preferred|basic|minimum) qualifications|job summary|summary|overview|position summary|description)\b[^.]{0,30}:?$/i;

function stripBullet(line) {
  return line.replace(/^[\s\-*•●▪◦·–—]+/, '').trim();
}

function coreLines(lines) {
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const l = stripBullet(line);
    if (BENEFITS_HEAD.test(l)) {
      skipping = true;
      continue;
    }
    if (skipping && CONTENT_HEAD.test(l)) skipping = false;
    if (skipping || EEO_LINE.test(l)) continue;
    out.push(line);
  }
  return out;
}

const ACRONYMS = new Set('IT HR QA UX UI II III IV SDR BDR RN LPN CNA EMT CPA AI ML BI SQL AWS GIS CAD PR SEO VP CEO CFO CTO COO US USA NYC SLC EHS HVAC PM TPM IAM SOC GRC KYC AML ETL FP&A M&A'.split(' '));
const SMALL_WORDS = new Set(['and', 'of', 'the', 'for', 'in', 'at', 'to', 'a', 'an', 'or', 'with', 'on']);

/** "IT AUDIT ANALYST" -> "IT Audit Analyst" (keeps acronyms and roman numerals). */
function smartTitleCase(s) {
  let first = true;
  return s
    .split(/(\s+|\/|-)/)
    .map((w) => {
      if (!/[A-Za-z]/.test(w)) return w;
      const upper = w.toUpperCase();
      const lower = w.toLowerCase();
      let out;
      if (ACRONYMS.has(upper)) out = upper;
      else if (!first && SMALL_WORDS.has(lower)) out = lower;
      else out = lower.charAt(0).toUpperCase() + lower.slice(1);
      first = false;
      return out;
    })
    .join('');
}

const ROLE_JUNK = /\$|\b\d+(?:\.\d+)?\s*k\b|\/\s*(?:hr|hour|yr|year)\b|\bper\s+(?:hour|year)\b|\bbonus\b|\bhiring\b|\b(?:linkedin|indeed(?:\.com)?|glassdoor|ziprecruiter|handshake|monster|careerbuilder)\b|\bapply\b/i;

function cleanRole(raw) {
  let s = ` ${raw} `;
  s = s.replace(/^\s*(?:(?:now|urgently|we(?:'re| are))\s+hiring:?|hiring:|looking for an?|seeking an?|we are looking for an?|join (?:our|the) team as an?)\s+/i, ' ');
  s = s.replace(/\((?:[^)]*\b(?:remote|hybrid|on-?site|full[- ]time|part[- ]time|contract|temporary|req|id)\b[^)]*|[^)]*\d{4,}[^)]*)\)/gi, ' ');
  s = s.replace(/\b(?:req(?:uisition)?|job)\s*(?:id|#|no\.?|number)\s*[:#]?\s*[\w-]+/gi, ' ');
  s = s.replace(/#\s*\d+/g, ' ').replace(/!+/g, ' ');
  const parts = s
    .split(/\s+[|•·]\s+|\s+-\s+/)
    .map((p) => p.trim().replace(/^[,;:\s]+|[,;:\s]+$/g, ''))
    .filter(Boolean);
  const kept = parts.filter((p, i) => !ROLE_JUNK.test(p) && (i === 0 || (!isLocation(p) && !/^\d[\d\s-]*$/.test(p))));
  let out = tidy(kept.join(' - ')).replace(/[.:;,]+$/, '');
  if (out === out.toUpperCase() && /[A-Z]{3,}/.test(out)) out = smartTitleCase(out);
  return out.slice(0, 90);
}

const looksLikeSentence = (l) => /[.!?]$/.test(l) && l.split(/\s+/).length > 7;

function extractRole(lines) {
  const label = /^(?:job\s*title|position(?:\s*title)?|role(?:\s*title)?|title|job)\s*[:\-]\s*(.{2,120})$/i;
  for (const line of lines.slice(0, 40)) {
    const m = stripBullet(line).match(label);
    if (!m) continue;
    const value = m[1].trim();
    // A labeled title is trusted even if it is unusual ("Bank Teller", "Lifeguard").
    if (value.split(/\s+/).length <= 8 && !looksLikeSentence(value)) {
      const role = cleanRole(value);
      if (role) return role;
    }
  }
  const head = lines
    .slice(0, 8)
    .map(stripBullet)
    .filter((l) => l.length >= 3 && l.length <= 110 && !NOT_A_TITLE.test(l) && !looksLikeSentence(l));
  const withRoleWord = head.find((l) => ROLE_WORDS.test(l) && cleanRole(l));
  if (withRoleWord) return cleanRole(withRoleWord);
  const withFamilyTitle = head.find((l) => familyTitleHit(l) && cleanRole(l));
  return withFamilyTitle ? cleanRole(withFamilyTitle) : '';
}

function familyTitleHit(text) {
  return ROLE_FAMILIES.some((f) => f.title.some((t) => t.length >= 6 && hasTerm(text, t)));
}

const BAD_COMPANY = new Set(
  ('we our the this you your job position role team location responsibilities requirements qualifications benefits overview ' +
    'summary company description about who what why how salary compensation applicants candidates remote hybrid department ' +
    'division engineering operations equal opportunity employer us inc llc it they she he here there join apply our company ' +
    'the company the firm the team the role the bank hiring manager recruiter monday friday program client business group ' +
    'project organization organisation hospital school practice careers culture details working perks paid time off ' +
    'diversity equity inclusion statement eeo people talent home jobs').split(' '),
);
const BAD_COMPANY_WORDS = /\b(?:employer|opportunit\w*|statement|benefits|perks|inclusion|equity|diversity|accommodation|veterans?|disabilit\w*|applicants?|candidates?|requirements|qualifications|responsibilities)\b/i;

// One word of a company name: initials (J.P.), a common abbreviation with its
// period (Co., Inc.), or a capitalized word. Words never span lines.
const WORD = "(?:(?:Co|Inc|Corp|Ltd|Bros|Intl|Mfg)\\.|[A-Z]\\.(?:[A-Z]\\.)+|[A-Z0-9][\\w&'’-]*)";
const NAME = `${WORD}(?:[ \\t]+(?:&[ \\t]+|of[ \\t]+|and[ \\t]+|de[ \\t]+|for[ \\t]+)?${WORD}){0,5}`;

function cleanCompany(raw) {
  let s = tidy(raw).replace(/^[\s"'(]+|[\s"',:;)]+$/g, '');
  for (let i = 0; i < 3; i += 1) {
    s = s.replace(/,?\s+(?:inc\.?|incorporated|llc|l\.l\.c\.|llp|ltd\.?|limited|corp\.?|plc|l\.?p\.?|n\.a\.|& co\.?(?:\s+llc)?|co\.?)$/i, '').trim();
  }
  s = s.replace(/[\s,.;:]+$/, '');
  if (/\bgoldman\s+sachs\b/i.test(s)) return 'Goldman Sachs';
  return s;
}

function validCompany(name) {
  if (!name || name.length < 2 || name.length > 50) return false;
  if (!/^[A-Z0-9]/.test(name)) return false;
  const lower = name.toLowerCase();
  if (BAD_COMPANY.has(lower) || isLocation(name) || BAD_COMPANY_WORDS.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > 6) return false;
  if (words.every((w) => BAD_COMPANY.has(w.toLowerCase()))) return false;
  if (/^the\s+\S+$/i.test(name)) return false; // "The Hospital", "The Program"
  if (ROLE_WORDS.test(name)) return false;
  if (/^(?:about|join|at|our|we|this|position|job|role|location)\b/i.test(name)) return false;
  return true;
}

function extractCompany(lines, text) {
  const votes = new Map();
  const vote = (raw, weight) => {
    const name = cleanCompany(raw || '');
    if (!validCompany(name)) return;
    votes.set(name, (votes.get(name) || 0) + weight);
  };
  for (const line of lines.slice(0, 80)) {
    const l = stripBullet(line);
    let m = l.match(/^(?:company(?:\s+name)?|employer|organi[sz]ation|hiring (?:company|organi[sz]ation))\s*[:\-]\s*(.{2,60})$/i);
    if (m) vote(m[1], 6);
    m = l.match(/^about\s+(?!us\b|you\b|the\b|this\b|our\b|working\b|me\b)(.{2,50}?)\s*:?$/i);
    if (m) vote(m[1], 4);
  }
  const lead = '(?:^|[.!?][ \\t]+)';
  const patterns = [
    [new RegExp(`${lead}(${NAME})[ \\t]+(?:is|are)[ \\t]+(?:a|an|the|one of)\\b(?=[^.\\n]{0,90}\\b(?:firm|company|bank|institution|organi[sz]ation|provider|leader|employer|group|agency|hospital|health system|school|district|start-?up|platform|brand|retailer|manufacturer|university|nonprofit|non-profit|practice|network|chain)\\b)`, 'gm'), 3],
    [new RegExp(`\\b[Aa]t[ \\t]+(${NAME}),[ \\t]+(?:we|our|you)\\b`, 'g'), 3],
    [new RegExp(`\\bJoin[ \\t]+(?!us\\b|our\\b|the\\b|a\\b|an\\b)(${NAME})`, 'g'), 2],
    [new RegExp(`${lead}(${NAME})[ \\t]+is[ \\t]+(?:an?[ \\t]+|proud(?:ly)?[ \\t]+(?:to[ \\t]+be[ \\t]+)?an?[ \\t]+)?(?:[Ee]qual[ \\t]+(?:[Ee]mployment|[Oo]pportunity)|EOE\\b|[Aa]ffirmative)`, 'gm'), 4],
    [new RegExp(`${lead}(${NAME})[ \\t]+(?:offers|provides)[ \\t]+(?:a[ \\t]+)?(?:competitive|comprehensive|generous)`, 'gm'), 2],
  ];
  for (const [re, weight] of patterns) {
    for (const m of text.matchAll(re)) vote(m[1], weight);
  }
  // A short, capitalized line right under the title is often the company.
  const second = stripBullet(lines[1] || '');
  if (second && second.length <= 40 && /^[A-Z0-9]/.test(second) && !ROLE_WORDS.test(second) && !isLocation(second) && !/[:.!?]$/.test(second)) {
    if (second.split(/\s+/).every((w) => /^[A-Z0-9&]/.test(w) || /^(?:of|and|de|for)$/.test(w))) vote(second, 2);
  }
  let best = '';
  let bestScore = 0;
  for (const [name, score] of votes) {
    const freq = (text.match(new RegExp(`\\b${escapeRe(name)}\\b`, 'g')) || []).length;
    const total = score + Math.min(3, freq * 0.5);
    if (total > bestScore) {
      best = name;
      bestScore = total;
    }
  }
  return bestScore >= 3.5 ? best : '';
}

function scoreFamilies(roleText, headText, body) {
  const scores = {};
  const bodyOnly = {};
  for (const f of ROLE_FAMILIES) {
    if (f.id === 'general') continue;
    let title = 0;
    let b = 0;
    for (const t of f.title) {
      const multi = /\s/.test(t);
      if (roleText && hasTerm(roleText, t)) title += multi ? 14 : 9;
      else if (hasTerm(headText, t)) title += multi ? 5 : 3;
      b += Math.min(3, countTerm(body, t, 3)) * 0.75;
    }
    for (const t of f.strong) {
      const n = countTerm(body, t, 4);
      if (n) b += 2 + (n - 1) * 0.75;
    }
    for (const t of f.weak) b += Math.min(2, countTerm(body, t, 2)) * 0.4;
    scores[f.id] = Math.round((title + b) * 10) / 10;
    bodyOnly[f.id] = b;
  }
  return { scores, bodyOnly };
}

const EMPTY_ANALYSIS = Object.freeze({
  company: '',
  role: '',
  family: 'general',
  familyLabel: 'General',
  confidence: 'low',
  familyScores: {},
  industry: null,
  competencies: [],
  skills: [],
  seniority: 'unknown',
});

// Big financial employers, matched against the company name only.
const KNOWN_FINANCIAL = /^(?:Goldman Sachs|Morgan Stanley|JP ?Morgan(?: Chase)?|JPMorgan Chase|Chase|Wells Fargo|Bank of America|Citi(?:group|bank)?|Fidelity(?: Investments)?|Charles Schwab|Schwab|Vanguard|BlackRock|Ally(?: Financial)?|Synchrony|Sallie Mae|American Express|Capital One|State Street|Northern Trust|Zions(?: Bank(?:corporation)?)?|U\.?S\.? Bank|PNC|Truist|Discover(?: Financial)?|Visa|Mastercard|PayPal|Stripe|KKR|Blackstone|Carlyle|Apollo(?: Global)?|Citadel|Jane Street|Two Sigma)$/;

/** Reads a job posting. Never throws; returns sensible blanks for junk input. */
export function analyzePosting(input) {
  try {
    if (typeof input !== 'string') return { ...EMPTY_ANALYSIS };
    const text = input
      .slice(0, 150_000)
      .replace(/\r\n?/g, '\n')
      .replace(/[   ]/g, ' ')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s[–—]\s/g, ' - ')
      .replace(/[ \t]+/g, ' ');
    if (text.replace(/\W/g, '').length < 20) return { ...EMPTY_ANALYSIS };
    const lines = text
      .split('\n')
      .map((l) => l.trim().replace(PRINT_HEADER, ''))
      .filter((l) => l && !NAV_LINE.test(l));
    const pageText = lines.join('\n');
    const role = extractRole(lines);
    const company = extractCompany(lines, pageText);
    const core = coreLines(lines);
    const body = core
      .join('\n')
      .toLowerCase()
      .replace(/flexib\w*\s+(?:schedules?|hours|pto|spending|work\w*|time|benefits)/g, ' ')
      .replace(/mentorship programs?/g, ' ');
    const headText = lines.slice(0, 6).join(' \n ').toLowerCase();
    const roleText = (role || stripBullet(lines[0] || '')).toLowerCase();

    const { scores: familyScores, bodyOnly } = scoreFamilies(roleText, headText, body);
    const ranked = Object.entries(familyScores).sort((a, b) => b[1] - a[1]);
    let [topId, top] = ranked[0] || ['general', 0];
    // A single title word should not beat a posting whose content is clearly about something else.
    const [bodyId, bodyBest] = Object.entries(bodyOnly).sort((a, b) => b[1] - a[1])[0] || ['general', 0];
    if (bodyId !== topId && bodyBest >= 15 && (bodyOnly[topId] || 0) < bodyBest * 0.25) {
      topId = bodyId;
      top = familyScores[bodyId];
    }
    const second = ranked.find(([id]) => id !== topId)?.[1] || 0;
    const family = top >= 6 ? topId : 'general';
    const confidence = family === 'general' ? 'low' : top >= 16 && top >= second * 1.4 ? 'high' : top >= 9 ? 'medium' : 'low';

    const competencies = COMPETENCIES.map((c) => ({
      id: c.id,
      label: c.label,
      hits: c.signals.reduce((sum, s) => sum + countTerm(body, s, 6), 0),
    }))
      .filter((c) => c.hits > 0)
      .sort((a, b) => b.hits - a.hits);

    const coreRaw = core.join('\n');
    const skills = SKILLS.map((s) => {
      const re = new RegExp(s.re, s.cs ? 'g' : 'gi');
      let count = 0;
      let first = Infinity;
      for (const m of coreRaw.matchAll(re)) {
        count += 1;
        first = Math.min(first, m.index);
        if (count >= 10) break;
      }
      return { name: s.name, count, first };
    })
      .filter((s) => s.count > 0)
      .sort((a, b) => b.count - a.count || a.first - b.first)
      .map((s) => s.name);

    let industry = null;
    let industryScore = 0;
    const knownBank = KNOWN_FINANCIAL.test(company);
    for (const ind of INDUSTRIES) {
      let score = ind.keywords.reduce((sum, k) => sum + Math.min(3, countTerm(body, k, 3)), 0);
      if (knownBank && ind.id === 'financial_services') score += 4;
      if (score > industryScore) {
        industry = ind;
        industryScore = score;
      }
    }

    let seniority = 'unknown';
    if (/\b(?:intern|internship|summer analyst|summer associate|co-?op)\b/i.test(lines.slice(0, 8).join(' '))) seniority = 'intern';
    else if (/\b(?:entry[- ]level|new grad(?:uate)?s?|recent graduates?|early[- ]career|campus hire|analyst program|graduate program|class of 20\d\d|0\s*-\s*2 years)\b/i.test(pageText)) seniority = 'entry';
    else if (/\b(?:[3-9]|1\d)\+?\s*(?:or more\s+)?years\b/i.test(pageText)) seniority = 'experienced';

    return {
      company,
      role,
      family,
      familyLabel: FAMILY.get(family).label,
      confidence,
      familyScores,
      industry: industry && industryScore >= 3 ? { id: industry.id, label: industry.label } : null,
      competencies,
      skills,
      seniority,
    };
  } catch {
    return { ...EMPTY_ANALYSIS };
  }
}

// ---------- Comparing and classifying questions ----------

function stem(word) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function tokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !STOPWORDS.has(w))
      .map(stem),
  );
}

/** 0 = unrelated, 1 = same question (word overlap on the meaningful words). */
export function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return tidy(a).toLowerCase() === tidy(b).toLowerCase() && tidy(a) ? 1 : 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  return (2 * shared) / (A.size + B.size);
}

const FIELD_WORDS = new Set(
  ('risk compliance operations ops consulting investment banking audit internal controllers engineering sales marketing ' +
    'nursing teaching data finance accounting technology tech law product design hr research healthcare trading markets asset ' +
    'wealth software supply chain human resources corporate private equity global cyber cybersecurity it quality project ' +
    'program customer service public nonprofit education science analytics business strategy management medicine tax ' +
    'treasury logistics procurement security infrastructure cloud recruiting retail hospitality communications law').split(' '),
);
const CLASSIFY = [
  ['intro', /\b(?:tell (?:me|us) (?:a (?:bit|little) )?about yourself|walk (?:me|us) through your (?:resume|cv|background)|introduce yourself|(?:overview|summary) of your (?:background|experience)|introduction)\b/],
  ['strengths_weaknesses', /\b(?:strengths?|weakness(?:es)?|why should we hire|describe yourself|three words|work ethic)\b/],
  ['motivation_company', /\b(?:why (?:do you want to|would you like to|would you) work (?:at|for|here|with us)|why (?:us|our (?:company|firm|organization|bank))|what (?:do you know|attracts you|draws you|excites you|interests you) (?:about|to) (?:us|our|this company|the company|this firm|this organization|our (?:firm|company|organization|organisation|bank|team))|why (?:this|our) (?:company|firm|organization|bank)|about (?:our|this|the) (?:firm|company|organization|organisation|bank)\b)\b/],
  ['motivation_role', /\b(?:why (?:this|the) (?:role|position|job|division|department|team|field|career|industry|internship)|why (?:are you|do you want to (?:work|be)) (?:in|a|an)\b|why do you want (?:this|the) (?:job|role|position)|interest(?:s|ed)? you (?:about|in) (?:this|the) (?:role|position|job|internship)|interested in (?:this|the) (?:role|position|job|internship)|where do you see yourself|career goals?|what (?:draws|attracts) you to (?:this|the) (?:role|position|field|work)|why (?:do you want to )?(?:teach|work in))\b/],
  ['behavioral_failure', /\b(?:fail(?:ed|ure|s)?|mistakes?|setbacks?|went wrong|missed (?:a|the) (?:deadline|goal)|did not go as planned|didn'?t go as planned)\b/],
  ['behavioral_ethics', /\b(?:ethic(?:s|al)?|integrity|confidential\w*|unethical|cheat\w*|the right thing|dishonest|backdate)\b/],
  ['behavioral_conflict', /\b(?:conflicts?|disagree(?:d|ment|s)?|difficult (?:team ?member|co-?worker|colleague|person|customer|client|manager|boss|patient|parent)|upset|angry|frustrated)\b/],
  ['behavioral_leadership', /\b(?:led|leader(?:ship)?|took charge|stepped up|lead (?:a|the) (?:team|project|group))\b/],
  ['behavioral_teamwork', /\b(?:team(?:work|mate|mates|s)?|collaborat\w*|group project)\b/],
  ['behavioral_pressure', /\b(?:pressure|deadlines?|prioriti\w*|stress\w*|juggl\w*|multiple (?:tasks|projects)|busy)\b/],
  ['behavioral_communication', /\b(?:explain\w*|present(?:ation|ed)?s?|persuad\w*|convinc\w*|communicat\w*|influenc\w*)\b/],
  ['behavioral_detail', /\b(?:details?|errors?|accura\w*|double-check\w*)\b/],
  ['behavioral_learning', /\b(?:learn\w*|feedback|taught yourself|new (?:skill|tool|technology|system))\b/],
  ['behavioral_initiative', /\b(?:initiative|above and beyond|improv\w*|efficien\w*|automat\w*|started|proud)\b/],
  ['behavioral_challenge', /\b(?:challeng\w*|obstacles?|difficult (?:situation|problem|decision)|hardest|incomplete information)\b/],
  ['commercial_awareness', /\b(?:markets?|news|trends?|industry|econom\w*|deals?|stocks?|pitch)\b/],
  ['situational', /^(?:what would you do|how would you (?:handle|respond|deal)|imagine|if you|suppose|you (?:notice|find|discover|see))\b/],
  ['technical', /\b(?:walk me through (?:how|a)|how would you (?:value|design|build|debug|test|estimate)|what is (?:a|an|the)|explain (?:how|what)|sql|python|data structures?|valuation|financial statements)\b/],
];

/** Rough category for a typed question, used to avoid adding near-duplicates. */
export function classifyQuestion(text) {
  const original = tidy(text);
  const t = original.toLowerCase();
  if (!t) return 'other';
  // "Why Goldman Sachs?" / "Why Supply Chain?": a capitalized name right after "why".
  const m = original.match(/^[Ww]hy\s+([A-Z][\w&'.-]*(?:\s+[\w&'.-]+){0,4})\s*\??$/);
  if (m && !/^(?:do|did|are|is|would|should|have|not|now|the|a|an|this|that|our|your)\b/i.test(m[1])) {
    const words = m[1].toLowerCase().split(/\s+/);
    return words.some((w) => FIELD_WORDS.has(w.replace(/[^a-z&]/g, ''))) ? 'motivation_role' : 'motivation_company';
  }
  for (const [category, re] of CLASSIFY) if (re.test(t)) return category;
  return 'other';
}

// ---------- Building the interview ----------


/** "an IT & cybersecurity role", "a data & analytics role" */
export function withArticle(phrase) {
  const first = String(phrase).trim().split(/\s+/)[0] || '';
  const acronym = /^[A-Z&]{2,}$/.test(first);
  const vowelSound = acronym ? /^[AEFHILMNORSX]/.test(first) : /^[aeiou]/i.test(first);
  return `${vowelSound ? 'an' : 'a'} ${phrase}`;
}

/** "Risk, compliance & IT audit" -> "risk, compliance & IT audit" (keeps acronyms). */
export function lowerLabel(label) {
  return label
    .split(' ')
    .map((w) => (/^[A-Z&]{2,}[,)]?$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

function isGoldman(company) {
  const c = cleanText(company);
  return /\bgoldman\s+sachs\b/i.test(c) || /^(?:goldman|gs)$/i.test(c);
}

const GS_DIVISION = {
  investment_banking: /global banking/i,
  markets: /^markets$/i,
  asset_wealth: /asset|wealth/i,
  risk_compliance: /risk|compliance|audit/i,
  operations: /operations/i,
  software: /engineering/i,
  data: /engineering|data/i,
  it_security: /engineering/i,
  accounting_audit: /controllers/i,
  corporate_finance: /controllers|finance/i,
};

/** For risk & compliance roles, the job title decides which Goldman division question fits. */
function gsDivisionFor(familyId, roleText = '') {
  if (familyId === 'risk_compliance') {
    if (/compliance|aml|kyc|anti-money|financial crime|regulatory/i.test(roleText)) return /compliance/i;
    if (/audit/i.test(roleText)) return /internal audit/i;
    return /^risk$/i;
  }
  return GS_DIVISION[familyId];
}
const FREQ_RANK = { 'very common': 0, common: 1, occasional: 2 };

function goldmanPool({ categories = null, maxFreq = 'common', familyId = 'general', divisionOnly = false, roleText = '' } = {}) {
  const division = gsDivisionFor(familyId, roleText);
  return GOLDMAN_REPORTED.filter((q) => {
    if (categories && !categories.includes(q.category)) return false;
    if ((FREQ_RANK[q.frequency] ?? 2) > FREQ_RANK[maxFreq]) return false;
    const general = !q.division || /general/i.test(q.division);
    if (divisionOnly) return Boolean(division && division.test(q.division || ''));
    return general || Boolean(division && division.test(q.division || ''));
  }).map((q) => ({ t: q.text, c: q.category }));
}

function competencyWhy(c, comp) {
  const times = c.hits > 1 ? ` (${c.hits} mentions)` : '';
  return `The posting stresses ${comp.phrase}${times}`;
}

/** Picks `need` likely questions in priority order, skipping near-duplicates. */
function pickLikely({ need, fam, analysis, ctx, rng, taken, goldman }) {
  const out = [];
  const catCount = new Map();
  for (const q of taken) catCount.set(q.category, (catCount.get(q.category) || 0) + 1);
  const limitFor = (cat) => (cat === 'technical' ? 2 : cat === 'other' ? 99 : 1);

  const accept = (raw, why) => {
    if (out.length >= need) return false;
    const item = normalizeItem(raw);
    const text = fillTemplate(item, ctx);
    if (!text) return false;
    const category = CATEGORIES.includes(item.c) ? item.c : classifyQuestion(text);
    if ((catCount.get(category) || 0) >= limitFor(category)) return false;
    const lower = text.toLowerCase();
    if ([...taken, ...out].some((q) => q.text.toLowerCase() === lower || similarity(q.text, text) >= 0.5)) return false;
    out.push({ text, category, why });
    catCount.set(category, (catCount.get(category) || 0) + 1);
    return true;
  };
  const tryList = (items, why) => items.some((it) => accept(it, why));

  const comps = (analysis?.competencies || []).filter((c) => COMPETENCY.has(c.id));
  const skills = analysis?.skills || [];
  const industry = analysis?.industry ? INDUSTRY.get(analysis.industry.id) : null;
  const famWhy = fam.id === 'general' ? 'A common interview question' : `Common in ${lowerLabel(fam.label)} interviews`;
  const famMotivation = fam.likely.filter((q) => normalizeItem(q).c === 'motivation_role');
  const famOther = fam.likely.filter((q) => normalizeItem(q).c !== 'motivation_role');

  const slots = [
    // 1. The opener
    () => tryList(rotate(UNIVERSAL.openers, rng, 2), 'Asked in almost every interview'),
    // 2. Why this company
    () =>
      (goldman && tryList(goldmanPool({ categories: ['motivation_company'], maxFreq: 'very common' }), GS_WHY)) ||
      tryList(rotate(UNIVERSAL.whyCompany, rng), ctx.company ? `Most interviews ask why you want to work at ${ctx.company}` : 'Asked in almost every interview'),
    // 3. Why this role or field
    () => {
      if (goldman && tryList(goldmanPool({ categories: ['motivation_role'], familyId: fam.id, divisionOnly: true, roleText: ctx.roleFull }), GS_WHY)) return true;
      const roleFirst = ctx.role && rng() < 0.6;
      const roleQs = UNIVERSAL.whyRole.slice(0, 2);
      const order = roleFirst ? [...rotate(roleQs, rng), ...famMotivation, UNIVERSAL.whyRole[2]] : [...famMotivation, ...rotate(roleQs, rng), UNIVERSAL.whyRole[2]];
      return tryList(order, ctx.role ? 'Most interviews ask why you want this role' : 'Asked in almost every interview');
    },
    // 4. What the posting stresses most
    () => (comps[0] ? tryList(rotate(COMPETENCY.get(comps[0].id).questions, rng), competencyWhy(comps[0], COMPETENCY.get(comps[0].id))) : false),
    // 5. Something specific to the role
    () => tryList(rotate(famOther, rng, 4), famWhy),
    // 6. The next thing the posting stresses (or teamwork, which nearly everyone asks)
    () =>
      comps[1]
        ? tryList(rotate(COMPETENCY.get(comps[1].id).questions, rng), competencyWhy(comps[1], COMPETENCY.get(comps[1].id)))
        : tryList(rotate(COMPETENCY.get('teamwork').questions, rng), 'Teamwork comes up in almost every interview'),
    // 7. A tool the posting asks for
    () => (skills[0] ? tryList(rotate(skillLikely(skills[0]), rng).map((t) => ({ t: t.replaceAll('{skill}', skills[0]), c: 'technical' })), `The posting asks for ${skills[0]}`) : false),
    // 8. A classic (Goldman: the confidentiality scenario candidates keep reporting)
    () =>
      (goldman && tryList(goldmanPool({ categories: ['behavioral_ethics', 'situational'], maxFreq: 'very common' }), GS_WHY)) ||
      tryList(rotate(UNIVERSAL.classics, rng), 'A classic interview question'),
    // 9. Industry awareness
    () =>
      goldman
        ? tryList(goldmanPool({ categories: ['commercial_awareness'], maxFreq: 'very common' }), GS_WHY)
        : industry
          ? tryList(rotate(industry.questions, rng), `Common for ${lowerLabel(industry.label)} employers`)
          : false,
    // 10+. More of the same, in rough order of how often they come up
    () => tryList(rotate(famOther, rng), famWhy),
    () => (comps[2] ? tryList(rotate(COMPETENCY.get(comps[2].id).questions, rng), competencyWhy(comps[2], COMPETENCY.get(comps[2].id))) : false),
    () => (goldman ? tryList(goldmanPool({ maxFreq: 'common', familyId: fam.id, roleText: ctx.roleFull }), GS_WHY) : false),
    () => tryList(rotate(UNIVERSAL.classics, rng), 'A classic interview question'),
    () => (skills[1] ? tryList(rotate(skillLikely(skills[1]), rng).map((t) => ({ t: t.replaceAll('{skill}', skills[1]), c: 'technical' })), `The posting asks for ${skills[1]}`) : false),
    () => tryList(rotate(FAMILY.get('general').likely, rng), 'A common interview question'),
    () => tryList(shuffle(COMPETENCIES.flatMap((c) => c.questions), rng), 'A common behavioral question'),
  ];
  for (let pass = 0; pass < 3 && out.length < need; pass += 1) {
    for (const slot of pass === 0 ? slots : slots.slice(4)) {
      if (out.length >= need) break;
      slot();
    }
  }
  return out;
}

function pickCurveball({ fam, analysis, ctx, rng, existing, goldman }) {
  const pool = [];
  const industry = analysis?.industry ? INDUSTRY.get(analysis.industry.id) : null;
  const skill = analysis?.skills?.[0];
  for (const c of fam.curveballs) pool.push({ item: c, weight: 3, why: `Curveball for ${lowerLabel(fam.label)} roles` });
  if (industry) for (const c of industry.curveballs) pool.push({ item: c, weight: 2, why: `Curveball for ${lowerLabel(industry.label)} employers` });
  if (skill) for (const t of skillCurveballs(skill)) pool.push({ item: t.replaceAll('{skill}', skill), weight: 1.2, why: `Curveball about ${skill}, which the posting asks for` });
  if (goldman) {
    for (const q of GOLDMAN_REPORTED.filter((g) => g.category === 'curveball')) {
      pool.push({ item: q.text, weight: 2, why: 'Reported as a surprise question in Goldman Sachs HireVue interviews' });
    }
  }
  for (const c of GENERIC_CURVEBALLS) pool.push({ item: c, weight: fam.id === 'general' ? 2 : 0.3, why: 'Curveball: tests how you think on your feet' });

  const candidates = pool
    .map((p) => ({ ...p, text: fillTemplate(p.item, ctx) }))
    .filter((p) => p.text && !existing.some((e) => e.toLowerCase() === p.text.toLowerCase() || similarity(e, p.text) >= 0.45));
  if (!candidates.length) return null;
  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  let r = rng() * total;
  for (const c of candidates) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return candidates[candidates.length - 1];
}

/**
 * Builds the interview.
 * Returns { questions: [{ id, text, prep, answer, source, category, why }], family, familyLabel, company, role }.
 */
export function buildInterview(options = {}) {
  const {
    userQuestions = [],
    analysis = null,
    company = '',
    role = '',
    family = '',
    likelyCount,
    includeCurveball = true,
    defaults = {},
    seed = 1,
  } = options || {};
  const rng = mulberry32(Number(seed) >>> 0 || 1);
  const def = {
    prep: toInt(defaults?.prep, 30, 0, 600),
    answer: toInt(defaults?.answer, 120, 5, 3600),
  };
  const a = analysis && typeof analysis === 'object' ? analysis : null;
  const familyId = FAMILY.has(family) ? family : FAMILY.has(a?.family) ? a.family : 'general';
  const fam = FAMILY.get(familyId);
  const companyName = cleanText(company) || cleanText(a?.company);
  const roleName = cleanText(role) || cleanText(a?.role);
  const ctx = { company: companyName, role: roleForTemplate(roleName), field: fam.field || '', roleFull: roleName };
  const goldman = isGoldman(companyName);

  const users = (Array.isArray(userQuestions) ? userQuestions : [])
    .map((q) => (typeof q === 'string' ? { text: q } : q))
    .filter((q) => q && typeof q.text === 'string' && tidy(q.text))
    .slice(0, 50)
    .map((q) => ({
      text: tidy(q.text).slice(0, 500),
      prep: toInt(q.prep, def.prep, 0, 600),
      answer: toInt(q.answer, def.answer, 5, 3600),
      source: 'user',
      category: classifyQuestion(q.text),
      why: '',
    }));

  let need;
  if (users.length) need = toInt(likelyCount, 0, 0, 20);
  else {
    need = toInt(likelyCount, 5, 0, 20) || 5;
    need = Math.max(3, need);
  }

  const picked = need
    ? pickLikely({ need, fam, analysis: a, ctx, rng, taken: users.map((q) => ({ text: q.text, category: q.category })), goldman })
    : [];
  const likely = picked.map((q) => ({ ...q, prep: def.prep, answer: def.answer, source: 'likely' }));

  // Openers go first; then your questions in your order; then the rest.
  const intros = likely.filter((q) => q.category === 'intro');
  const rest = likely.filter((q) => q.category !== 'intro');
  const list = [...intros, ...users, ...rest];

  if (includeCurveball) {
    const cb = pickCurveball({ fam, analysis: a, ctx, rng, existing: list.map((q) => q.text), goldman });
    if (cb) {
      const item = { text: cb.text, prep: def.prep, answer: def.answer, source: 'curveball', category: 'curveball', why: cb.why };
      const index = list.length <= 1 ? list.length : 1 + Math.floor(rng() * list.length);
      list.splice(index, 0, item);
    }
  }

  return {
    questions: list.map((q, i) => ({ id: `q${i + 1}`, ...q })),
    family: familyId,
    familyLabel: fam.label,
    company: companyName,
    role: roleName,
  };
}

// ---------- Example library ----------

function dedupe(questions) {
  const seen = new Set();
  return questions.filter((q) => {
    const key = q.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Groups for the "Browse examples" dialog. */
export function libraryFor({ family = 'general', company = '', role = '' } = {}) {
  const fam = FAMILY.get(family) || FAMILY.get('general');
  const ctx = { company: cleanText(company), role: roleForTemplate(role), field: fam.field || '' };
  const fillAll = (items, category) =>
    dedupe(
      items
        .map(normalizeItem)
        .map((it) => ({ text: fillTemplate(it, ctx), category: category || (CATEGORIES.includes(it.c) ? it.c : 'other') }))
        .filter((q) => q.text),
    );
  const groups = [
    {
      id: 'common',
      title: 'Most common',
      note: 'Asked in almost every interview.',
      questions: fillAll([UNIVERSAL.openers[0], UNIVERSAL.openers[1], UNIVERSAL.whyCompany[0], UNIVERSAL.whyRole[0], ...UNIVERSAL.classics, ...UNIVERSAL.motivationExtra.slice(1)]),
    },
  ];
  if (fam.id !== 'general') {
    groups.push({ id: 'role', title: `${fam.label} roles`, note: `Common in ${lowerLabel(fam.label)} interviews.`, questions: fillAll(fam.likely) });
  }
  groups.push(
    {
      id: 'goldman',
      title: 'Goldman Sachs HireVue',
      note: 'Reported by candidates on prep sites and forums. Wording varies.',
      questions: dedupe(GOLDMAN_REPORTED.map((q) => ({ text: q.text, category: CATEGORIES.includes(q.category) ? q.category : 'other' }))),
    },
    {
      id: 'behavioral',
      title: 'Behavioral',
      note: 'Answer with a real story: the situation, what you did, and the result.',
      questions: fillAll(COMPETENCIES.flatMap((c) => c.questions.slice(0, 2))),
    },
    {
      id: 'motivation',
      title: 'Motivation',
      note: '',
      questions: fillAll([...UNIVERSAL.whyCompany, ...UNIVERSAL.whyRole, ...UNIVERSAL.motivationExtra]),
    },
    {
      id: 'curveball',
      title: 'Curveball-style',
      note: 'Unexpected questions to practice thinking on your feet.',
      questions: fillAll([...fam.curveballs, ...GENERIC_CURVEBALLS], 'curveball').slice(0, 18),
    },
  );
  return groups.filter((g) => g.questions.length);
}
