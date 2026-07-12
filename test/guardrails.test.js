'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { validateSql } = require('../src/guardrails');

const ok = (sql, opts = {}) => {
  const v = validateSql(sql, { dialect: 'mysql', maxRows: 500, ...opts });
  assert.strictEqual(v.ok, true, `expected OK but got: ${v.reason}`);
  return v;
};
const blocked = (sql, opts = {}) => {
  const v = validateSql(sql, { dialect: 'mysql', maxRows: 500, ...opts });
  assert.strictEqual(v.ok, false, `expected BLOCKED: ${sql}`);
  return v;
};

test('plain SELECT passes and gets a LIMIT', () => {
  const v = ok('SELECT * FROM users');
  assert.match(v.sql, /LIMIT 500$/);
  assert.strictEqual(v.autoLimited, true);
});

test('SELECT with its own LIMIT is left alone', () => {
  const v = ok('SELECT * FROM users LIMIT 10');
  assert.strictEqual(v.sql, 'SELECT * FROM users LIMIT 10');
});

test('oversized trailing LIMIT is capped', () => {
  const v = ok('SELECT * FROM users LIMIT 999999');
  assert.match(v.sql, /LIMIT 500$/);
});

test('trailing semicolon is tolerated', () => {
  ok('SELECT 1;');
});

test('CTE SELECT passes', () => {
  ok('WITH top AS (SELECT id FROM users) SELECT * FROM top');
});

test('SHOW / DESCRIBE / EXPLAIN pass', () => {
  ok('SHOW TABLES');
  ok('DESCRIBE users');
  ok('EXPLAIN SELECT 1');
});

test('parenthesized UNION passes', () => {
  ok('(SELECT id FROM a) UNION (SELECT id FROM b)');
});

test('INSERT / UPDATE / DELETE are blocked', () => {
  blocked('INSERT INTO users VALUES (1)');
  blocked("UPDATE users SET name = 'x'");
  blocked('DELETE FROM users');
  blocked('DROP TABLE users');
  blocked('TRUNCATE users');
});

test('writable CTE is blocked (Postgres data-modifying WITH)', () => {
  blocked('WITH x AS (DELETE FROM users RETURNING id) SELECT * FROM x', { dialect: 'postgres' });
  blocked('WITH x AS (INSERT INTO t VALUES (1) RETURNING id) SELECT 1', { dialect: 'postgres' });
});

test('multiple statements are blocked', () => {
  blocked('SELECT 1; DELETE FROM users');
  blocked('SELECT 1; SELECT 2');
});

test('semicolon inside a string literal is fine', () => {
  ok("SELECT * FROM logs WHERE message = 'a;b'");
});

test('SELECT INTO / OUTFILE / file functions are blocked', () => {
  blocked("SELECT * INTO OUTFILE '/tmp/x' FROM users");
  blocked('SELECT * INTO newtable FROM users', { dialect: 'postgres' });
  blocked("SELECT LOAD_FILE('/etc/passwd')");
  blocked("SELECT pg_read_file('/etc/passwd')", { dialect: 'postgres' });
});

test('sleep / benchmark / locks are blocked', () => {
  blocked('SELECT SLEEP(10)');
  blocked("SELECT BENCHMARK(100000000, SHA1('x'))");
  blocked('SELECT pg_sleep(10)', { dialect: 'postgres' });
  blocked('SELECT GET_LOCK("x", 10)');
  blocked('SELECT * FROM users FOR UPDATE');
  blocked('SELECT * FROM users LOCK IN SHARE MODE');
});

test('SET / PRAGMA / ATTACH / COPY / DO are blocked', () => {
  blocked("SET GLOBAL max_connections = 1");
  blocked('PRAGMA writable_schema = 1', { dialect: 'sqlite' });
  blocked("ATTACH DATABASE '/tmp/x' AS x", { dialect: 'sqlite' });
  blocked("COPY users TO '/tmp/x'", { dialect: 'postgres' });
  blocked("DO $$ BEGIN DELETE FROM users; END $$", { dialect: 'postgres' });
});

test('keyword hidden in a comment does not smuggle through', () => {
  blocked('SEL/**/ECT * FROM users'); // becomes "SEL ECT" — not a SELECT
  blocked('SELECT 1 /* harmless */; DROP TABLE users');
});

test('keyword inside a string literal does not false-positive', () => {
  ok("SELECT * FROM logs WHERE action = 'delete user'");
  ok("SELECT * FROM notes WHERE body LIKE '%insert%'");
});

