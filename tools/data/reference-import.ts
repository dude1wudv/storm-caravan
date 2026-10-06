import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { decodeNamedCharacterReference } from 'decode-named-character-reference';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;
export interface ReferenceTable {
  keys: string[];
  defaults: JsonRecord;
  data: Record<string, JsonRecord>;
}
export interface ReferenceSource {
  metadata: JsonRecord;
  tables: Record<string, ReferenceTable>;
}
export interface Issue {
  kind: string;
  sourceFile?: string;
  table?: string;
  sourceId?: string;
  field?: string;
  line?: number;
  expected?: unknown;
  observed?: unknown;
  message: string;
}
interface AstNode {
  type: string;
  value?: string;
  depth?: number;
  lang?: string | null;
  children?: AstNode[];
  position?: { start: { line: number; offset?: number }; end: { line: number; offset?: number } };
}
export interface MarkdownField {
  field: string;
  displayValue: string;
  rawCell: string;
  usedDefault: boolean;
  line?: number;
  block?: { lang: string; rawValue: string; line?: number };
}
export interface MarkdownRecord {
  sourceFile: string;
  sourceId: string;
  anchorId?: string;
  title: string;
  line?: number;
  fields: MarkdownField[];
}
export interface MarkdownPart {
  sourceFile: string;
  title: string;
  table: string;
  category?: string;
  declaredPartCount?: number;
  declaredTableCount?: number;
  defaults: JsonRecord;
  hasDefaults: boolean;
  records: MarkdownRecord[];
  issues: Issue[];
}
export interface FieldEvidence {
  sourceFile: string | null;
  sourceId: string;
  table: string;
  field: string;
  presence: 'explicit' | 'default' | 'absent';
  hasRawValue: boolean;
  rawValue: JsonValue;
  value: JsonValue;
  usedDefault: boolean;
  jsonPointer: string;
  markdown?: MarkdownField;
}
export interface ImportedRecord {
  table: string;
  sourceId: string;
  sourceFile: string | null;
  fields: Record<string, FieldEvidence>;
}
export interface ImportResult {
  source: ReferenceSource;
  sourceSha256: string;
  parts: MarkdownPart[];
  records: ImportedRecord[];
  report: {
    schemaVersion: 1;
    privateOnly: true;
    typeAuthority: '属性原始数据.json';
    ok: boolean;
    expected: { tables: number; records: number; markdownParts: number };
    observed: { tables: number; jsonRecords: number; markdownParts: number; markdownRecords: number; uniqueMarkdownRecords: number; fields: number };
    source: JsonRecord;
    sourceSha256: string;
    tables: { table: string; jsonRecords: number; markdownRecords: number; uniqueMarkdownRecords: number; files: string[] }[];
    issues: Issue[];
    ambiguities: { table: string; sourceId: string; field: string; sourceFile: string; line?: number; displayed: string; authorityType: string; reason: string }[];
    comparisonNormalizations: { table: string; sourceId: string; field: string; sourceFile: string; line?: number; kind: 'text-code-block-line-endings'; reason: string }[];
    limitations: string[];
  };
}

const parser = unified().use(remarkParse).use(remarkGfm);
const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
export const EXPECTED_REFERENCE = { tables: 31, records: 34214, markdownParts: 94 };

