import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options = { input: join(root, 'assets/original-data/original-story.json'), output: join(root, 'assets/original-story'), registry: null, pageSize: 64 };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const name = args[i], value = args[i + 1];
  if (!value || !['--input', '--output', '--registry', '--page-size'].includes(name)) throw new Error('Usage: node tools/data/pack-original-story.mjs [--input <original-story.json>] [--output <asset-directory>] [--registry <typescript-file>] [--page-size <positive-integer>]');
  if (name === '--page-size') options.pageSize = Number(value);
  else options[name.slice(2)] = resolve(value);
}
if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1) throw new Error('--page-size must be a positive safe integer.');
const bytes = await readFile(options.input);
const source = JSON.parse(bytes.toString('utf8'));
if (source.schemaVersion !== 1 || !source.texts || !source.scripts || !source.records || !source.storyflops || !source.dictionaries) throw new Error('Input is not OriginalStoryConfig schema 1.');
const expectedKeys = ['schemaVersion', 'sourceVersion', 'texts', 'scripts', 'records', 'storyflops', 'dictionaries'];
if (Object.keys(source).some(key => !expectedKeys.includes(key))) throw new Error('Unexpected input root fields would be lost; update the pack format explicitly.');
const textKinds = ['business', 'storyLines', 'uiComponents', 'uiCandidates', 'androidSupplement'];
if (Object.keys(source.texts).some(key => !textKinds.includes(key))) throw new Error('Unexpected text collection would be lost.');
const sha = value => createHash('sha256').update(value).digest('hex');
const tableIds = new Map();
const addId = (table, id) => {
  if (typeof table !== 'string' || typeof id !== 'string') throw new Error('Original table/ID must remain strings.');
  if (!tableIds.has(table)) tableIds.set(table, new Set());
  tableIds.get(table).add(id);
};
for (const [table, records] of Object.entries(source.records)) for (const id of Object.keys(records)) addId(table, id);
for (const script of Object.values(source.scripts)) addId(script.table, script.id);
for (const kind of ['business', 'storyLines']) for (const item of source.texts[kind]) addId(item.table, item.id);
for (const item of Object.values(source.storyflops)) addId(item.table, item.id);
const pages = new Map(), locations = new Map(), assets = {};
const safeTable = table => `${table.replace(/[^A-Za-z0-9_-]/g, '_')}-${sha(table).slice(0, 8)}`;
for (const [table, ids] of tableIds) {
  // ID pages use first-seen source order, never numeric renumbering or inferred adjacency.
  [...ids].forEach((id, index) => {
    const page = Math.floor(index / options.pageSize);
    const asset = `${safeTable(table)}-${String(page).padStart(5, '0')}`;
    if (!pages.has(asset)) pages.set(asset, { schemaVersion: 1, kind: 'record-page', table, page, ids: [], records: {}, scripts: {}, storyflops: {}, texts: { business: [], storyLines: [] } });
    pages.get(asset).ids.push(id);
    locations.set(JSON.stringify([table, id]), asset);
  });
}
const recordIndex = {};
for (const [table, records] of Object.entries(source.records)) {
  recordIndex[table] = {};
  for (const [id, record] of Object.entries(records)) {
    const asset = locations.get(JSON.stringify([table, id]));
    pages.get(asset).records[id] = record;
    recordIndex[table][id] = asset;
  }
}
const scriptIndex = {}, sourceIndex = {}, storyflopIndex = {};
const sourceLocations = (uid, location) => {
  if (typeof uid !== 'string') return;
  if (!sourceIndex[uid]) sourceIndex[uid] = [];
  sourceIndex[uid].push(location);
};
for (const [uid, script] of Object.entries(source.scripts)) {
  if (uid !== script.source_uid) throw new Error(`Script identity mismatch: ${uid}`);
  const asset = locations.get(JSON.stringify([script.table, script.id]));
  pages.get(asset).scripts[uid] = script;
  scriptIndex[uid] = asset;
  sourceLocations(uid, { asset, collection: 'scripts', key: uid });
}
for (const [id, storyflop] of Object.entries(source.storyflops)) {
  const asset = locations.get(JSON.stringify([storyflop.table, storyflop.id]));
  pages.get(asset).storyflops[id] = storyflop;
  storyflopIndex[id] = asset;
  sourceLocations(storyflop.source_uid, { asset, collection: 'storyflops', key: id });
}
for (const kind of ['business', 'storyLines']) source.texts[kind].forEach((value, index) => {
  const asset = locations.get(JSON.stringify([value.table, value.id]));
  pages.get(asset).texts[kind].push({ index, value });
  sourceLocations(value.source_uid, { asset, collection: `texts.${kind}`, index });
});
const supplementalIndex = {};
for (const kind of ['uiComponents', 'uiCandidates', 'androidSupplement']) {
  supplementalIndex[kind] = [];
  for (let start = 0; start < source.texts[kind].length; start += options.pageSize) {
    const asset = `${kind}-${String(start / options.pageSize).padStart(5, '0')}`;
    const items = source.texts[kind].slice(start, start + options.pageSize);
    pages.set(asset, { schemaVersion: 1, kind: 'text-page', collection: kind, start, items });
    supplementalIndex[kind].push(asset);
    items.forEach((value, offset) => sourceLocations(value.source_uid, { asset, collection: `texts.${kind}`, index: start + offset }));
  }
}
const dictionaryIndex = {};
for (const [field, value] of Object.entries(source.dictionaries)) {
  const array = Array.isArray(value);
  const entries = array ? value : Object.entries(value);
  dictionaryIndex[field] = { kind: array ? 'array' : 'object', assets: [] };
  for (let start = 0; start < entries.length; start += options.pageSize) {
    const asset = `dictionary-${safeTable(field)}-${String(start / options.pageSize).padStart(5, '0')}`;
    pages.set(asset, { schemaVersion: 1, kind: 'dictionary-page', field, valueKind: array ? 'array' : 'object', start, entries: entries.slice(start, start + options.pageSize) });
    dictionaryIndex[field].assets.push(asset);
  }
}
const counts = { records: Object.values(source.records).reduce((sum, records) => sum + Object.keys(records).length, 0), scripts: Object.keys(source.scripts).length, storyflops: Object.keys(source.storyflops).length, compiledVariants: 0, sourceDefectVariants: 0, importerGapVariants: 0, ...Object.fromEntries(textKinds.map(kind => [kind, source.texts[kind].length])) };
for (const script of Object.values(source.scripts)) for (const variant of Object.values(script.variants)) {
  if (variant.status === 'compiled') counts.compiledVariants++;
  else if (variant.classification === 'source-defect') counts.sourceDefectVariants++;
  else counts.importerGapVariants++;
}
await mkdir(options.output, { recursive: true });
const emit = async (asset, value) => {
  const buffer = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  const file = `${asset}.story`;
  assets[asset] = { file, bytes: buffer.length, sha256: sha(buffer) };
  await writeFile(join(options.output, file), buffer);
};
for (const [asset, page] of pages) await emit(asset, page);
const index = { schemaVersion: 1, kind: 'original-story-index', sourceVersion: source.sourceVersion, input: { file: relative(root, options.input).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes) }, pageSize: options.pageSize, counts, scripts: scriptIndex, records: recordIndex, storyflops: storyflopIndex, sources: sourceIndex, supplemental: supplementalIndex, dictionaries: dictionaryIndex, order: { scripts: Object.keys(source.scripts), tables: Object.keys(source.records), records: Object.fromEntries(Object.entries(source.records).map(([table, records]) => [table, Object.keys(records)])), storyflops: Object.keys(source.storyflops) }, assets: { ...assets } };
await emit('index', index);
await emit('audit', { schemaVersion: 1, input: index.input, counts, preservation: { records: 'exact original values', scripts: 'exact compiled variants, issues, failed-source evidence and AST designDecisions', texts: 'exact values with original global array indices', storyflops: 'exact raw_record and parallel array order', dictionaries: 'ordered array items or original object entry pairs', branchContext: 'static source evidence only, never executed-path selection' }, assets: { ...assets }, completePlayableCoverage: false });
if (options.registry) {
await mkdir(dirname(options.registry), { recursive: true });
const requirePath = asset => {
  const path = relative(dirname(options.registry), join(options.output, assets[asset].file)).replaceAll('\\', '/');
  return path.startsWith('.') ? path : `./${path}`;
};
const registry = `// Generated by tools/data/pack-original-story.mjs. Only asset handles, never the complete JSON payload.\nexport const ORIGINAL_STORY_ASSETS: Readonly<Record<string, number>> = {\n${Object.keys(assets).map(asset => `  ${JSON.stringify(asset)}: require(${JSON.stringify(requirePath(asset))}) as number,`).join('\n')}\n};\nexport const ORIGINAL_STORY_INPUT_SHA256 = ${JSON.stringify(index.input.sha256)};\nexport const ORIGINAL_STORY_INDEX_SHA256 = ${JSON.stringify(assets.index.sha256)};\n`;
await writeFile(options.registry, registry, 'utf8');
}
console.log(JSON.stringify({ input: options.input, output: options.output, registry: options.registry, counts, assets: Object.keys(assets).length, inputSha256: index.input.sha256 }, null, 2));
