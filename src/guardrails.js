'use strict';

// ---------------------------------------------------------------------------
// Read-only SQL guardrails.
//
// Defense in depth — the layers, from strongest to weakest:
//   1. The database session itself is opened read-only (see src/db/*).
//   2. This validator rejects anything that isn't a single read-only statement.
//   3. Row caps and query timeouts bound runaway queries.
//   4. README tells you to connect with a read-only database user anyway.
//
// The validator works on a "skeleton" of the query: string literals, quoted
// identifiers and comments are stripped first, so keywords hidden inside
// strings/backticks don't false-positive, and keywords smuggled through
// comments ("SEL/**/ECT") don't survive.
// ---------------------------------------------------------------------------

const ALLOWED_STARTS = ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'TABLE'];

// Statement starts that we row-limit. VALUES and TABLE (Postgres) both accept
// a trailing LIMIT, same as SELECT/WITH.
const LIMITABLE_STARTS = ['SELECT', 'WITH', 'VALUES', 'TABLE'];

// Rejected anywhere in the statement. Catches writable CTEs
// (WITH x AS (DELETE ...) SELECT ...), SELECT INTO, EXPLAIN ANALYZE of a
// write, and friends.
const FORBIDDEN_KEYWORDS = [
  // data modification
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'UPSERT', 'TRUNCATE',
  // schema / server administration
  'DROP', 'ALTER', 'CREATE', 'RENAME', 'GRANT', 'REVOKE',
  'VACUUM', 'REINDEX', 'ANALYZE', 'OPTIMIZE', 'REPAIR', 'FLUSH', 'PURGE',
  'RESET', 'CLUSTER', 'REFRESH', 'CHECKPOINT', 'SHUTDOWN', 'KILL',
  'INSTALL', 'UNINSTALL',
  // statement execution / side effects
  'CALL', 'DO', 'EXEC', 'EXECUTE', 'PREPARE', 'DEALLOCATE', 'DECLARE',
  'HANDLER', 'SET', 'LOCK', 'UNLOCK', 'ATTACH', 'DETACH', 'PRAGMA',
  'COPY', 'IMPORT', 'LOAD', 'NOTIFY', 'LISTEN', 'UNLISTEN',
  // file access / exfiltration ("INTO" covers SELECT INTO + INTO OUTFILE)
  'OUTFILE', 'DUMPFILE', 'INFILE', 'INTO'
];

// Function calls with side effects, file access, or denial-of-service value.
// Matched as NAME( so plain columns that happen to share a name still work.
const FORBIDDEN_FUNCTIONS = [
  // MySQL
  'LOAD_FILE', 'BENCHMARK', 'SLEEP', 'GET_LOCK', 'RELEASE_LOCK',
  'RELEASE_ALL_LOCKS', 'MASTER_POS_WAIT', 'WAIT_FOR_EXECUTED_GTID_SET',
  // PostgreSQL
  'PG_SLEEP', 'PG_SLEEP_FOR', 'PG_SLEEP_UNTIL', 'PG_READ_FILE',
  'PG_READ_BINARY_FILE', 'PG_LS_DIR', 'PG_STAT_FILE', 'LO_IMPORT',
  'LO_EXPORT', 'LO_CREATE', 'LO_UNLINK', 'LO_GET', 'LO_PUT',
  'PG_LS_WALDIR', 'PG_LS_LOGDIR', 'PG_LS_TMPDIR',
  'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND',
  'PG_RELOAD_CONF', 'PG_ROTATE_LOGFILE', 'SET_CONFIG',
  'PG_CREATE_RESTORE_POINT', 'PG_SWITCH_WAL', 'PG_PROMOTE',
  // dblink family is covered wholesale by a pattern below
  // SQLite
  'READFILE', 'WRITEFILE', 'LOAD_EXTENSION', 'FTS3_TOKENIZER', 'EDIT',
  // SQL Server (not supported, but cheap to deny)
  'XP_CMDSHELL', 'SP_EXECUTESQL', 'OPENROWSET', 'OPENQUERY'
];

