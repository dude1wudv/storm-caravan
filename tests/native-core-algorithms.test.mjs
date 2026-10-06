import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const asset = readFileSync(new URL('../native-host/js/core-algorithms.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(asset, { window, ft: { isNumber: (value) => typeof value === 'number' } });
const core = window.Alloy2581Core;

function sha(value) { return createHash('sha256').update(value).digest('hex'); }

test('only the two byte-identical original core methods are packaged, not authentication or save crypto', () => {
  const tree = parse(asset, { ecmaVersion: 'latest' });
  const properties = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Property') properties.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(tree);
  assert.deepEqual(properties.map((node) => node.key.name), ['_arithmetic', '_getBaseValue']);
  const expected = {
    _arithmetic: '818074b47c926183997efee3daf989e900475f1208dad30bd19099168daf2e7a',
    _getBaseValue: '33ca907a5b877f6e5e29b5c0d0572b11cae0113c59c61cb8a960112c391ddee4',
  };
  for (const node of properties) assert.equal(sha(asset.slice(node.value.start, node.value.end)), expected[node.key.name]);
  assert.equal(Object.isFrozen(core), true);
});

test('original literal/control conversion preserves the real DSL tokens and numeric types', () => {
  assert.equal(core._getBaseValue('1'), 1);
  assert.equal(core._getBaseValue('true'), true);
  assert.equal(core._getBaseValue('false'), false);
  assert.equal(core._getBaseValue('null'), null);
  assert.equal(core._getBaseValue('if'), '@C');
  assert.equal(core._getBaseValue('endif'), '@G');
  assert.equal(core._getBaseValue('syn_thread'), '@L');
  assert.equal(core._getBaseValue('asy_thread'), '@M');
  assert.equal(core._getBaseValue('and'), '&');
  assert.equal(core._getBaseValue('unmodified-key'), 'unmodified-key');
});

test('original in-place arithmetic keeps multiplication precedence, unary signs, loose equality and booleanization', () => {
  assert.equal(core._arithmetic([1, '+', 2, '*', 3]), 7);
  assert.equal(core._arithmetic(['-', 3, '*', 2]), -6);
  assert.equal(core._arithmetic([10, '/', 2, '-', 1]), 4);
  assert.equal(core._arithmetic(['1', '==', 1]), true);
  assert.equal(core._arithmetic([1, '<', 2, '&', 0, '|', true]), true);
  assert.equal(core._arithmetic(['!', false]), true);
});
