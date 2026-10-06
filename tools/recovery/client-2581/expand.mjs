import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';

const root = path.resolve(process.argv[2] ?? 'reports/private/reconstruction/2581/client-recovery');
const source = fs.readFileSync(path.join(root, 'decoded/src.settings.js'), 'utf8');
const dictionary = Object.create(null);
function constant(node) {
  if (node.type === 'Literal') return node.value;
  if (node.type === 'BinaryExpression') {
    const a = constant(node.left), b = constant(node.right);
    switch (node.operator) {
      case '+': return a + b;
      case '-': return a - b;
      case '^': return a ^ b;
      case '|': return a | b;
      case '&': return a & b;
      case '*': return a * b;
      case '/': return a / b;
      default: throw new Error(`Unsupported constant operator ${node.operator}`);
    }
  }
  if (node.type === 'UnaryExpression' && node.operator === '-') return -constant(node.argument);
  if (node.type === 'UnaryExpression' && node.operator === '!') return !constant(node.argument);
  if (node.type === 'UnaryExpression' && node.operator === 'void' && constant(node.argument) === 0) return null;
  if (node.type === 'ArrayExpression') return node.elements.map(constant);
  if (node.type === 'ObjectExpression') return Object.fromEntries(node.properties.map(p => [p.computed ? constant(p.key) : p.key.name ?? p.key.value, constant(p.value)]));
  throw new Error(`Not a static constant: ${node.type} at ${node.start}`);
}
function walk(node, fn, parent = null, role = null) {
  fn(node, parent, role);
  for (const [key, value] of Object.entries(node)) {
    if (value?.type) walk(value, fn, node, key);
    else if (Array.isArray(value)) for (const item of value) if (item?.type) walk(item, fn, node, key);
  }
}
const settingsAst = parse(source, { ecmaVersion: 'latest' });
for (const statement of settingsAst.body) {
  const n = statement.expression;
  if (n?.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.object.name === 'window' && n.left.computed) {
    const key = constant(n.left.property);
    if (/^x[0-9A-F]+$/.test(key)) dictionary[key] = constant(n.right);
  }
}
const settingsNode = settingsAst.body.find(n => n.expression?.left?.property?.name === '_CCSettings');
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(constant(settingsNode.expression.right), null, 2) + '\n');
fs.writeFileSync(path.join(root, 'string-table.json'), JSON.stringify(dictionary) + '\n');
const index = { dictionaryEntries: Object.keys(dictionary).length, bundles: [] };
for (const bundle of ['main', 'resources']) {
  const filename = `decoded/${bundle}.index.js`;
  const text = fs.readFileSync(path.join(root, filename), 'utf8');
  const ast = parse(text, { ecmaVersion: 'latest', allowReturnOutsideFunction: false });
  const replacements = [], unresolved = new Set();
  walk(ast, (n, parent, role) => {
    if (n.type !== 'Identifier' || !/^x[0-9A-F]+$/.test(n.name)) return;
    if (parent?.type === 'MemberExpression' && role === 'property' && !parent.computed || parent?.type === 'Property' && role === 'key' && !parent.computed) return;
    if (!(n.name in dictionary)) { unresolved.add(n.name); return; }
    replacements.push({ start: n.start, end: n.end, value: JSON.stringify(dictionary[n.name]) });
  });
  let expanded = '', cursor = 0;
  for (const r of replacements.sort((a, b) => a.start - b.start)) { expanded += text.slice(cursor, r.start) + r.value; cursor = r.end; }
  expanded += text.slice(cursor);
  parse(expanded, { ecmaVersion: 'latest' });
  const expandedFilename = `decoded/${bundle}.expanded.js`;
  fs.writeFileSync(path.join(root, expandedFilename), expanded);
  const expandedAst = parse(expanded, { ecmaVersion: 'latest' });
  let moduleObject;
  walk(expandedAst, n => {
    if (n.type === 'CallExpression' && n.callee.type === 'FunctionExpression' && n.arguments[0]?.type === 'ObjectExpression' && n.arguments[0].properties.length > 100) moduleObject ??= n.arguments[0];
  });
  if (!moduleObject) throw new Error(`Bundle module object missing: ${bundle}`);
  const modules = moduleObject.properties.map(p => {
    const fn = p.value.elements?.[0];
    if (fn?.type !== 'FunctionExpression') throw new Error('Unexpected module registration');
    return { name: String(p.key.name ?? p.key.value), start: fn.start, end: fn.end, sha256: createHash('sha256').update(expanded.slice(fn.start, fn.end)).digest('hex'), dependencies: constant(p.value.elements[1]) };
  });
  index.bundles.push({ bundle, source: filename, sourceHash: createHash('sha256').update(text).digest('hex'), expanded: expandedFilename, outputHash: createHash('sha256').update(expanded).digest('hex'), parse: 'acorn-static-only-success', replacements: replacements.length, unresolved: [...unresolved], offsets: 'JavaScript UTF-16 code units in expanded source', modules });
}
fs.writeFileSync(path.join(root, 'module-index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(JSON.stringify({ dictionaryEntries: index.dictionaryEntries, bundles: index.bundles.map(b => ({ bundle: b.bundle, modules: b.modules.length, unresolved: b.unresolved.length })) }));