const FORBIDDEN_PATTERNS = [
  { re: /\bFOR\s+UPDATE\b/i, label: 'FOR UPDATE' },
  { re: /\bFOR\s+(NO\s+KEY\s+)?SHARE\b/i, label: 'FOR SHARE' },
  { re: /\bFOR\s+(NO\s+)?KEY\s+(UPDATE|SHARE)\b/i, label: 'row locking clause' },
  // whole dblink_* family (dblink_send_query, dblink_open, …), not just dblink()
  { re: /\bdblink\w*\s*\(/i, label: 'dblink function' }
];

// SHOW CREATE TABLE|VIEW|… is a read-only introspection query whose object type
// keyword (CREATE) would otherwise trip the forbidden-keyword scan.
const SHOW_CREATE_RE = /^\s*SHOW\s+CREATE\s+(TABLE|VIEW|PROCEDURE|FUNCTION|TRIGGER|EVENT|DATABASE|SCHEMA|USER)\b/i;

/**
 * Remove string literals, quoted identifiers and comments so keyword checks
 * can't be fooled. Returns { skeleton } or { error }.
 */
function stripLiteralsAndComments(sql, dialect) {
  const out = [];
  const n = sql.length;
  let i = 0;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // -- line comment (all dialects)
    if (ch === '-' && next === '-') {
      const j = sql.indexOf('\n', i);
      out.push(' ');
      i = j === -1 ? n : j;
      continue;
    }

    // # line comment (MySQL)
    if (ch === '#' && dialect === 'mysql') {
      const j = sql.indexOf('\n', i);
      out.push(' ');
      i = j === -1 ? n : j;
      continue;
    }

    // /* block comment */ — Postgres allows nesting, so track depth there
    if (ch === '/' && next === '*') {
      // MySQL executable comments (/*! ... */, /*!50000 ... */) and optimizer
      // hints (/*+ ... */) are NOT comments — the server RUNS their contents.
      // Blanking them would hide smuggled keywords (e.g. /*!UNION SELECT
      // load_file(...)*/) from the deny lists. Reject outright — fail closed.
      const marker = sql[i + 2];
      if (marker === '!' || marker === '+') {
        return { error: 'Executable or optimizer comments (/*! … */, /*+ … */) are not allowed' };
      }
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (dialect === 'postgres' && sql[j] === '/' && sql[j + 1] === '*') {
          depth++; j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--; j += 2;
        } else {
          j++;
        }
      }
      if (depth > 0) return { error: 'Unterminated comment' };
      out.push(' ');
      i = j;
      continue;
    }

    // quoted strings and identifiers: '...', "...", `...`
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      // Postgres E'...' escape strings honor backslash escapes (the E prefix
      // must be a standalone token right before the quote).
      const isEString = quote === "'" && dialect === 'postgres' &&
        i > 0 && /[Ee]/.test(sql[i - 1]) && (i < 2 || /[^A-Za-z0-9_]/.test(sql[i - 2]));
      const backslashEscapes =
        (dialect === 'mysql' && (quote === "'" || quote === '"')) || isEString;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        // strings that honor backslash escapes: skip the escaped char
        if (sql[j] === '\\' && backslashEscapes) {
          j += 2;
          continue;
        }
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue; } // doubled-quote escape
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (!closed) return { error: 'Unterminated quoted string or identifier' };
      out.push(quote + quote); // keep an empty placeholder so tokens stay separated
      i = j;
      continue;
    }

    // [bracket identifiers] (SQLite accepts these)
    if (ch === '[' && dialect === 'sqlite') {
      const j = sql.indexOf(']', i);
      if (j === -1) return { error: 'Unterminated [identifier]' };
      out.push(' ');
      i = j + 1;
      continue;
    }

    // $tag$ dollar-quoted strings (Postgres)
    if (ch === '$' && dialect === 'postgres') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) return { error: 'Unterminated dollar-quoted string' };
        out.push(' ');
        i = end + tag.length;
        continue;
      }
    }

    out.push(ch);
    i++;
  }

  return { skeleton: out.join('') };
}

/**
 * Validate a query. Returns { ok: true, sql, autoLimited } with the final SQL
 * to execute (possibly with a LIMIT appended/capped), or { ok: false, reason }.
 */
