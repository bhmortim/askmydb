'use strict';

// Builds demo/demo.sqlite — a sample visa-applications dataset — so you can
// try askmydb without touching a real database.  Run:  npm run demo
// Requires Node 22.5+ (node:sqlite). On Node 22.5–23.3 add --experimental-sqlite.

const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('The demo needs the built-in node:sqlite module (Node 22.5+, Node 24 recommended).');
  console.error('On Node 22.5-23.3 run: node --experimental-sqlite demo/make-demo-db.js');
  process.exit(1);
}

const OUT = path.join(__dirname, 'demo.sqlite');
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

// deterministic pseudo-random so everyone gets the same demo
let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const weighted = (pairs) => {
  let r = rand() * pairs.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
  return pairs[0][0];
};

const db = new DatabaseSync(OUT);
db.exec(`
  CREATE TABLE employers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    industry TEXT NOT NULL
  );
  CREATE TABLE visa_applications (
    id INTEGER PRIMARY KEY,
    employer_id INTEGER NOT NULL REFERENCES employers(id),
    job_title TEXT NOT NULL,
    base_salary INTEGER NOT NULL,
    worksite_city TEXT NOT NULL,
    worksite_state TEXT NOT NULL,
    visa_class TEXT NOT NULL,
    status TEXT NOT NULL,
    submitted_date TEXT NOT NULL,
    decision_date TEXT
  );
  CREATE INDEX idx_app_employer ON visa_applications(employer_id);
  CREATE INDEX idx_app_state ON visa_applications(worksite_state);
  CREATE INDEX idx_app_status ON visa_applications(status);
`);

const CITIES = [
  ['Austin', 'TX'], ['Dallas', 'TX'], ['Houston', 'TX'],
  ['San Francisco', 'CA'], ['San Jose', 'CA'], ['Los Angeles', 'CA'],
  ['New York', 'NY'], ['Seattle', 'WA'], ['Redmond', 'WA'],
  ['Chicago', 'IL'], ['Atlanta', 'GA'], ['Boston', 'MA'],
  ['Denver', 'CO'], ['Phoenix', 'AZ'], ['Raleigh', 'NC'],
  ['Jersey City', 'NJ'], ['Miami', 'FL'], ['Columbus', 'OH']
];
const NAME_A = ['Apex', 'Blue Summit', 'Cedar', 'Digital', 'Everline', 'Fusion', 'Global', 'Horizon', 'Ironwood', 'Juniper', 'Keystone', 'Lakeshore', 'Meridian', 'Northbridge', 'Orchard', 'Pinnacle', 'Quantum', 'Redwood', 'Sterling', 'Titan'];
const NAME_B = ['Systems', 'Technologies', 'Consulting', 'Software', 'Analytics', 'Solutions', 'Labs', 'Data Group', 'Networks', 'Partners'];
const INDUSTRIES = ['IT Services', 'Software', 'Finance', 'Healthcare', 'Engineering', 'Education'];
const TITLES = [
  ['Software Engineer', 95000, 165000],
  ['Senior Software Engineer', 125000, 205000],
  ['Data Analyst', 70000, 115000],
  ['Data Scientist', 105000, 185000],
  ['Systems Analyst', 72000, 120000],
  ['Database Administrator', 85000, 140000],
  ['QA Engineer', 70000, 120000],
  ['Product Manager', 115000, 190000],
  ['DevOps Engineer', 105000, 175000],
  ['Business Analyst', 68000, 118000]
];
const STATUSES = [['Certified', 71], ['Denied', 9], ['Withdrawn', 8], ['Certified-Withdrawn', 7], ['Pending', 5]];
const VISA_CLASSES = [['H-1B', 88], ['H-1B1 Chile', 3], ['H-1B1 Singapore', 3], ['E-3 Australian', 6]];

const insertEmployer = db.prepare('INSERT INTO employers (name, city, state, industry) VALUES (?, ?, ?, ?)');
const employerHome = [];
for (let i = 0; i < 60; i++) {
  const [city, state] = pick(CITIES);
  insertEmployer.run(`${pick(NAME_A)} ${pick(NAME_B)}`, city, state, pick(INDUSTRIES));
  employerHome.push([city, state]);
}

const DAY = 86400000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

const insertApp = db.prepare(`INSERT INTO visa_applications
  (employer_id, job_title, base_salary, worksite_city, worksite_state, visa_class, status, submitted_date, decision_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

db.exec('BEGIN');
for (let i = 0; i < 3000; i++) {
  const employerId = 1 + Math.floor(rand() * 60);
  const [title, lo, hi] = pick(TITLES);
  const salary = Math.round((lo + rand() * (hi - lo)) / 500) * 500;
  // most worksites match the employer's home city; some are elsewhere
  const [city, stateCode] = rand() < 0.7 ? employerHome[employerId - 1] : pick(CITIES);
  const status = weighted(STATUSES);
  const submitted = now - Math.floor(rand() * 730) * DAY;
  const decided = status === 'Pending' ? null : submitted + Math.floor(7 + rand() * 90) * DAY;
  insertApp.run(
    employerId, title, salary, city, stateCode,
    weighted(VISA_CLASSES), status,
    iso(submitted), decided ? iso(Math.min(decided, now)) : null
  );
}
db.exec('COMMIT');

const employers = db.prepare('SELECT COUNT(*) AS c FROM employers').get().c;
const apps = db.prepare('SELECT COUNT(*) AS c FROM visa_applications').get().c;
db.close();

console.log('');
console.log(`  Demo database created: ${OUT}`);
console.log(`  ${employers} employers, ${apps} visa applications (last 24 months)`);
console.log('');
console.log('  Next: npm start, then connect with');
console.log('    Database type: SQLite');
console.log(`    File path:     ${OUT}`);
console.log('');
console.log('  Try asking: "Which state has the most applications?"');
console.log('');
