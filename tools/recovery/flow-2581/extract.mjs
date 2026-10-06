import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('acorn');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../../..');
const input = path.join(root, 'reports/private/reconstruction/2581/client-recovery');
const output = path.join(root, 'reports/private/reconstruction/2581/flow-recovery');
const selected = {
  main: ['baseplayer', 'player', 'basemanager', 'baseentity', 'baseconfig', 'basesconfig', 'config', 'sconfig', 'system', 'method', 'basemethod', 'thread', 'dbheader', 'dbfile', 'basehttp', 'http', 'world', 'managerworld', 'extworld', 'task', 'managertask', 'exttask', 'event', 'npc', 'managernpc', 'extnpc', 'map', 'managermap', 'extmap', 'battle', 'managerbattle', 'extbattle', 'battleindex', 'battlerole', 'role', 'managerrole', 'skill', 'skillbuff', 'skilleffect', 'award', 'manageraward', 'extaward', 'check', 'managercheck', 'achievement', 'manageritem', 'item', 'dataevent', 'dataworld', 'datatask', 'datamap', 'datamapnpc', 'datanpc'],
  resources: ['SceneMain', 'LayoutSysLogin', 'LayoutMain', 'LayoutLoading', 'PartSysPreload', 'PartMainNpc', 'PartMainRole', 'mapmodel', 'managerdata', 'LayoutBattle', 'PartBattleRole', 'LayoutBattleResult', 'LayoutTask', 'LayoutWorldMap']
};
selected.main.push('inspect', 'managercopy', 'copy', 'managerachievement', 'managerequip', 'equip', 'managercore', 'core', 'manageractivetask', 'managermsg', 'msg', 'upgrade', 'version');
selected.resources.push('basecconfig', 'cconfig', 'PartBattleItem', 'PartBattleBuff', 'PartBattleBlood');
selected.main.push('extrole', 'extequip', 'extitem', 'extcore', 'extskill', 'extmsg', 'extcopy', 'extachievement', 'managerbeastrole', 'beastrole', 'managerreform', 'reform', 'managershopitem', 'shopitem', 'managerresonance', 'resonance', 'managercookitem', 'managerexploretask', 'exploretask', 'managermakeitem', 'makeitem');
selected.resources.push('PartSysUserEnter', 'managerres');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const save = (file, value) => {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const name = node => {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : String(node.value);
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression') {
    const object = name(node.object), property = name(node.property);
    return object && property ? object + (node.computed ? `[${property}]` : `.${property}`) : null;
  }
  return null;
};
const walk = (node, callback, parent = null) => {
  if (!node || typeof node.type !== 'string') return;
  callback(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) for (const child of value) walk(child, callback, node);
    else if (value && typeof value === 'object') walk(value, callback, node);
  }
};
const manifest = {
  baseline: 2581,
  method: 'Acorn AST only. Browserify registration map located structurally; complete module wrapper and dependency map copied by original source range. No original module execution, require, eval, network, or original input writes.',
  offsets: 'UTF-16 JavaScript string offsets, end exclusive; sourceByteRange is UTF-8 bytes, end exclusive.',
  inputs: [],
  modules: [],
  stringExpansion: null,
  limits: ['Static call/property facts do not prove runtime execution, branch reachability, or availability of remote state.', 'Raw modules retain obfuscation identifiers; expanded copies use only the peer recovered literal dictionary when available.', 'Private complete source copies may include original hardcoded values. Reports never print or inventory such values.']
};
const dictionaryFile = path.join(input, 'string-table.json');
let dictionary = null;
if (fs.existsSync(dictionaryFile)) {
  const data = JSON.parse(fs.readFileSync(dictionaryFile, 'utf8'));
  dictionary = data.strings || data.values || data;
  manifest.stringExpansion = { path: relative(dictionaryFile), sha256: hash(fs.readFileSync(dictionaryFile)), method: 'Replace Identifier references only with recovered JSON literals; preserve raw modules separately.' };
}
const allFacts = {};
for (const [bundle, keys] of Object.entries(selected)) {
  const sourceFile = path.join(input, 'decoded', `${bundle}.index.js`);
  const buffer = fs.readFileSync(sourceFile), source = buffer.toString('utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const registration = ast.body[0]?.expression?.right;
  if (registration?.type !== 'CallExpression' || registration.arguments[0]?.type !== 'ObjectExpression') throw new Error(`Unexpected bundle registration: ${bundle}`);
  const properties = registration.arguments[0].properties;
  manifest.inputs.push({ bundle, path: relative(sourceFile), sha256: hash(buffer), bytes: buffer.length, moduleCount: properties.length });
  for (const key of keys) {
    const property = properties.find(p => name(p.key) === key);
    if (!property || property.value?.type !== 'ArrayExpression') throw new Error(`Missing module ${bundle}/${key}`);
    const fn = property.value.elements[0], dependencies = property.value.elements[1];
    const raw = source.slice(fn.start, fn.end);
    const rawFile = path.join(output, 'modules', bundle, `${key}.js`);
    save(rawFile, raw);
    const facts = { functions: [], dependencyMap: source.slice(dependencies.start, dependencies.end), referencedIdentifiers: [], tableAccesses: [], unresolvedStringSymbols: [] };
    const symbols = new Set(), tables = new Set(), identifiers = new Set();
    walk(fn, (node, parent) => {
      if (node.type === 'Identifier') {
        identifiers.add(node.name);
        if (/^x[0-9A-F]+$/.test(node.name)) symbols.add(node.name);
      }
      if (node.type === 'CallExpression') {
        const target = name(node.callee);
        if (target?.startsWith('ftd.')) tables.add(target);
      }
      if (['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression'].includes(node.type)) {
        const label = parent?.type === 'AssignmentExpression' ? name(parent.left) : parent?.type === 'Property' ? name(parent.key) : parent?.type === 'VariableDeclarator' ? name(parent.id) : node.id?.name || null;
        if (node === fn) return;
        const calls = new Set(), fields = new Set();
        walk(node.body, child => {
          if (child.type === 'CallExpression') { const target = name(child.callee); if (target) calls.add(target); }
          if (child.type === 'MemberExpression') { const field = name(child); if (field) fields.add(field); }
        });
        facts.functions.push({ symbol: label, sourceRange: [node.start, node.end], moduleRange: [node.start - fn.start, node.end - fn.start], parameters: node.params.map(name), calls: [...calls], fields: [...fields] });
      }
    });
    facts.referencedIdentifiers = [...identifiers].sort();
    facts.tableAccesses = [...tables].sort();
    facts.unresolvedStringSymbols = [...symbols].sort();
    let expandedEvidence = null;
    if (dictionary) {
      const replacements = [];
      walk(fn, (node, parent) => {
        if (node.type !== 'Identifier' || !Object.hasOwn(dictionary, node.name)) return;
        if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
        if (parent?.type === 'Property' && parent.key === node && !parent.computed) return;
        replacements.push([node.start - fn.start, node.end - fn.start, JSON.stringify(dictionary[node.name])]);
      });
      let expanded = raw;
      for (const [start, end, literal] of replacements.sort((a, b) => b[0] - a[0])) expanded = expanded.slice(0, start) + literal + expanded.slice(end);
      const expandedFile = path.join(output, 'expanded', bundle, `${key}.js`);
      save(expandedFile, expanded);
      expandedEvidence = { path: relative(expandedFile), sha256: hash(expanded) };
    }
    allFacts[`${bundle}/${key}`] = facts;
    manifest.modules.push({ bundle, key, path: relative(rawFile), sha256: hash(raw), sourceRange: [fn.start, fn.end], sourceByteRange: [Buffer.byteLength(source.slice(0, fn.start)), Buffer.byteLength(source.slice(0, fn.end))], registrationRange: [property.start, property.end], dependencyMap: facts.dependencyMap, functions: facts.functions.length, expanded: expandedEvidence });
  }
}
save(path.join(output, 'manifest.json'), manifest);
save(path.join(output, 'symbols.json'), allFacts);
console.log(JSON.stringify({ modules: manifest.modules.length, output: relative(output), expanded: Boolean(dictionary) }));