function validateSql(rawSql, { dialect = 'mysql', maxRows = 500 } = {}) {
  const fail = (reason) => ({ ok: false, reason });

  let sql = String(rawSql || '').trim();
  sql = sql.replace(/;+\s*$/, ''); // a single trailing semicolon is fine
  if (!sql) return fail('Empty query');

  const stripped = stripLiteralsAndComments(sql, dialect);
  if (stripped.error) return fail(stripped.error);
  const skeleton = stripped.skeleton;

  if (skeleton.includes(';')) {
    return fail('Multiple SQL statements are not allowed — send exactly one query');
  }

  // Leading parens are legal: (SELECT ...) UNION (SELECT ...)
  const firstWordMatch = /^[\s(]*([A-Za-z_]+)/.exec(skeleton);
  const firstWord = firstWordMatch ? firstWordMatch[1].toUpperCase() : '';
  if (!ALLOWED_STARTS.includes(firstWord)) {
    return fail(
      `Only read-only queries are allowed. The statement must start with ` +
      `${ALLOWED_STARTS.join(', ')} — got "${firstWord || sql.slice(0, 20)}"`
    );
  }

  // SHOW CREATE TABLE|VIEW|… is read-only; drop its leading "SHOW CREATE <obj>"
  // so the CREATE keyword doesn't trip the scan. The object name that follows
  // is a single identifier, and multi-statement (;) was already rejected above.
  const keywordTarget = SHOW_CREATE_RE.test(skeleton)
    ? skeleton.replace(/^\s*SHOW\s+CREATE\s+\w+/i, ' ')
    : skeleton;

  for (const word of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(keywordTarget)) {
      return fail(`Forbidden keyword "${word}" — only read-only queries are allowed. ` +
        `If "${word.toLowerCase()}" is a column or table name, quote it (e.g. \`${word.toLowerCase()}\` or "${word.toLowerCase()}")`);
    }
  }

  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (new RegExp(`\\b${fn}\\s*\\(`, 'i').test(skeleton)) {
      return fail(`Forbidden function "${fn}()"`);
    }
  }

  for (const { re, label } of FORBIDDEN_PATTERNS) {
    if (re.test(skeleton)) return fail(`Forbidden clause: ${label}`);
  }

  // Row limiting. All detection runs on the skeleton (comments/strings removed)
  // so a trailing "-- x", a "LIMIT n OFFSET m", or MySQL "LIMIT m, n" can't slip
  // an oversized fetch past the cap.
  let finalSql = sql;
  let autoLimited = false;
  if (LIMITABLE_STARTS.includes(firstWord)) {
    // Trailing LIMIT clause on the skeleton, in all three forms:
    //   LIMIT count | LIMIT count OFFSET off | LIMIT off, count  (MySQL)
    const tail = /\bLIMIT\s+(\d+)(?:\s*,\s*(\d+)|\s+OFFSET\s+(\d+))?\s*$/i.exec(skeleton);
    if (!/\bLIMIT\b/i.test(skeleton)) {
      finalSql = `${sql}\nLIMIT ${maxRows}`;
      autoLimited = true;
    } else if (tail) {
      const isCommaForm = tail[2] != null;               // LIMIT off, count
      const count = Number(isCommaForm ? tail[2] : tail[1]);
      if (count > maxRows) {
        const clause = isCommaForm
          ? `LIMIT ${tail[1]}, ${maxRows}`
          : tail[3] != null
            ? `LIMIT ${maxRows} OFFSET ${tail[3]}`
            : `LIMIT ${maxRows}`;
        // Replace the trailing LIMIT clause on the raw sql, discarding any
        // trailing comment that followed it.
        finalSql = sql.replace(
          /\bLIMIT\s+\d+(?:\s*,\s*\d+|\s+OFFSET\s+\d+)?\s*(?:(?:--|#)[^\n]*|\/\*[\s\S]*?\*\/)?\s*$/i,
          clause
        );
        autoLimited = true;
      }
    } else {
      // A LIMIT exists but only inside a subquery — the outer query is unbounded.
      finalSql = `${sql}\nLIMIT ${maxRows}`;
      autoLimited = true;
    }
  }

  return { ok: true, sql: finalSql, autoLimited };
}

module.exports = {
  validateSql,
  stripLiteralsAndComments,
  ALLOWED_STARTS,
  FORBIDDEN_KEYWORDS,
  FORBIDDEN_FUNCTIONS
};