/** Decode exactly once, after GFM has identified source column boundaries. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return decodeNamedCharacterReference(name) || entity;
    const hex = /^#x/i.test(name);
    const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : '\ufffd';
  });
}
function text(node: AstNode): string {
  if (node.type === 'break') return '\n';
  if (node.value !== undefined) return node.type === 'html' ? decodeHtmlEntities(node.value) : node.value;
  return (node.children ?? []).map(text).join('');
}
function rawSlice(node: AstNode, markdown: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start !== undefined && end !== undefined ? markdown.slice(start, end) : text(node);
}
function defaultMarker(node: AstNode): boolean {
  return node.type === 'strong' && text(node) === '（默认）';
}
function cellValue(node: AstNode, markdown: string): { value: string; usedDefault: boolean } {
  const children = node.children ?? [];
  const last = children.at(-1);
  const usedDefault = last !== undefined && defaultMarker(last);
  const content = usedDefault ? children.slice(0, -1) : children;
  if (!content.length) return { value: '', usedDefault };
  const first = content[0];
  const start = first.position?.start.offset;
  const end = content.at(-1)?.position?.end.offset;
  if (start === undefined || end === undefined) throw new Error('Raw field content has no Markdown source positions.');
  // Span the original source, including emphasis delimiters: '*' and '_' may be data/DSL operators.
  const raw = markdown.slice(start, end).trim();
  if (content.length === 1 && first.type === 'inlineCode' && raw === rawSlice(first, markdown).trim()) {
    return { value: first.value ?? '', usedDefault };
  }
  return { value: decodeHtmlEntities(raw), usedDefault };
}
function headingValue(node: AstNode, markdown: string): string {
  return decodeHtmlEntities(rawSlice(node, markdown).replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '').trim());
}
function normalizeMarkdownLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/** Parse only one authored 分表; merged Markdown is deliberately never discovered. */
export function parseMarkdownPart(markdown: string, sourceFile: string): MarkdownPart {
  const tree = parser.parse(markdown) as AstNode;
  const part: MarkdownPart = { sourceFile, title: '', table: '', defaults: {}, hasDefaults: false, records: [], issues: [] };
  let current: MarkdownRecord | undefined;
  let pendingAnchor: string | undefined;
  let pendingBlockField: string | undefined;
  let pendingDefaults = false;
  const issue = (kind: string, message: string, node?: AstNode, field?: string): void => {
    part.issues.push({ kind, message, sourceFile, table: part.table, sourceId: current?.sourceId, field, line: node?.position?.start.line });
  };
  for (const node of tree.children ?? []) {
    // CommonMark treats an <a> line as inline HTML inside a paragraph, not necessarily an HTML block.
    const anchor = /^(?:\s*)<a\s+id=["']id-([^"']+)["']\s*>\s*<\/a>\s*$/.exec(
      node.type === 'html' ? node.value ?? '' : node.type === 'paragraph' ? rawSlice(node, markdown) : '',
    );
    if (node.type === 'heading' && node.depth === 1) {
      if (part.title) issue('duplicate-table-heading', 'Multiple level-one table headings.', node);
      part.title = headingValue(node, markdown);
      const pieces = part.title.split(' · ');
      part.table = pieces[1] ?? '';
      part.category = pieces.slice(2).join(' · ') || undefined;
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(part.table)) issue('table-heading', 'Missing or invalid table name in level-one heading.', node);
    } else if (anchor) {
      if (pendingAnchor !== undefined) issue('orphan-anchor', 'Anchor was not followed by a record heading.', node);
      pendingAnchor = anchor[1];
    } else if (node.type === 'heading' && node.depth === 2) {
      const title = headingValue(node, markdown);
      const match = /^([^\s]+)\s+·\s*(.*)$/.exec(title);
      current = { sourceFile, sourceId: match?.[1] ?? title, anchorId: pendingAnchor, title, line: node.position?.start.line, fields: [] };
      part.records.push(current);
      if (!match) issue('record-heading', 'Record heading does not contain an ID and title.', node);
      if (pendingAnchor === undefined || pendingAnchor !== current.sourceId) issue('record-anchor', 'Record title ID and id anchor must agree.', node);
      pendingAnchor = undefined;
      pendingBlockField = undefined;
    } else if (node.type === 'paragraph') {
      const value = text(node);
      const counts = /本分表\s+([\d,]+)\s+条；整张\s+([A-Za-z0-9_]+)\s+表\s+([\d,]+)\s+条/.exec(value);
      if (counts && !current) {
        part.declaredPartCount = Number(counts[1].replaceAll(',', ''));
        part.declaredTableCount = Number(counts[3].replaceAll(',', ''));
        if (counts[2] !== part.table) issue('count-table', 'Count declaration names a different table.', node);
      }
      if (value.startsWith('本表默认值')) pendingDefaults = true;
      const label = /^([A-Za-z_][A-Za-z0-9_]*)\s+(?:原始文本|原始数组|数组结构|原始结构|结构)[:：]$/.exec(value);
      if (label && current) pendingBlockField = label[1];
    } else if (node.type === 'table' && current) {
      const rows = node.children ?? [];
      const header = (rows[0]?.children ?? []).map(text);
      if (header[1] !== '原始字段' || header[2] !== '原值') continue;
      for (const row of rows.slice(1)) {
        const cells = row.children ?? [];
        if (cells.length !== 3) { issue('field-columns', 'Expected exactly three field columns.', row); continue; }
        const field = cellValue(cells[1], markdown).value;
        const parsed = cellValue(cells[2], markdown);
        if (current.fields.some(entry => entry.field === field)) issue('duplicate-field', 'Field occurs more than once in one record.', row, field);
        current.fields.push({ field, displayValue: parsed.value, rawCell: rawSlice(cells[2], markdown), usedDefault: parsed.usedDefault, line: row.position?.start.line });
      }
    } else if (node.type === 'code') {
      if (pendingDefaults && !current) {
        try {
          const value: unknown = JSON.parse(node.value ?? '');
          if (node.lang !== 'json' || !isJsonRecord(value)) throw new Error('Defaults must be a json object.');
          if (part.hasDefaults) issue('duplicate-defaults', 'Default JSON block occurs more than once.', node);
          part.defaults = value;
          part.hasDefaults = true;
        } catch (error) { issue('defaults-json', String(error), node); }
        pendingDefaults = false;
      } else if (current) {
        const unresolved = current.fields.filter(entry => /^见下方/.test(entry.displayValue) && !entry.block);
        const field = pendingBlockField ?? (unresolved.length === 1 ? unresolved[0].field : undefined);
        const target = current.fields.find(entry => entry.field === field);
        if (!target) issue('unbound-code-block', 'Record code block cannot be bound to a raw field.', node, field);
        else if (target.block) issue('duplicate-code-block', 'Field has more than one code block.', node, field);
        else target.block = { lang: node.lang ?? '', rawValue: node.value ?? '', line: node.position?.start.line };
        pendingBlockField = undefined;
      }
    }
  }
  if (!part.title) issue('missing-table-heading', 'No table heading found.');
  if (pendingAnchor !== undefined) issue('orphan-anchor', 'Trailing anchor has no record heading.');
  for (const record of part.records) {
    for (const field of record.fields) {
      if (/^见下方/.test(field.displayValue) && !field.block) part.issues.push({ kind: 'missing-code-block', sourceFile, table: part.table, sourceId: record.sourceId, field: field.field, line: field.line, message: 'Field points to a missing code block.' });
    }
  }
  return part;
}
function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function effectiveField(row: JsonRecord, defaults: JsonRecord, field: string): { presence: FieldEvidence['presence']; rawValue: JsonValue; value: JsonValue; usedDefault: boolean; hasRawValue: boolean } {
  if (own(row, field)) return { presence: 'explicit', rawValue: row[field], value: row[field], usedDefault: false, hasRawValue: true };
  if (own(defaults, field)) return { presence: 'default', rawValue: null, value: defaults[field], usedDefault: true, hasRawValue: false };
  return { presence: 'absent', rawValue: null, value: null, usedDefault: false, hasRawValue: false };
}
function projection(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value === '' ? '""' : value;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
export function markdownMatches(field: MarkdownField, value: JsonValue): boolean {
  if (field.block) {
    if (field.block.lang === 'json') {
      try { return isDeepStrictEqual(JSON.parse(field.block.rawValue), value); } catch { return false; }
    }
    return field.block.lang === 'text' && typeof value === 'string'
      && normalizeMarkdownLineEndings(field.block.rawValue) === normalizeMarkdownLineEndings(value);
  }
  if (Array.isArray(value) || isJsonRecord(value)) {
    try { return isDeepStrictEqual(JSON.parse(field.displayValue), value); } catch { return false; }
  }
  return field.displayValue === projection(value);
}
function pointerSegment(value: string): string { return value.replaceAll('~', '~0').replaceAll('/', '~1'); }

/** Compare every JSON row, without deduping or synthesizing Markdown records to reach expected counts. */
export function compareReference(source: ReferenceSource, parts: MarkdownPart[], expected = EXPECTED_REFERENCE, sourceSha256 = ''): ImportResult {
  const issues: Issue[] = parts.flatMap(part => part.issues);
  const ambiguities: ImportResult['report']['ambiguities'] = [];
  const comparisonNormalizations: ImportResult['report']['comparisonNormalizations'] = [];
  const records: ImportedRecord[] = [];
  const byKey = new Map<string, MarkdownRecord[]>();
  const tableParts = new Map<string, MarkdownPart[]>();
  for (const part of parts) {
    tableParts.set(part.table, [...(tableParts.get(part.table) ?? []), part]);
    const table = source.tables[part.table];
    if (!table) issues.push({ kind: 'unknown-table', table: part.table, sourceFile: part.sourceFile, message: 'Markdown table does not exist in JSON.' });
    else {
      if (!isDeepStrictEqual(part.defaults, table.defaults)) issues.push({ kind: 'defaults-conflict', table: part.table, sourceFile: part.sourceFile, expected: table.defaults, observed: part.defaults, message: 'Markdown defaults differ from JSON authority.' });
      if (Object.keys(table.defaults).length && !part.hasDefaults) issues.push({ kind: 'missing-defaults', table: part.table, sourceFile: part.sourceFile, message: 'Table defaults are missing from Markdown.' });
      if (part.declaredTableCount !== Object.keys(table.data).length) issues.push({ kind: 'declared-table-count', table: part.table, sourceFile: part.sourceFile, expected: Object.keys(table.data).length, observed: part.declaredTableCount, message: 'Declared whole-table count differs from JSON.' });
    }
    if (part.declaredPartCount !== part.records.length) issues.push({ kind: 'declared-part-count', table: part.table, sourceFile: part.sourceFile, expected: part.declaredPartCount, observed: part.records.length, message: 'Declared part count differs from parsed records.' });
    for (const record of part.records) {
      const key = `${part.table}\u0000${record.sourceId}`;
      const previous = byKey.get(key) ?? [];
      if (previous.length) issues.push({ kind: 'duplicate-record', table: part.table, sourceId: record.sourceId, sourceFile: record.sourceFile, line: record.line, observed: [...previous.map(entry => entry.sourceFile), record.sourceFile], message: 'A table/ID is imported more than once.' });
      byKey.set(key, [...previous, record]);
      if (!table || !own(table.data, record.sourceId)) issues.push({ kind: 'extra-record', table: part.table, sourceId: record.sourceId, sourceFile: record.sourceFile, line: record.line, message: 'Markdown record does not exist in JSON.' });
    }
  }
  for (const [tableName, table] of Object.entries(source.tables)) {
    for (const [sourceId, row] of Object.entries(table.data)) {
      const markdownRecords = byKey.get(`${tableName}\u0000${sourceId}`) ?? [];
      if (!markdownRecords.length) issues.push({ kind: 'missing-record', table: tableName, sourceId, message: 'JSON record is absent from the 94 Markdown parts.' });
      const imported: ImportedRecord = { table: tableName, sourceId, sourceFile: markdownRecords[0]?.sourceFile ?? null, fields: {} };
      const keys = [...new Set([...table.keys, ...Object.keys(table.defaults), ...Object.keys(row)])];
      for (const field of keys) {
        const effective = effectiveField(row, table.defaults, field);
        imported.fields[field] = { ...effective, table: tableName, sourceId, sourceFile: imported.sourceFile, field, jsonPointer: `/tables/${pointerSegment(tableName)}/data/${pointerSegment(sourceId)}/${pointerSegment(field)}` };
        for (const markdownRecord of markdownRecords) {
          const matches = markdownRecord.fields.filter(entry => entry.field === field);
          if (matches[0] && !imported.fields[field].markdown) imported.fields[field].markdown = matches[0];
          if (effective.presence !== 'absent' && !matches.length) issues.push({ kind: 'missing-field', table: tableName, sourceId, field, sourceFile: markdownRecord.sourceFile, expected: effective.value, message: 'Configured/default field is missing from Markdown.' });
          for (const observed of matches) {
            const location = { table: tableName, sourceId, field, sourceFile: markdownRecord.sourceFile, line: observed.line };
            if (effective.presence === 'absent') issues.push({ ...location, kind: 'extra-field', observed, message: 'Markdown exposes a field absent in JSON and defaults.' });
            else {
              if (effective.usedDefault !== observed.usedDefault) issues.push({ ...location, kind: 'default-presence-conflict', expected: effective.usedDefault, observed: observed.usedDefault, message: 'Only an absent JSON key may use a default.' });
              const matchesAuthority = markdownMatches(observed, effective.value);
              if (!matchesAuthority) issues.push({ ...location, kind: 'field-conflict', expected: effective.value, observed, message: 'Decoded Markdown projection differs from JSON authority.' });
              else if (observed.block?.lang === 'text' && typeof effective.value === 'string' && observed.block.rawValue !== effective.value) {
                comparisonNormalizations.push({ ...location, kind: 'text-code-block-line-endings', reason: 'Compared CRLF/CR/LF as Markdown presentation line endings only; the full Markdown block rawValue and JSON authority value remain unchanged.' });
              }
              if (!observed.block && effective.value !== null && !Array.isArray(effective.value) && typeof effective.value !== 'object' && /^(?:null|true|false|""|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.test(observed.displayValue)) {
                ambiguities.push({ ...location, displayed: observed.displayValue, authorityType: typeof effective.value, reason: 'Markdown scalar display is not a type encoding; original JSON type was retained.' });
              }
            }
          }
        }
      }
      for (const markdownRecord of markdownRecords) {
        for (const observed of markdownRecord.fields) {
          if (!keys.includes(observed.field)) issues.push({ kind: 'unknown-field', table: tableName, sourceId, field: observed.field, sourceFile: markdownRecord.sourceFile, line: observed.line, message: 'Field does not exist in JSON keys/defaults/record.' });
        }
        const name = effectiveField(row, table.defaults, 'name');
        const expectedTitle = `${sourceId} · ${name.presence === 'absent' || name.value === null || name.value === '' ? '（空名称）' : String(name.value)}`;
        if (markdownRecord.title !== expectedTitle) issues.push({ kind: 'title-conflict', table: tableName, sourceId, sourceFile: markdownRecord.sourceFile, line: markdownRecord.line, expected: expectedTitle, observed: markdownRecord.title, message: 'Record heading differs from ID/name projection.' });
      }
      records.push(imported);
    }
  }
  const observed = {
    tables: Object.keys(source.tables).length,
    jsonRecords: records.length,
    markdownParts: parts.length,
    markdownRecords: parts.reduce((sum, part) => sum + part.records.length, 0),
    uniqueMarkdownRecords: byKey.size,
    fields: records.reduce((sum, record) => sum + Object.keys(record.fields).length, 0),
  };
  for (const [key, actual, required] of [
    ['tables', observed.tables, expected.tables], ['json-records', observed.jsonRecords, expected.records],
    ['markdown-parts', observed.markdownParts, expected.markdownParts], ['markdown-records', observed.markdownRecords, expected.records],
    ['unique-markdown-records', observed.uniqueMarkdownRecords, expected.records],
  ] as const) {
    if (actual !== required) issues.push({ kind: 'total-count', field: key, expected: required, observed: actual, message: 'Reference corpus count differs from the declared contract.' });
  }
  const tables = Object.entries(source.tables).map(([table, data]) => {
    const entries = tableParts.get(table) ?? [];
    return { table, jsonRecords: Object.keys(data.data).length, markdownRecords: entries.reduce((sum, part) => sum + part.records.length, 0), uniqueMarkdownRecords: new Set(entries.flatMap(part => part.records.map(record => record.sourceId))).size, files: entries.map(part => part.sourceFile) };
  });
  return { source, sourceSha256, parts, records, report: {
    schemaVersion: 1, privateOnly: true, typeAuthority: '属性原始数据.json', ok: issues.length === 0,
    expected, observed, source: source.metadata, sourceSha256, tables, issues, ambiguities, comparisonNormalizations,
    limitations: [
      'Markdown loses scalar type information. This import cross-checks its display projection against JSON; it does not independently reconstruct all JSON types.',
      'Absent fields have hasRawValue=false and rawValue=null as an explicit serialization placeholder; presence distinguishes them from explicit null. Defaults appear only in value.',
      'Code blocks retain full raw text and raw line endings, with no HTML decoding or execution. Text block display comparison normalizes CRLF/CR to LF only and records each applied normalization; other differences remain conflicts.',
      'Source JSON numbers follow the Node JSON number model; unsafe integer numbers must not be presented as lossless decimals. Numeric strings remain unchanged.',
      'Merged Markdown and derived ID-link summaries are not input records.',
    ],
  } };
}

export interface ReferenceOptions { sourceDirectory: string; reportDirectory: string; help: boolean }
export function referenceOptions(args: string[] = process.argv.slice(2)): ReferenceOptions {
  const options: ReferenceOptions = {
    sourceDirectory: resolve('../../games/合金机兵_属性数据完整包/合金机兵_属性数据'),
    reportDirectory: resolve('reports/private/reference'), help: false,
  };
  const flags: Record<string, keyof Pick<ReferenceOptions, 'sourceDirectory' | 'reportDirectory'>> = {
    '--source': 'sourceDirectory', '--reports': 'reportDirectory',
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help') options.help = true;
    else {
      const key = flags[argument];
      const value = args[++index];
      if (!key || !value || value.startsWith('--')) throw new Error(`Unknown option or missing path: ${argument}`);
      options[key] = resolve(value);
    }
  }
  // Private outputs cannot target the original reference directory.
  const normalizedSource = options.sourceDirectory.replaceAll('\\', '/').toLowerCase().replace(/\/$/, '');
  const normalizedOutput = options.reportDirectory.replaceAll('\\', '/').toLowerCase();
  if (normalizedOutput === normalizedSource || normalizedOutput.startsWith(`${normalizedSource}/`)) throw new Error('Output must not overwrite the read-only source directory.');
  return options;
}
export async function loadReference(sourceDirectory: string): Promise<ImportResult> {
  const raw = await readFile(join(sourceDirectory, '属性原始数据.json'), 'utf8');
  const source: ReferenceSource = JSON.parse(raw.replace(/^\ufeff/, ''));
  if (!isJsonRecord(source.metadata) || !isJsonRecord(source.tables)) throw new Error('Invalid source JSON metadata/tables.');
  for (const [name, table] of Object.entries(source.tables)) {
    if (!Array.isArray(table.keys) || !table.keys.every(key => typeof key === 'string') || !isJsonRecord(table.defaults) || !isJsonRecord(table.data)) throw new Error(`Invalid table schema: ${name}`);
    for (const [id, row] of Object.entries(table.data)) if (!isJsonRecord(row)) throw new Error(`Invalid row object: ${name}/${id}`);
  }
  const directory = join(sourceDirectory, '分表');
  const files = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => entry.name).sort();
  const parts: MarkdownPart[] = [];
  for (const file of files) parts.push(parseMarkdownPart(await readFile(join(directory, file), 'utf8'), `分表/${file}`));
  return compareReference(source, parts, EXPECTED_REFERENCE, createHash('sha256').update(raw).digest('hex'));
}
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
export async function writeImportReports(result: ImportResult, directory: string): Promise<void> {
  await writePrivateJson(join(directory, 'import-report.json'), result.report);
  await writePrivateJson(join(directory, 'imported-data.json'), {
    schemaVersion: 1, privateOnly: true, source: result.source.metadata, sourceSha256: result.sourceSha256,
    records: result.records,
    markdownParts: result.parts.map(part => ({ sourceFile: part.sourceFile, table: part.table, title: part.title, category: part.category, declaredPartCount: part.declaredPartCount, declaredTableCount: part.declaredTableCount, defaults: part.defaults, records: part.records })),
  });
}
export async function runReferenceImport(args?: string[]): Promise<number> {
  const options = referenceOptions(args);
  if (options.help) {
    console.log('node --import tsx tools/data/reference-import.ts [--source DIR] [--reports DIR]\nRun from repository root. Outputs: import-report.json, imported-data.json. Exit 0 only if all cross-checks pass; 1 on conflicts; 2 on I/O/schema failure.');
    return 0;
  }
  try {
    const result = await loadReference(options.sourceDirectory);
    await writeImportReports(result, options.reportDirectory);
    console.log(JSON.stringify({ tool: 'reference-import', status: result.report.ok ? 'passed' : 'conflicts', report: join(options.reportDirectory, 'import-report.json'), counts: result.report.observed, issues: result.report.issues.length }));
    return result.report.ok ? 0 : 1;
  } catch (error) {
    await writePrivateJson(join(options.reportDirectory, 'import-report.json'), { schemaVersion: 1, privateOnly: true, ok: false, status: 'failed-before-comparison-completed', error: String(error) });
    console.error(String(error));
    return 2;
  }
}
if (/^reference-import\.(?:ts|js)$/.test(basename(process.argv[1] ?? ''))) {
  void runReferenceImport().then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 2; });
}
