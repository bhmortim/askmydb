'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const conns = require('../src/db/connections');
const { prepareArgs } = require('../src/analysis/prepare');

function baseConfig() {
  return {
    db: { type: 'sqlite', file: '/data/legacy.sqlite', password: '' },
    connections: []
  };
}

test('legacy single db migrates into the registry as "default"', () => {
  const config = baseConfig();
  const list = conns.listConnections(config);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 'default');
  assert.match(list[0].label, /legacy/);
});

test('add / update / remove connections', () => {
  const config = baseConfig();
  const added = conns.addConnection(config, { type: 'postgres', host: 'db2', database: 'analytics', password: 'secret' });
  assert.ok(added.id);
  assert.strictEqual(conns.getConnection(config, added.id).password, 'secret');

  // empty password on update keeps the saved one
  conns.updateConnection(config, added.id, { type: 'postgres', host: 'db2', database: 'analytics', password: '' });
  assert.strictEqual(conns.getConnection(config, added.id).password, 'secret');

  assert.ok(conns.removeConnection(config, added.id));
  assert.strictEqual(conns.getConnection(config, added.id), null);
});

test('sanitize strips every connection password', () => {
  const config = baseConfig();
  conns.addConnection(config, { type: 'mysql', database: 'x', password: 'topsecret' });
  const list = conns.listConnections(config);
  for (const c of list) {
    assert.ok(!('password' in c), 'password must not be exposed');
  }
  assert.ok(list.some((c) => c.hasPassword));
});

test('unknown connection id resolves to null', () => {
  assert.strictEqual(conns.getConnection(baseConfig(), 'nope'), null);
});

test('deleting the migrated default connection does not resurrect it', () => {
  const config = baseConfig();
  conns.listConnections(config);               // triggers migration → default exists
  assert.ok(conns.getConnection(config, 'default'));
  assert.ok(conns.removeConnection(config, 'default'));
  // subsequent calls must NOT recreate 'default' from the legacy config.db
  const list = conns.listConnections(config);
  assert.strictEqual(list.length, 0, 'default should stay deleted');
  assert.strictEqual(conns.getConnection(config, 'default'), null);
});

// prepare / column-mapping
function resultOf(columns, rows) { return { columns, rows }; }

test('prepareArgs splits groups for a two-sample t-test', () => {
  const r = resultOf(['plan', 'spend'], [
    ['free', 10], ['pro', 50], ['free', 12], ['pro', 55], ['free', 9], ['pro', 48]
  ]);
  const args = prepareArgs('twoSampleT', r, { value: 'spend', group: 'plan' });
  assert.strictEqual(args.a.length + args.b.length, 6);
  assert.ok(Array.isArray(args.a) && Array.isArray(args.b));
});

test('prepareArgs builds a contingency table for chi-square', () => {
  const r = resultOf(['gender', 'choice'], [
    ['m', 'a'], ['m', 'b'], ['f', 'a'], ['f', 'a'], ['m', 'a'], ['f', 'b']
  ]);
  const args = prepareArgs('chiSquare', r, { rows: 'gender', cols: 'choice' });
  assert.strictEqual(args.table.length, 2);       // 2 genders
  assert.strictEqual(args.table[0].length, 2);    // 2 choices
  const total = args.table.flat().reduce((s, v) => s + v, 0);
  assert.strictEqual(total, 6);
});
