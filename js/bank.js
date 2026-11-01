// The question bank: role families (three files), plus competencies the
// posting stresses, tools it names, the industry, and questions asked almost
// everywhere. Pure data; the logic lives in engine.js.
import { ROLES_A } from './bank-roles-a.js';
import { ROLES_B } from './bank-roles-b.js';
import { ROLES_C } from './bank-roles-c.js';

/** Display order for the "Role type" picker. 'general' is last. */
export const ROLE_FAMILIES = [...ROLES_A, ...ROLES_B, ...ROLES_C];

/** What a posting can stress. `signals` are matched as whole words (prefix* allowed). */
export const COMPETENCIES = [
  {
    id: 'teamwork',
    label: 'Teamwork',
    phrase: 'teamwork and collaboration',
    signals: ['teamwork', 'team player', 'collaborat*', 'cross-functional', 'partner with', 'work closely with'],
    questions: [
      ['Tell me about a time you worked on a team to reach a difficult goal. What was your role?', 'behavioral_teamwork'],
      ['Tell me about a time a teammate did not pull their weight. What did you do?', 'behavioral_teamwork'],
      ['Tell me about a time you worked with another team or department to get something done.', 'behavioral_teamwork'],
    ],
  },
  {
    id: 'leadership',
    label: 'Leadership',
    phrase: 'leadership and ownership',
    signals: ['leadership', 'lead projects', 'take ownership', 'ownership', 'mentor*', 'influence others', 'drive results'],
    questions: [
      ['Tell me about a time you led a team or a project.', 'behavioral_leadership'],
      ['Tell me about a time you stepped up when no one else would.', 'behavioral_leadership'],
      ['Tell me about a time you motivated people who did not report to you.', 'behavioral_leadership'],
    ],
  },
  {
    id: 'communication',
    label: 'Communication',
    phrase: 'communication skills',
    signals: ['communicat*', 'presentation*', 'present findings', 'written and verbal', 'verbal and written', 'stakeholder*', 'articulate', 'storytelling'],
    questions: [
      ['Tell me about a time you explained something complicated to someone without your background.', 'behavioral_communication'],
      ['Tell me about a time you persuaded someone who disagreed with you.', 'behavioral_communication'],
      ['Tell me about a presentation you gave. How did you prepare, and how did it go?', 'behavioral_communication'],
    ],
  },
  {
    id: 'problem_solving',
    label: 'Problem solving',
    phrase: 'problem solving',
    signals: ['problem-solving', 'problem solving', 'solve problems', 'analytical', 'critical thinking', 'troubleshoot*', 'root cause'],
    questions: [
      ['Tell me about the hardest problem you have solved. How did you approach it?', 'behavioral_challenge'],
      ['Describe a time you had to make a decision with incomplete information.', 'behavioral_challenge'],
      ['Tell me about a time your first solution did not work. What did you do next?', 'behavioral_challenge'],
    ],
  },
  {
    id: 'detail',
    label: 'Attention to detail',
    phrase: 'attention to detail',
    signals: ['attention to detail', 'detail-oriented', 'detail oriented', 'accuracy', 'accurate', 'meticulous', 'precision', 'thorough'],
    questions: [
      ['Describe a time you caught an error or prevented a mistake through your attention to detail.', 'behavioral_detail'],
      ['How do you double-check your work when the stakes are high?', 'behavioral_detail'],
      ['Tell me about a time a small detail made a big difference.', 'behavioral_detail'],
    ],
  },
  {
    id: 'pressure',
    label: 'Working under pressure',
    phrase: 'a fast-paced environment',
    signals: ['fast-paced', 'fast paced', 'deadline*', 'under pressure', 'multiple priorities', 'competing priorities', 'multitask*', 'multi-task*', 'high-volume', 'high volume', 'demanding'],
    questions: [
      ['Tell me about a time you succeeded despite being under intense pressure.', 'behavioral_pressure'],
      ['How do you prioritize when you are facing conflicting deadlines?', 'behavioral_pressure'],
      ['Tell me about a time you had too much to do and not enough time. What did you let go of, and why?', 'behavioral_pressure'],
    ],
  },
  {
    id: 'client',
    label: 'Client focus',
    phrase: 'working with clients and customers',
    signals: ['client-facing', 'customer-facing', 'client service', 'customer service', 'client relationships', 'customer experience', 'clients', 'customers'],
    questions: [
      ['Tell me about a time you went above and beyond for a client or customer.', 'behavioral_initiative'],
      ['Tell me about a time you dealt with a difficult client or customer.', 'behavioral_conflict'],
      ['Tell me about a time you had to say no to a customer while keeping the relationship strong.', 'behavioral_communication'],
    ],
  },
  {
    id: 'adaptability',
    label: 'Adaptability',
    phrase: 'adapting to change',
    signals: ['ambiguity', 'ambiguous', 'adaptab*', 'adapt to', 'flexib*', 'changing priorities', 'dynamic environment', 'evolving'],
    questions: [
      ['Tell me about a time plans changed at the last minute. How did you adapt?', 'behavioral_challenge'],
      ['Tell me about a time you had to work without clear instructions.', 'behavioral_challenge'],
      ['Tell me about a big change you went through and how you handled it.', 'behavioral_learning'],
    ],
  },
  {
    id: 'initiative',
    label: 'Initiative',
    phrase: 'taking initiative',
    signals: ['self-starter', 'self starter', 'initiative', 'proactive*', 'entrepreneurial', 'self-motivated', 'independently', 'go-getter'],
    questions: [
      ['Tell me about a time you took initiative without being asked.', 'behavioral_initiative'],
      ['Tell me about something you started from scratch.', 'behavioral_initiative'],
      ['Tell me about a time you went beyond what was expected of you.', 'behavioral_initiative'],
    ],
  },
  {
    id: 'learning',
    label: 'Learning quickly',
    phrase: 'learning quickly',
    signals: ['learn quickly', 'quick learner', 'eager to learn', 'curious', 'curiosity', 'growth mindset', 'continuous learning', 'willingness to learn', 'coachable'],
    questions: [
      ['Tell me about a time you had to learn something new very quickly.', 'behavioral_learning'],
      ['Tell me about a time you received feedback that changed how you work.', 'behavioral_learning'],
      ['What is something you taught yourself recently, and how did you do it?', 'behavioral_learning'],
    ],
  },
  {
    id: 'ethics',
    label: 'Integrity',
    phrase: 'integrity and confidentiality',
    signals: ['integrity', 'ethical', 'ethics', 'confidential*', 'trustworth*', 'honesty', 'code of conduct', 'discretion'],
    questions: [
      ['Tell me about a time you did the right thing when it was not the easy thing.', 'behavioral_ethics'],
      ['What would you do if someone shared confidential information with you and your boss asked you about it?', 'behavioral_ethics'],
      ['Tell me about a time you saw something that did not seem right. What did you do?', 'behavioral_ethics'],
    ],
  },
  {
    id: 'innovation',
    label: 'Improving things',
    phrase: 'improving how things work',
    signals: ['innovat*', 'creativ*', 'continuous improvement', 'process improvement', 'improve processes', 'automat*', 'streamline', 'efficiencies'],
    questions: [
      ['Tell me about a time you made a process more efficient.', 'behavioral_initiative'],
      ['Tell me about an idea you had that others adopted.', 'behavioral_initiative'],
      ['Tell me about a time you simplified something that was tedious or confusing.', 'behavioral_initiative'],
    ],
  },
  {
    id: 'data_driven',
    label: 'Using data',
    phrase: 'using data to make decisions',
    signals: ['data-driven', 'data driven', 'metrics', 'quantitative', 'insights', 'kpis', 'kpi', 'measurable'],
    questions: [
      ['Tell me about a time you used data to make a decision.', 'behavioral_communication'],
      ['Tell me about a time the numbers changed your mind.', 'behavioral_learning'],
      ['How do you decide which numbers matter most when you track progress?', 'technical'],
    ],
  },
  {
    id: 'organization',
    label: 'Organization and prioritizing',
    phrase: 'staying organized',
    signals: ['organized', 'organizational skills', 'organization skills', 'prioritiz*', 'time management', 'manage multiple', 'planning'],
    questions: [
      ['How do you keep track of everything when you are juggling several projects?', 'behavioral_pressure'],
      ['Tell me about a time you planned something complex from start to finish.', 'behavioral_initiative'],
      ['Tell me about a time you missed a deadline. What did you change afterward?', 'behavioral_failure'],
    ],
  },
];

