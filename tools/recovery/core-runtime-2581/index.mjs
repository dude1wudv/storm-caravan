// Static Acorn parsing of preserved sources only. Never require/eval original modules.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { parse } = createRequire(import.meta.url)('acorn');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = path.join(root, 'reports/private/reconstruction/2581');
const out = path.join(base, 'core-runtime');
const decoded = path.join(base, 'client-recovery/decoded');
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const relative = f => path.relative(root, f).replaceAll('\\', '/');
function save(name, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const file = path.join(out, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if (!fs.readFileSync(file).equals(bytes)) throw Error('Existing output differs: ' + name);
    return;
  }
  fs.writeFileSync(file, bytes);
}
function name(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  // Only identifier-shaped property/class labels, not arbitrary literal values.
  if (node.type === 'Literal' && typeof node.value === 'string' && /^[A-Za-z_$][\w$]*$/.test(node.value)) return node.value;
  if (node.type === 'MemberExpression') {
    const o = name(node.object), p = name(node.property);
    return o && p ? `${o}.${p}` : null;
  }
  return null;
}
function walk(node, callback, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  callback(node, parent);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'start' || k === 'end' || k === 'loc') continue;
    if (Array.isArray(v)) for (const child of v) walk(child, callback, node);
    else if (v && typeof v === 'object') walk(v, callback, node);
  }
}
const byteOffsets = new Map();
function byteOffset(source, offset) {
  let checkpoints = byteOffsets.get(source);
  if (!checkpoints) {
    checkpoints = [{ char: 0, byte: 0 }];
    for (let start = 0, total = 0; start < source.length;) {
      let end = Math.min(start + 65536, source.length);
      if (end < source.length && /[\uDC00-\uDFFF]/.test(source[end]) && /[\uD800-\uDBFF]/.test(source[end - 1])) end--;
      total += Buffer.byteLength(source.slice(start, end));
      checkpoints.push({ char: end, byte: total });
      start = end;
    }
    byteOffsets.set(source, checkpoints);
  }
  let lo = 0, hi = checkpoints.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (checkpoints[mid].char <= offset) lo = mid;
    else hi = mid - 1;
  }
  return checkpoints[lo].byte + Buffer.byteLength(source.slice(checkpoints[lo].char, offset));
}
function range(source, node, baseOffset = 0) {
  const start = byteOffset(source, node.start);
  const end = byteOffset(source, node.end);
  return { utf16Range: [node.start, node.end], byteRange: [start, end],
    moduleUtf16Range: [node.start - baseOffset, node.end - baseOffset], sha256: digest(Buffer.from(source.slice(node.start, node.end))) };
}
function trivial(fn) {
  const body = fn.body?.body;
  if (!body) return null;
  if (!body.length) return 'empty-function';
  if (body.length !== 1 || body[0].type !== 'ReturnStatement') return null;
  const v = body[0].argument;
  if (!v) return 'return-undefined';
  if (v.type === 'Literal' && v.value === '') return 'return-empty-string';
  if (v.type === 'Literal' && v.value === false) return 'return-false';
  if (v.type === 'Literal' && v.value === true) return 'return-true';
  if (v.type === 'Literal' && v.value === null) return 'return-null';
  return null;
}
function functionNode(right) {
  if (right?.type === 'FunctionExpression' || right?.type === 'ArrowFunctionExpression') return right;
  if (right?.type === 'CallExpression' && right.callee?.type === 'MemberExpression' && name(right.callee.property) === 'bind') return functionNode(right.callee.object);
  return null;
}
function facts(source, fn) {
  const methods = [], assignments = [], calls = new Set(), classNames = new Set();
  walk(fn, (node, parent) => {
    if (node.type === 'CallExpression') {
      const target = name(node.callee);
      if (target) calls.add(target);
      if (target && /(?:newClass|registClass|registerClass|extendClass)$/.test(target)) {
        const label = name(node.arguments[0]);
        if (label) classNames.add(label);
      }
    }
    if (node.type === 'AssignmentExpression') {
      const target = name(node.left);
      if (target) {
        assignments.push({ target, operator: node.operator, ...range(source, node, fn.start),
          publicBooleanValue: /(?:^|\.)(?:TEST|LOG)$/.test(target) && node.right.type === 'Literal' && typeof node.right.value === 'boolean' ? node.right.value : undefined });
        const f = functionNode(node.right);
        if (f) {
          const targets = new Set(), fields = new Set(), identifiers = new Set();
          walk(f.body, child => {
            if (child.type === 'CallExpression') { const n = name(child.callee); if (n) targets.add(n); }
            if (child.type === 'MemberExpression') { const n = name(child); if (n) fields.add(n); }
            if (child.type === 'Identifier') identifiers.add(child.name);
          });
          methods.push({ target, parameters: f.params.map(name), ...range(source, f, fn.start),
            assignmentRange: range(source, node, fn.start), trivialBody: trivial(f),
            calls: [...targets].sort(), fields: [...fields].sort(), identifiers: [...identifiers].sort() });
        }
      }
    }
  });
  return { methods, assignments, calls: [...calls].sort(), classNames: [...classNames].sort() };
}
const priorManifest = JSON.parse(fs.readFileSync(path.join(base, 'client-recovery/manifest.json'), 'utf8'));
const scan = [];
const tokens = ['secretBox', '_arithmetic', '_getBaseValue', 'ft_c_call_core', 'Inspect', 'Thread'];
for (const filename of fs.readdirSync(decoded).filter(n => n.endsWith('.js')).sort()) {
  const file = path.join(decoded, filename), bytes = fs.readFileSync(file);
  const matches = {};
  for (const token of tokens) {
    const needle = Buffer.from(token), offsets = [];
    for (let i = bytes.indexOf(needle); i !== -1; i = bytes.indexOf(needle, i + needle.length)) offsets.push(i);
    matches[token] = offsets;
  }
  scan.push({ path: relative(file), bytes: bytes.length, sha256: digest(bytes), tokenByteOffsets: matches });
}
save('existing-decoded-search.json', { method: 'Existing decoded files only, byte token search; no original decode rerun or source execution.',
  inputManifest: { path: relative(path.join(base, 'client-recovery/manifest.json')), sha256: digest(fs.readFileSync(path.join(base, 'client-recovery/manifest.json'))) },
  originalRecoveryRoutes: priorManifest.outputs || priorManifest.recovered || null, files: scan });
