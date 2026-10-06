import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';
import { createHash } from 'node:crypto';
const root = path.resolve(process.argv[2] ?? 'reports/private/reconstruction/2581/client-recovery');
const text = fs.readFileSync(path.join(root, 'decoded/main.expanded.js'), 'utf8');
const ast = parse(text, { ecmaVersion: 'latest' });
const tables = {}, sources = {};
function value(n) {
  if (n.type === 'Literal') return n.value;
  if (n.type === 'ArrayExpression') return n.elements.map(value);
  if (n.type === 'ObjectExpression') return Object.fromEntries(n.properties.map(p => [String(p.key.name ?? p.key.value), value(p.value)]));
  if (n.type === 'UnaryExpression' && n.operator === '-') return -value(n.argument);
  if (n.type === 'UnaryExpression' && n.operator === '!') return !value(n.argument);
  throw new Error(`Unsupported table literal ${n.type} at ${n.start}`);
}
function walk(n) {
  if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.object.name === 'ftd' && n.right.type === 'ObjectExpression') {
    const name = n.left.property.name ?? n.left.property.value;
    const data = value(n.right);
    if (data.keys && data.data) {
      if (name in tables) throw new Error(`Duplicate table ${name}`);
      tables[name] = data;
      sources[name] = { bundle: 'decoded/main.expanded.js', start: n.right.start, end: n.right.end, offsets: 'UTF-16 code units', sha256: createHash('sha256').update(text.slice(n.right.start, n.right.end)).digest('hex') };
    }
  }
  for (const v of Object.values(n)) {
    if (v?.type) walk(v);
    else if (Array.isArray(v)) for (const item of v) if (item?.type) walk(item);
  }
}
walk(ast);
fs.writeFileSync(path.join(root, 'tables.compact-original.json'), JSON.stringify(tables));
fs.writeFileSync(path.join(root, 'table-sources.json'), JSON.stringify(sources, null, 2) + '\n');
console.log(JSON.stringify({ tables: Object.keys(tables).length, rows: Object.values(tables).reduce((n, t) => n + Object.keys(t.data).length, 0) }));