/**
 * Tools and skills to look for. `re` is a regular expression source; `cs`
 * means case-sensitive (for names like R, SAS, SAP and Epic that are also words).
 */
export const SKILLS = [
  { name: 'SQL', re: '\\b(?:sql|postgres(?:ql)?|mysql|t-sql|pl\\/sql)\\b' },
  { name: 'Python', re: '\\bpython\\b' },
  { name: 'R', re: '(?:\\b(?:in|using|with|and|or)\\s+R\\b(?![\\-&])|\\bR(?=\\s*(?:,|\\/|\\)|and\\b|or\\b|programming|Studio))|\\bRStudio\\b)', cs: true },
  { name: 'Excel', re: '\\b(?:Excel\\b(?!\\s+(?:in|at)\\b)|VLOOKUPs?|vlookups?|[Pp]ivot [Tt]ables?|XLOOKUP)', cs: true },
  { name: 'Tableau', re: '\\btableau\\b' },
  { name: 'Power BI', re: '\\bpower\\s?bi\\b' },
  { name: 'Looker', re: '\\blooker\\b' },
  { name: 'Snowflake', re: '\\bsnowflake\\b' },
  { name: 'Databricks', re: '\\bdatabricks\\b' },
  { name: 'dbt', re: '\\bdbt\\b' },
  { name: 'Airflow', re: '\\bairflow\\b' },
  { name: 'Spark', re: '\\b(?:Apache\\s+)?Spark\\b(?!\\s+(?:curiosity|joy|interest|conversations?|ideas?|change|innovation|creativity))', cs: true },
  { name: 'AWS', re: '\\b(?:aws|amazon web services)\\b' },
  { name: 'Azure', re: '\\bazure\\b' },
  { name: 'Google Cloud', re: '\\b(?:gcp|google cloud)\\b' },
  { name: 'Java', re: '(?<!cup of\\s)\\bJava\\b(?!\\s*Script)', cs: true },
  { name: 'JavaScript', re: '\\bjavascript\\b' },
  { name: 'TypeScript', re: '\\btypescript\\b' },
  { name: 'C++', re: '\\bc\\+\\+' },
  { name: 'C#', re: '\\bc#' },
  { name: 'Go', re: '\\b(?:[Gg]olang|Go(?=\\s+(?:language|programming)))\\b', cs: true },
  { name: 'React', re: '\\bReact(?:\\.js|JS)?\\b(?!\\s+(?:to|quickly|calmly|fast|appropriately)\\b)', cs: true },
  { name: 'Node.js', re: '\\bnode(?:\\.js|js)\\b' },
  { name: 'Git', re: '\\bgit(?:hub|lab)?\\b' },
  { name: 'Docker', re: '\\bdocker\\b' },
  { name: 'Kubernetes', re: '\\bkubernetes\\b' },
  { name: 'Linux', re: '\\blinux\\b' },
  { name: 'machine learning', re: '\\bmachine learning\\b', kind: 'knowledge' },
  { name: 'statistics', re: '\\bstatistic(?:s|al)\\b', kind: 'knowledge' },
  { name: 'SAS', re: '\\bSAS\\b', cs: true },
  { name: 'SPSS', re: '\\bspss\\b' },
  { name: 'Stata', re: '\\bstata\\b' },
  { name: 'MATLAB', re: '\\bmatlab\\b' },
  { name: 'Salesforce', re: '\\bsalesforce\\b' },
  { name: 'HubSpot', re: '\\bhubspot\\b' },
  { name: 'SAP', re: '\\bSAP\\b', cs: true },
  { name: 'Workday', re: '\\bWorkday\\b(?!\\s+(?:starts|begins|ends|hours))', cs: true },
  { name: 'Jira', re: '\\bjira\\b' },
  { name: 'ServiceNow', re: '\\bservicenow\\b' },
  { name: 'financial modeling', re: '\\bfinancial model(?:ing|ling|s)?\\b', kind: 'knowledge' },
  { name: 'valuation', re: '\\bvaluations?\\b', kind: 'knowledge' },
  { name: 'Bloomberg', re: '\\bbloomberg\\b' },
  { name: 'VBA', re: '\\bvba\\b' },
  { name: 'GAAP', re: '\\b(?:us\\s+)?gaap\\b', kind: 'knowledge' },
  { name: 'Figma', re: '\\bfigma\\b' },
  { name: 'Adobe Creative Suite', re: '\\b(?:adobe|photoshop|illustrator|indesign)\\b' },
  { name: 'Google Analytics', re: '\\bgoogle analytics\\b' },
  { name: 'SEO', re: '\\bseo\\b', kind: 'knowledge' },
  { name: 'AutoCAD', re: '\\bautocad\\b' },
  { name: 'SolidWorks', re: '\\bsolidworks\\b' },
  { name: 'Epic', re: '\\bEpic\\b(?=\\s*(?:EHR|EMR|system|certif|charting|\\/|,|\\)))', cs: true },
];

