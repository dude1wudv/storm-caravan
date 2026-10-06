// Complements assignment-only index with all function nodes and static API aliases.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { parse } = createRequire(import.meta.url)('acorn');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const out = path.join(root, 'reports/private/reconstruction/2581/core-runtime');
const inventory = JSON.parse(fs.readFileSync(path.join(out, 'core-method-index.json'), 'utf8'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function name(n) {
  if (!n) return null;
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'ThisExpression') return 'this';
  if (n.type === 'Literal' && typeof n.value === 'string' && /^[A-Za-z_$][\w$]*$/.test(n.value)) return n.value;
  if (n.type === 'MemberExpression') { const a = name(n.object), b = name(n.property); return a && b ? a + '.' + b : null; }
  return null;
}
function collect(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc') continue;
    if (Array.isArray(value)) for (const child of value) collect(child, visit, node);
    else if (value && typeof value === 'object') collect(value, visit, node);
  }
}
const results = [];
for (const module of inventory.modules) {
  const file = module.expandedOutput, bytes = fs.readFileSync(path.join(out, file)), source = bytes.toString('utf8');
  const ast = parse('(' + source + ')', { ecmaVersion: 'latest', locations: true });
  const parents = new Map(), functions = [], aliases = [], assignments = [];
  collect(ast, (node, parent) => parents.set(node, parent));
  function range(node) {
    const start = node.start - 1, end = node.end - 1;
    const byteStart = Buffer.byteLength(source.slice(0, start)), byteEnd = Buffer.byteLength(source.slice(0, end));
    return { moduleUtf16Range: [start, end], moduleByteRange: [byteStart, byteEnd],
      expandedBundleByteRange: [module.expanded.byteRange[0] + byteStart, module.expanded.byteRange[0] + byteEnd],
      sha256: hash(bytes.subarray(byteStart, byteEnd)) };
  }
  function label(node, parent) {
    if (parent?.type === 'AssignmentExpression') return name(parent.left);
    if (parent?.type === 'VariableDeclarator') return name(parent.id);
    if (parent?.type === 'Property') {
      const suffix = [name(parent.key) || '<computed>'];
      let current = parents.get(parent);
      while (current) {
        const p = parents.get(current);
        if (p?.type === 'AssignmentExpression' && p.right === current) return [name(p.left) || '<object>', ...suffix].join('.');
        if (p?.type === 'VariableDeclarator' && p.init === current) return [name(p.id) || '<object>', ...suffix].join('.');
        if (p?.type === 'Property') suffix.unshift(name(p.key) || '<computed>');
        current = p;
      }
      return suffix.join('.');
    }
    return node.id?.name || (node === ast.body[0].expression ? '<module-wrapper>' : '<anonymous>');
  }
  collect(ast.body[0].expression, (node, parent) => {
    if (node.type === 'VariableDeclarator' && node.init?.type === 'MemberExpression') {
      const target = name(node.id), value = name(node.init);
      if (target && value) aliases.push({ target, source: value, ...range(node) });
    }
    if (node.type === 'AssignmentExpression') {
      const target = name(node.left), value = name(node.right);
      if (target) assignments.push({ target, rhsType: node.right.type, ...range(node) });
      if (target && value) aliases.push({ target, source: value, ...range(node) });
    }
    if (!['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression'].includes(node.type)) return;
    const calls = new Set(), fields = new Set();
    collect(node.body, child => {
      if (child.type === 'CallExpression') { const n = name(child.callee); if (n) calls.add(n); }
      if (child.type === 'MemberExpression') { const n = name(child); if (n) fields.add(n); }
    });
    functions.push({ label: label(node, parent), type: node.type, params: node.params.map(name), ...range(node),
      emptyBody: node.body.type === 'BlockStatement' && node.body.body.length === 0,
      calls: [...calls].sort(), fields: [...fields].sort() });
  });
  results.push({ bundle: module.bundle, module: module.key, sourcePath: file, sourceSha256: hash(bytes),
    originalSourcePath: module.originalOutput, originalSha256: module.original.sha256,
    functions, staticAliases: aliases, assignments });
}
const report = { schemaVersion: 1, parser: 'Acorn; original JS never executed',
  scope: 'All function declarations/expressions, constructors, object-property functions and assignments in every preserved original core/helper/integration module. Input expanded wrappers are existing source-dictionary derivatives; raw original wrapper hashes are linked.',
  offsets: 'Exact UTF-8 and UTF-16 slices within copied expanded wrapper, end-exclusive. expandedBundleByteRange permits direct comparison to existing decoded bundles. No literal/auth/key values enumerated.',
  modules: results, limits: ['Static aliases identify sys/api and helper relationships, not dynamic binding or runtime behavior.',
    'Core native injection function/side effects are indexed in core-method-index.json, with exact original bytes.'] };
const file = path.join(out, 'core-function-index.json'), bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
if (fs.existsSync(file)) { if (!fs.readFileSync(file).equals(bytes)) throw Error('Existing output differs'); }
else fs.writeFileSync(file, bytes);
console.log(JSON.stringify({ modules: results.length, functions: results.reduce((n, m) => n + m.functions.length, 0), originalCodeExecuted: false }));