test('keyword as quoted identifier does not false-positive', () => {
  ok('SELECT `update` FROM audit_log');
  ok('SELECT "delete" FROM audit_log', { dialect: 'postgres' });
});

test('dollar-quoted Postgres string is stripped safely', () => {
  ok("SELECT * FROM t WHERE body = $tag$some ; text$tag$", { dialect: 'postgres' });
  blocked('SELECT 1 WHERE $$x$$ = $$x$$ ; DELETE FROM t', { dialect: 'postgres' });
});

test('unterminated string or comment is rejected', () => {
  blocked("SELECT * FROM t WHERE name = 'oops");
  blocked('SELECT 1 /* not closed');
});

test('trailing line comment does not swallow the appended LIMIT', () => {
  const v = ok('SELECT * FROM users -- all of them');
  assert.match(v.sql, /\nLIMIT 500$/);
});

test('OFFSET does not false-positive on the SET keyword', () => {
  ok('SELECT * FROM users LIMIT 10 OFFSET 20');
});

test('empty and non-SELECT statements are rejected', () => {
  blocked('');
  blocked('   ');
  blocked('GRANT ALL ON *.* TO evil');
  blocked('CREATE TABLE x (id INT)');
  blocked('CALL some_proc()');
});

// ---- regression tests for the security review findings ----

test('MySQL executable comments /*! ... */ cannot smuggle keywords', () => {
  // The classic bypass: keywords hidden in an executable comment that MySQL runs.
  blocked("SELECT password FROM users /*!INTO OUTFILE '/tmp/o.txt'*/");
  blocked("SELECT 1 /*!99999 UNION SELECT load_file('/etc/passwd') */");
  blocked('SELECT 1 /*+ SET_VAR(x=1) */');
  // A plain block comment is still fine.
  ok('SELECT id FROM users /* a normal comment */');
});

test('row cap is not defeated by a trailing comment after LIMIT', () => {
  let v = ok('SELECT * FROM big LIMIT 100000 -- x');
  assert.match(v.sql, /LIMIT 500\b/);
  assert.doesNotMatch(v.sql, /100000/);
  v = ok('SELECT * FROM big LIMIT 100000/**/');
  assert.match(v.sql, /LIMIT 500\b/);
});

test('row cap handles LIMIT ... OFFSET and MySQL LIMIT m,n', () => {
  let v = ok('SELECT * FROM big LIMIT 100000 OFFSET 20');
  assert.match(v.sql, /LIMIT 500 OFFSET 20/);
  v = ok('SELECT * FROM big LIMIT 20, 100000');
  assert.match(v.sql, /LIMIT 20, 500/);
  // small offset limits are left alone
  v = ok('SELECT * FROM big LIMIT 10 OFFSET 5');
  assert.strictEqual(v.autoLimited, false);
});

test('a LIMIT only inside a subquery still caps the outer query', () => {
  const v = ok('SELECT * FROM (SELECT id FROM big LIMIT 10) t');
  assert.match(v.sql, /\nLIMIT 500$/);
});

test('SHOW CREATE TABLE / VIEW are allowed (read-only introspection)', () => {
  ok('SHOW CREATE TABLE users');
  ok('SHOW CREATE VIEW active_users');
  // but SHOW CREATE cannot be used to smuggle a second statement
  blocked('SHOW CREATE TABLE users; DROP TABLE users');
});

test('VALUES and TABLE are allowed and row-capped', () => {
  ok('VALUES (1,2),(3,4)', { dialect: 'postgres' });
  const v = ok('TABLE users', { dialect: 'postgres' });
  assert.match(v.sql, /LIMIT 500/);
});

test('Postgres E-string escapes do not desync the parser', () => {
  ok("SELECT name FROM t WHERE note = E'it\\'s here'", { dialect: 'postgres' });
  // and a real semicolon smuggled after an E-string is still caught
  blocked("SELECT 1 WHERE x = E'a\\'b' ; DROP TABLE t", { dialect: 'postgres' });
});

test('whole dblink_* function family is blocked', () => {
  blocked("SELECT dblink_send_query('c', 'DELETE FROM t')", { dialect: 'postgres' });
  blocked("SELECT dblink_get_result('c')", { dialect: 'postgres' });
  blocked("SELECT dblink('conn', 'SELECT 1')", { dialect: 'postgres' });
});

test('additional postgres file/ls functions are blocked', () => {
  blocked("SELECT pg_ls_waldir()", { dialect: 'postgres' });
  blocked("SELECT lo_get(1234)", { dialect: 'postgres' });
});