export const SKILL_LIKELY = [
  'Tell me about a project where you used {skill}. What was the result?',
  'The role uses {skill} a lot. Walk me through something you built or analyzed with it.',
  'How did you learn {skill}, and how would you rate your skill level today?',
];

/** For knowledge areas (GAAP, valuation, statistics...) rather than hands-on tools. */
export const KNOWLEDGE_LIKELY = [
  'Where have you used {skill}, in class or at work? Walk me through an example.',
  'The posting mentions {skill}. How comfortable are you with it, and how did you learn it?',
];

export const KNOWLEDGE_CURVEBALLS = [
  'Explain {skill} to someone outside the field, in under a minute.',
  'What is a common misunderstanding about {skill}?',
];

export const SKILL_CURVEBALLS = [
  'Explain {skill} to someone who has never heard of it.',
  'What is something {skill} is bad at, and what would you use instead?',
  'Teach me one {skill} trick that saves you time.',
];

/** Industries, detected mostly from the company description. */
export const INDUSTRIES = [
  {
    id: 'financial_services',
    label: 'Financial services',
    keywords: ['bank', 'banking', 'financial services', 'financial markets', 'asset management', 'wealth management', 'wealth', 'securities', 'investment', 'insurance company', 'insurance carrier', 'insurer', 'fintech', 'payments', 'lending', 'credit union', 'credit card', 'capital markets', 'brokerage', 'financial institution', 'investment bank', 'investors'],
    questions: [
      ['Talk about a recent event that affected the financial markets.', 'commercial_awareness'],
      ['How do you think AI will change financial services over the next five years?', 'commercial_awareness'],
      { t: 'How does {company} make money?', a: 'How does a company like this make money?', c: 'commercial_awareness' },
    ],
    curveballs: [
      'If interest rates dropped two points tomorrow, who would win and who would lose?',
      'Explain what a bank does with your deposit, to a ten-year-old.',
      'What is a finance app you use, and what should traditional banks learn from it?',
    ],
  },
  {
    id: 'technology',
    label: 'Technology',
    keywords: ['software', 'saas', 'cloud', 'platform', 'technology company', 'tech company', 'startup', 'artificial intelligence', 'digital products', 'apps'],
    questions: [
      ['What technology trend do you think will matter most to customers in the next few years?', 'commercial_awareness'],
      ['What tech product do you admire, and why?', 'commercial_awareness'],
    ],
    curveballs: ['How would you explain AI to your grandparents?', 'What technology do you think will be gone in ten years?'],
  },
  {
    id: 'healthcare',
    label: 'Healthcare',
    keywords: ['hospital', 'hospitals', 'health system', 'healthcare', 'health care', 'patients', 'clinic', 'medical center', 'pharmaceutical', 'biotech', 'health plan'],
    questions: [
      ['What challenge facing healthcare right now interests you most?', 'commercial_awareness'],
      ['How would you keep patients at the center of your work in this role?', 'motivation_role'],
    ],
    curveballs: ['If you could change one thing about going to the doctor, what would it be?', 'How should a hospital decide what new technology to buy?'],
  },
  {
    id: 'retail_consumer',
    label: 'Retail & consumer',
    keywords: ['retail', 'retailer', 'stores', 'consumer', 'consumers', 'e-commerce', 'ecommerce', 'brands', 'restaurant', 'restaurants', 'hospitality', 'hotel', 'grocery', 'apparel'],
    questions: [
      ['What store or brand gives a great customer experience, and why?', 'commercial_awareness'],
      ['How do you think shopping will change over the next five years?', 'commercial_awareness'],
    ],
    curveballs: ['Why do you think some stores are always busy while the one next door is empty?', 'What would you change about the last store you visited?'],
  },
  {
    id: 'consulting_professional',
    label: 'Consulting & professional services',
    keywords: ['consulting', 'advisory', 'professional services', 'big four', 'accounting firm', 'law firm', 'engagements', 'clients across industries'],
    questions: [
      ['What business problem have you read about recently that you would love to work on?', 'commercial_awareness'],
      { t: 'How would you explain the value of {company} to a potential client?', a: 'How would you explain the value of a firm like this to a potential client?', c: 'commercial_awareness' },
    ],
    curveballs: ['Which industry do you think is ready to be disrupted, and why?', 'If you could advise any CEO for a day, who would it be and what would you tell them?'],
  },
  {
    id: 'government_public',
    label: 'Government & public sector',
    keywords: ['government agency', 'federal agency', 'state agency', 'public sector', 'county', 'city of', 'municipal', 'public service', 'taxpayers', 'constituents'],
    questions: [
      ['Why do you want to serve the public?', 'motivation_role'],
      ['How would you make a government service easier to use?', 'situational'],
    ],
    curveballs: ['What government service do you think works really well?', 'If you could change one rule in your city, what would it be?'],
  },
  {
    id: 'education',
    label: 'Education',
    keywords: ['school', 'school district', 'k-12', 'campus', 'higher education', 'academic institution', 'classrooms', 'teachers'],
    questions: [
      ['What do you think makes a school or program successful?', 'commercial_awareness'],
      ['How has education changed since you were a student?', 'commercial_awareness'],
    ],
    curveballs: ['What is the most useful thing you learned outside a classroom?', 'How would you redesign the first day of school?'],
  },
  {
    id: 'manufacturing_industrial',
    label: 'Manufacturing & industrial',
    keywords: ['manufacturing', 'manufacturer', 'plant', 'factory', 'production', 'industrial', 'assembly', 'fabrication', 'aerospace', 'automotive'],
    questions: [
      ['How do you think automation will change manufacturing jobs?', 'commercial_awareness'],
      ['Why does safety culture matter on a production floor?', 'behavioral_ethics'],
    ],
    curveballs: ['How would you cut waste in a factory you have never seen?', 'What everyday product would you love to see being made?'],
  },
  {
    id: 'energy_utilities',
    label: 'Energy & utilities',
    keywords: ['energy', 'utility', 'utilities', 'oil', 'natural gas', 'renewable', 'renewables', 'solar', 'wind', 'power generation', 'grid'],
    questions: [
      ['What energy trend are you following, and why does it matter?', 'commercial_awareness'],
      ['How should an energy company balance cost and sustainability?', 'commercial_awareness'],
    ],
    curveballs: ['How would you explain where electricity comes from to a child?', 'What would you do to cut a city\'s energy use by 10%?'],
  },
  {
    id: 'media_entertainment',
    label: 'Media & entertainment',
    keywords: ['media', 'entertainment', 'publishing', 'streaming', 'broadcast', 'film', 'music', 'gaming', 'newsroom', 'studio'],
    questions: [
      ['What show, game or story do you think was marketed brilliantly?', 'commercial_awareness'],
      ['How are people\'s media habits changing?', 'commercial_awareness'],
    ],
    curveballs: ['Pitch me a new show in 60 seconds.', 'What did you watch or read recently that changed your mind about something?'],
  },
];