const candidates = { main: new Set(['baseconfig', 'basesconfig', 'config', 'sconfig', 'system', 'inspect', 'thread', 'basemethod', 'method', 'baseplayer', 'player', 'basehttp', 'http', 'dbfile', 'dbheader', 'baseentity', 'basemanager']),
  resources: new Set(['basecconfig', 'cconfig', 'rconfig', 'sdkconfig']) };
const modules = [], bundleCatalogs = [];
for (const bundle of ['main', 'resources']) {
  const rawFile = path.join(decoded, `${bundle}.index.js`), expFile = path.join(decoded, `${bundle}.expanded.js`);
  const rawBytes = fs.readFileSync(rawFile), rawSource = rawBytes.toString('utf8');
  const expBytes = fs.readFileSync(expFile), expSource = expBytes.toString('utf8');
  const rawAst = parse(rawSource, { ecmaVersion: 'latest', sourceType: 'script' });
  const expAst = parse(expSource, { ecmaVersion: 'latest', sourceType: 'script' });
  const rawProps = rawAst.body[0].expression.right.arguments[0].properties;
  const expProps = expAst.body[0].expression.right.arguments[0].properties;
  const catalog = { bundle, rawPath: relative(rawFile), rawSha256: digest(rawBytes), expandedPath: relative(expFile), expandedSha256: digest(expBytes), modules: [] };
  for (const p of expProps) {
    const key = p.key.name ?? String(p.key.value), fn = p.value.elements[0];
    const rf = rawProps.find(v => (v.key.name ?? String(v.key.value)) === key)?.value.elements[0];
    if (!rf) throw Error('No original registered wrapper: ' + key);
    const assignmentTargets = new Set(), callTargets = new Set();
    let methodCount = 0;
    walk(fn, node => {
      if (node.type === 'AssignmentExpression') {
        const target = name(node.left);
        if (target) assignmentTargets.add(target);
        if (functionNode(node.right)) methodCount++;
      }
      if (node.type === 'CallExpression') { const target = name(node.callee); if (target) callTargets.add(target); }
    });
    const ftAssignments = [...assignmentTargets].filter(a => /^(?:ft|fts|window\.ft|window\.fts)\./.test(a));
    const genericHelper = ftAssignments.length > 0;
    const entry = { key, original: range(rawSource, rf), expanded: range(expSource, fn), methodCount,
      nativeCalls: [...callTargets].filter(v => /^ft_c_|^ft_android_/.test(v)), ftAssignments };
    catalog.modules.push(entry);
    if (!candidates[bundle].has(key) && !genericHelper) continue;
    const f = facts(expSource, fn);
    const rawCopy = `modules/${bundle}/${key}.original.js`, expandedCopy = `modules/${bundle}/${key}.expanded.js`;
    save(rawCopy, Buffer.from(rawSource.slice(rf.start, rf.end)));
    save(expandedCopy, Buffer.from(expSource.slice(fn.start, fn.end)));
    modules.push({ bundle, key, reason: genericHelper ? 'ft/fts helper or class configuration assignments' : 'DSL/core or direct integration boundary',
      originalSource: relative(rawFile), originalSourceSha256: digest(rawBytes), original: range(rawSource, rf), originalOutput: rawCopy,
      expandedSource: relative(expFile), expandedSourceSha256: digest(expBytes), expanded: range(expSource, fn), expandedOutput: expandedCopy,
      expandedStatus: 'Existing literal-dictionary expansion, not invented code; original bytes are preserved separately.', ...f });
  }
  bundleCatalogs.push(catalog);
}
const coreFile = path.join(out, 'call-core.original.js'), coreBytes = fs.readFileSync(coreFile), source = coreBytes.toString('utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
const coreFacts = facts(source, ast);
for (const method of coreFacts.methods.filter(m => m.target.startsWith('secretBox.'))) {
  const filename = `methods/${method.target}.original.js`;
  save(filename, coreBytes.subarray(...method.byteRange));
  method.originalOutput = filename;
}
const topLevel = ast.body.map(node => ({ type: node.type, ...range(source, node), firstLine: node.loc.start.line, lastLine: node.loc.end.line }));
const effects = coreFacts.assignments.map(a => ({ ...a, category: a.target.startsWith('secretBox.') || a.target === 'p.system.secretBox' ? 'generic-DSL' :
  a.target.startsWith('p.http.') ? 'authentication-network-crypto' : a.target.startsWith('p.dbFile.') ? 'save-crypto-native-dependency' :
  /(?:^|\.)(?:TEST|LOG)$/.test(a.target) || a.target === 'p.sourceId' ? 'production-test/log/source-side-effect' :
  a.target === 'p._safetyTest' ? 'production-configuration-function-installation' : 'local-or-other' }));
const targets = ['_arithmetic', '_getBaseValue'];
const sys = modules.find(m => m.bundle === 'main' && m.key === 'system');
const inspect = modules.find(m => m.bundle === 'main' && m.key === 'inspect');
const thread = modules.find(m => m.bundle === 'main' && m.key === 'thread');
const missing = targets.map(method => ({ method,
  existingSystem: sys.methods.filter(m => m.target.endsWith('.' + method)),
  realCore: coreFacts.methods.filter(m => m.target === 'secretBox.' + method),
  dispatchMethods: sys.methods.filter(m => m.fields.some(n => n.includes('secretBox'))).map(m => ({ target: m.target, ...m.assignmentRange, calls: m.calls, fields: m.fields })) }));
save('core-method-index.json', { schemaVersion: 1, parser: 'Acorn static AST only; original scripts never run',
  ranges: 'UTF-16 and UTF-8 byte ranges, end-exclusive; SHA256 over exact UTF-8 slices. Copied standalone wrappers require parentheses if independently parsed, not execution.',
  nativeCore: { path: relative(coreFile), bytes: coreBytes.length, sha256: digest(coreBytes), topLevel, ...coreFacts, effects },
  observedSystemGaps: missing,
  inspectThread: [inspect, thread].map(m => ({ module: m.key, originalOutput: m.originalOutput, expandedOutput: m.expandedOutput,
    methods: m.methods, trivialMethods: m.methods.filter(f => f.trivialBody), nativeCalls: m.calls.filter(n => /^ft_c_|^ft_android_/.test(n)),
    nativeCoreOverrides: coreFacts.assignments.filter(a => /Inspect|Thread|\.prototype\./.test(a.target)) })),
  modules, bundleCatalogs,
  limits: ['Only named static function/property evidence. Empty methods are described, not presumed incorrect without callers.',
    'Native core contains no Inspect/Thread prototype/classhelper/sys/api patch. Existing pr1/pr2 module definitions are indexed separately.',
    'All original private literals remain confined to preserved source bytes, not listed in indexes.',
    'Remote hot-code presence in existing player/HTTP source is not a recovered remote payload or permission to execute it.'] });
console.log(JSON.stringify({ nativeCoreMethods: coreFacts.methods.map(m => m.target), preservedGenericModules: modules.length,
  inspectTrivial: inspect.methods.filter(m => m.trivialBody).map(m => m.target), threadTrivial: thread.methods.filter(m => m.trivialBody).map(m => m.target), originalCodeExecuted: false }));