/** Asked almost everywhere. */
export const UNIVERSAL = {
  openers: [
    ['Tell me about yourself.', 'intro'],
    ['Walk me through your resume.', 'intro'],
    ['Tell me about yourself and why you applied for this role.', 'intro'],
  ],
  whyCompany: [
    { t: 'Why do you want to work at {company}?', a: 'Why do you want to work for this company?', c: 'motivation_company' },
    { t: 'What attracts you to {company} in particular?', a: 'What attracts you to this company in particular?', c: 'motivation_company' },
    { t: 'Why {company}, and why now?', a: 'Why this company, and why now?', c: 'motivation_company' },
  ],
  whyRole: [
    { t: 'Why are you interested in this {role} role?', a: 'Why are you interested in this role?', c: 'motivation_role' },
    { t: 'What about the {role} position appeals to you most?', a: 'What about this position appeals to you most?', c: 'motivation_role' },
    { t: 'Why do you want to work in {field}?', a: 'Why are you interested in this kind of work?', c: 'motivation_role' },
  ],
  classics: [
    ['Tell me about a time you failed. What did you do about it, and what did you learn?', 'behavioral_failure'],
    ['Tell me about a time you had a conflict with someone. How did you resolve it?', 'behavioral_conflict'],
    ['What is your greatest strength, and how has it helped you?', 'strengths_weaknesses'],
    ['Tell me about a challenge you overcame.', 'behavioral_challenge'],
    ['What is your biggest weakness, and how are you working on it?', 'strengths_weaknesses'],
    ['Tell me about a time you showed leadership.', 'behavioral_leadership'],
  ],
  motivationExtra: [
    { t: 'What do you know about {company}?', a: 'What do you know about our company?', c: 'motivation_company' },
    ['Where do you see yourself in five years?', 'motivation_role'],
    ['What are you looking for in your next role?', 'motivation_role'],
    ['Why should we hire you over other candidates?', 'strengths_weaknesses'],
  ],
};

/** Curveballs that work for any role. */
export const GENERIC_CURVEBALLS = [
  'What is something you believed strongly a few years ago that you have changed your mind about?',
  'If you had to teach a class on anything, what would it be?',
  'What is a skill you taught yourself, and how did you learn it?',
  'Describe yourself in three words, then explain one of them.',
  'If you were interviewing yourself, what question would you ask, and how would you answer it?',
  'What book, article or podcast changed how you think?',
  'Tell me about something that is not on your resume.',
  'What would your closest friend say is your biggest flaw?',
  'What problem in the world would you most like to solve?',
  'If you could have dinner with anyone, living or not, who would it be and what would you ask?',
  'What is the hardest decision you have made in the last year?',
  'Tell me about a time you were wrong about someone.',
  'What are you curious about right now?',
  'How would you explain what you studied to a five-year-old?',
  { t: 'What is an unpopular opinion you hold about {field}?', a: 'What is an unpopular opinion you hold about your field?' },
  'If you got this job, what is the first thing you would want to learn?',
  'Tell me about a time you changed your mind after hearing someone out.',
];

/** Words ignored when comparing two questions. */
export const STOPWORDS = new Set(
  ('a an and or but of to in on at for with about from by as is are was were be been being it its this that these those ' +
    'you your yours i me my we us our they them their he she his her tell describe give share walk through time when ' +
    'what how why which who whom did do does done would could should will can have has had example some any one so if ' +
    'then than there here into out up down over very really just more most other others someone something thing things ' +
    'get got make made like want please question answer let lets also all not no yes way ever recent recently')
    .split(/\s+/),
);
