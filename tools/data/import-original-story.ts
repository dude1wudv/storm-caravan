import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseReferenceSyntax, ReferenceSyntaxError } from './reference-syntax';
import type { ReferenceExpression, ReferenceStatement, ReferenceSyntaxProgram } from './reference-syntax';
import type {
  OriginalAndroidText, OriginalBusinessText, OriginalJson, OriginalLanguage,
  OriginalLocalizationDictionaries, OriginalScript, OriginalScriptDomain, OriginalScriptFailure,
  OriginalScriptIssue, OriginalScriptSourceDefect, OriginalScriptVariant, OriginalStoryConfig, OriginalStoryflop,
  OriginalStoryLine, OriginalStoryManifest, OriginalStoryRecord, OriginalUiCandidate, OriginalUiText,
} from './original-story-model';

const FILES = {
  business: '业务表_UI任务与说明文本.json',
  scripts: '事件与条件_原始脚本.json',
  lines: '剧情脚本_解析文本行.json',
  literals: '剧情脚本_所有字符串字面量.json',
  flops: '翻牌与分支剧情_原始及逐行结构.json',
  dictionaries: '界面本地化字典.json',
  ui: '界面预制组件文本.json',
  candidates: '界面脚本_硬编码文本候选.json',
  android: 'Android与SDK资源字符串.json',
  warnings: '静态解析警告.json',
} as const;
const DATA_DIRECTORY = '合金机兵_文本数据';
const MANIFEST_FILE = '合金机兵_文本校验清单.json';
const MISSING_STRUCTURE = [
  { table: 'Task', fields: ['world', 'a_task', 'type'], reason: 'not-provided-in-text-package' as const },
  { table: 'World', fields: ['mainTask', 'unlock'], reason: 'not-provided-in-text-package' as const },
];
const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const increment = (counts: Record<string, number>, key: string, amount = 1): void => { counts[key] = (counts[key] ?? 0) + amount; };
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function object(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at}: expected object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at}: expected array`);
  return value;
}
function string(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new Error(`${at}: expected string`);
  return value;
}
function number(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${at}: expected finite number`);
  return value;
}
function boolean(value: unknown, at: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${at}: expected boolean`);
  return value;
}
function strings(row: Record<string, unknown>, keys: string[], at: string): void {
  for (const key of keys) string(row[key], `${at}/${key}`);
}
function stringArray(value: unknown, at: string): void {
  array(value, at).forEach((item, index) => string(item, `${at}/${index}`));
}
function numberArray(value: unknown, at: string): void {
  array(value, at).forEach((item, index) => number(item, `${at}/${index}`));
}
function language(value: unknown, at: string): OriginalLanguage {
  if (value !== 'base' && value !== 'tr') throw new Error(`${at}: unsupported source language ${JSON.stringify(value)}`);
  return value;
}
function validateBusiness(value: unknown, at: string): OriginalBusinessText {
  const row = object(value, at);
  strings(row, ['source_uid', 'table', 'id', 'field', 'field_path', 'category', 'text', 'original_record_name', 'source_status', 'visibility', 'table_zh', 'field_zh', 'source_language'], at);
  for (const key of ['text_tr', 'translation_language']) if (row[key] !== null) string(row[key], `${at}/${key}`);
  array(row.array_path, `${at}/array_path`).forEach((part, index) => {
    if (typeof part !== 'string') number(part, `${at}/array_path/${index}`);
  });
  if (own(row, 'text_role')) string(row.text_role, `${at}/text_role`);
  return row as unknown as OriginalBusinessText;
}
interface SourceScript {
  source_uid: string; table: string; id: string; field: string; context: Record<string, OriginalJson>;
  variants: { language: OriginalLanguage; raw: string; issues: OriginalScriptIssue[] }[];
}
function validateScript(value: unknown, at: string): SourceScript {
  const row = object(value, at);
  strings(row, ['source_uid', 'table', 'id', 'field'], at);
  object(row.context, `${at}/context`);
  const seen = new Set<string>();
  array(row.variants, `${at}/variants`).forEach((item, index) => {
    const variant = object(item, `${at}/variants/${index}`);
    const lang = language(variant.language, `${at}/variants/${index}/language`);
    if (seen.has(lang)) throw new Error(`${at}: duplicate language ${lang}`);
    seen.add(lang);
    string(variant.raw, `${at}/variants/${index}/raw`);
    array(variant.issues, `${at}/variants/${index}/issues`).forEach((issue, issueIndex) => {
      const entry = object(issue, `${at}/variants/${index}/issues/${issueIndex}`);
      const issueAt = `${at}/variants/${index}/issues/${issueIndex}`;
      if (own(entry, 'issue')) {
        string(entry.issue, `${issueAt}/issue`);
        if (own(entry, 'statement_index')) number(entry.statement_index, `${issueAt}/statement_index`);
      } else {
        strings(entry, ['error', 'raw_literal', 'text_fragment'], issueAt);
        number(entry.statement_index, `${issueAt}/statement_index`);
        number(entry.offset, `${issueAt}/offset`);
      }
    });
  });
  if (!seen.has('base')) throw new Error(`${at}: missing base variant`);
  return row as unknown as SourceScript;
}
interface SourceLine extends Omit<OriginalStoryLine, 'branch_context_semantics'> { raw_arguments: string[]; speaker_raw?: string }
function validateLine(value: unknown, at: string): SourceLine {
  const row = object(value, at);
  strings(row, ['source_uid', 'table', 'id', 'field', 'record_name', 'command', 'text', 'classification', 'parse_status', 'field_zh', 'command_zh'], at);
  language(row.language, `${at}/language`);
  number(row.statement_index, `${at}/statement_index`);
  numberArray(row.line_path, `${at}/line_path`);
  if (row.speaker !== null) string(row.speaker, `${at}/speaker`);
  if (own(row, 'speaker_raw')) string(row.speaker_raw, `${at}/speaker_raw`);
  stringArray(row.raw_arguments, `${at}/raw_arguments`);
  array(row.branch_context, `${at}/branch_context`).forEach((item, index) => {
    strings(object(item, `${at}/branch_context/${index}`), ['if_statement', 'active_branch'], `${at}/branch_context/${index}`);
  });
  return row as unknown as SourceLine;
}
function validateUi(value: unknown, at: string): OriginalUiText {
  const row = object(value, at);
  strings(row, ['source_uid', 'apk_entry', 'json_pointer', 'component_class', 'field', 'instance_pointer', 'category', 'text', 'source_status', 'field_zh'], at);
  if (row.node_name !== null) string(row.node_name, `${at}/node_name`);
  for (const key of ['localization_key', 'localization_status']) if (own(row, key)) string(row[key], `${at}/${key}`);
  if (own(row, 'cached_text') && row.cached_text !== null) string(row.cached_text, `${at}/cached_text`);
  boolean(row.embedded, `${at}/embedded`);
  boolean(row.has_cjk, `${at}/has_cjk`);
  if (row.node_index !== null) number(row.node_index, `${at}/node_index`);
  if (!own(row, 'node_reference_raw')) throw new Error(`${at}: missing node_reference_raw`);
  array(row.asset_paths, `${at}/asset_paths`).forEach((item, index) => strings(object(item, `${at}/asset_paths/${index}`), ['asset_path', 'asset_type'], `${at}/asset_paths/${index}`));
  return row as unknown as OriginalUiText;
}
interface SourceCandidate extends Omit<OriginalUiCandidate, 'usage' | 'usage_basis' | 'visibility'> { raw_expression: string; context_expanded: string }
function validateCandidate(value: unknown, at: string): SourceCandidate {
  const row = object(value, at);
  strings(row, ['source', 'module', 'function', 'ast_type', 'category', 'text', 'assignment_target', 'call_target', 'raw_expression', 'context_expanded'], at);
  for (const key of ['offset', 'line', 'column']) number(row[key], `${at}/${key}`);
  boolean(row.dynamic_fragment, `${at}/dynamic_fragment`);
  return row as unknown as SourceCandidate;
}
function classifyCandidate(source: SourceCandidate): OriginalUiCandidate {
  const { raw_expression: _expression, context_expanded: _expanded, ...row } = source;
  // Heuristic scope is explicit and never discards game text or claims display visibility.
  const sdk = /(?:^_sdk|^LayoutSys(?:Login|InputAccount|DeleteAccount)|^LayoutMyPay$)/i.test(row.module);
  const development = row.category === '调试/日志文本';
  return {
    ...row,
    usage: development ? 'development' : sdk ? 'sdk-account-payment' : row.category === 'UI消费位置确认' ? 'game-ui' : 'candidate',
    usage_basis: sdk && !development ? 'module-name-heuristic' : 'source-category',
    visibility: row.category === 'UI消费位置确认' ? 'confirmed-consumer' : 'candidate-only',
  };
}
function validateAndroid(value: unknown, at: string): OriginalAndroidText {
  const row = object(value, at);
  strings(row, ['source_uid', 'apk_entry', 'package', 'resource_id', 'resource_type', 'resource_name', 'locale_language', 'locale_region', 'config_hex', 'text', 'category'], at);
  number(row.pool_index, `${at}/pool_index`);
  boolean(row.has_cjk, `${at}/has_cjk`);
  if (!own(row, 'map_key')) throw new Error(`${at}: missing map_key`);
  const sdk = /(?:sdk|login|account|pay|billing|oauth|taptap)/i.test(string(row.resource_name, `${at}/resource_name`));
  return { ...row, usage: sdk ? 'sdk-account-payment' : 'candidate', usage_basis: sdk ? 'resource-name-heuristic' : 'android-supplement-only' } as unknown as OriginalAndroidText;
}
function validateFlop(value: unknown, at: string): OriginalStoryflop {
  const row = object(value, at);
  strings(row, ['source_uid', 'table', 'id', 'original_name'], at);
  const raw = object(row.raw_record, `${at}/raw_record`);
  string(raw.name, `${at}/raw_record/name`);
  numberArray(raw.a_id_dh, `${at}/raw_record/a_id_dh`);
  for (const key of ['a_tp', 'a_mz', 'a_nr', 'a_mz_tr', 'a_nr_tr']) stringArray(raw[key], `${at}/raw_record/${key}`);
  const lengths = object(row.array_lengths, `${at}/array_lengths`);
  for (const [key, count] of Object.entries(lengths)) number(count, `${at}/array_lengths/${key}`);
  boolean(row.parallel_lengths_equal, `${at}/parallel_lengths_equal`);
  array(row.nodes, `${at}/nodes`).forEach((value, index) => {
    const node = object(value, `${at}/nodes/${index}`);
    number(node.array_index, `${at}/nodes/${index}/array_index`);
    number(node.a_id_dh, `${at}/nodes/${index}/a_id_dh`);
    strings(node, ['a_tp', 'a_mz', 'a_nr', 'a_mz_tr', 'a_nr_tr', 'node_category'], `${at}/nodes/${index}`);
    if (own(node, 'portrait_semantic_status')) string(node.portrait_semantic_status, `${at}/nodes/${index}/portrait_semantic_status`);
    if (own(node, 'portrait_slots_derived')) array(node.portrait_slots_derived, `${at}/nodes/${index}/portrait_slots_derived`).forEach((value, slot) => {
      const portrait = object(value, `${at}/nodes/${index}/portrait_slots_derived/${slot}`);
      strings(portrait, ['position_zh', 'image_id_raw'], `${at}/nodes/${index}/portrait_slots_derived/${slot}`);
      number(portrait.pos, `${at}/nodes/${index}/portrait_slots_derived/${slot}/pos`);
      number(portrait.image_id, `${at}/nodes/${index}/portrait_slots_derived/${slot}/image_id`);
    });
    if (own(node, 'options_literal')) array(node.options_literal, `${at}/nodes/${index}/options_literal`).forEach((value, optionIndex) => {
      const option = object(value, `${at}/nodes/${index}/options_literal/${optionIndex}`);
      strings(option, ['target_expression_raw', 'label', 'raw', 'semantic_status'], `${at}/nodes/${index}/options_literal/${optionIndex}`);
      stringArray(option.target_ids_raw, `${at}/nodes/${index}/options_literal/${optionIndex}/target_ids_raw`);
      boolean(option.is_multi_target, `${at}/nodes/${index}/options_literal/${optionIndex}/is_multi_target`);
      if (own(option, 'target_id_raw')) string(option.target_id_raw, `${at}/nodes/${index}/options_literal/${optionIndex}/target_id_raw`);
    });
  });
  return row as unknown as OriginalStoryflop;
}
function validateDictionaries(value: unknown): OriginalLocalizationDictionaries {
  const at = FILES.dictionaries;
  const row = object(value, at);
  for (const key of ['language_codes', 'zh_overrides']) for (const [name, text] of Object.entries(object(row[key], `${at}/${key}`))) string(text, `${at}/${key}/${name}`);
  array(row.tr_effective_pairs, `${at}/tr_effective_pairs`).forEach((value, index) => strings(object(value, `${at}/tr_effective_pairs/${index}`), ['key', 'text', 'text_tr', 'source', 'base_source', 'translation_type'], `${at}/tr_effective_pairs/${index}`));
  array(row.native_system_language_arrays, `${at}/native_system_language_arrays`).forEach((value, index) => {
    const item = object(value, `${at}/native_system_language_arrays/${index}`);
    strings(item, ['source', 'module', 'source_kind', 'key', 'note'], `${at}/native_system_language_arrays/${index}`);
    for (const key of ['source_offset', 'native_array_length']) number(item[key], `${at}/native_system_language_arrays/${index}/${key}`);
    for (const key of ['values', 'language_order', 'missing_language_codes']) stringArray(item[key], `${at}/native_system_language_arrays/${index}/${key}`);
  });
  array(row.definition_history, `${at}/definition_history`).forEach((value, index) => {
    const item = object(value, `${at}/definition_history/${index}`);
    strings(item, ['source', 'module', 'source_kind', 'key', 'text', 'definition_kind', 'note'], `${at}/definition_history/${index}`);
    number(item.source_offset, `${at}/definition_history/${index}/source_offset`);
  });
  return row as unknown as OriginalLocalizationDictionaries;
}

function failure(error: unknown): OriginalScriptFailure {
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
    offset: error instanceof ReferenceSyntaxError ? error.offset : null,
    offsetUnit: 'utf16-code-unit',
  };
}
function sourceDefect(source: SourceScript, raw: string, error: ReferenceSyntaxError): OriginalScriptSourceDefect | undefined {
  const preserved = { originalType: 'string' as const, raw, execution: 'blocked' as const };
  if (source.table === 'Npc' && source.field === 'c_show' && /^-?\d+(?:,-?\d+)+$/.test(raw)) {
    return {
      ...preserved, rule: 'npc-visibility-comma-literal', offset: error.offset,
      message: 'Original Npc.c_show is a comma-separated numeric string. The original workShow consumer reads the visible variable, but no CSV-to-visible interpretation is evidenced. Preserve its string type and every character; block execution rather than inventing a truthy constant or visibility condition.',
    };
  }
  if (!error.message.startsWith('Unterminated string')) return undefined;
  if (source.source_uid === 'Npc/4602/c_work' && raw.slice(error.offset) === "';openDungeonHandInTSWP:;updateMapNpc:") {
    return {
      ...preserved, rule: 'unterminated-npc-option-string', offset: error.offset,
      message: 'The original option/color array opens a quote before ;openDungeonHandInTSWP:;updateMapNpc: and never closes it. It is not proven whether the tail is a string or commands. Preserve the entire original script, including all dialogue, and block the whole variant without constructing an executable prefix.',
    };
  }
  if (source.source_uid === 'Npc/13236/c_work' && ["'不过不用担心", "'不過不用擔心"].includes(raw.slice(error.offset))) {
    return {
      ...preserved, rule: 'truncated-npc-dialogue-string', offset: error.offset,
      message: 'The original last talk dialogue ends mid-string, with its quote, array close and remaining arguments absent. Preserve every supplied literal character; no missing dialogue, argument defaults or executable prefix is invented.',
    };
  }
  return undefined;
}
function compile(source: SourceScript, raw: string): Pick<Extract<OriginalScriptVariant, { status: 'compiled' }>, 'status' | 'ast' | 'recovery' | 'strictFailure'> | (Pick<Extract<OriginalScriptVariant, { status: 'failed' }>, 'status' | 'failure' | 'strictFailure'> & (
  | { classification: 'source-defect'; sourceDefect: OriginalScriptSourceDefect }
  | { classification: 'importer-gap' }
)) {
  try {
    return { status: 'compiled', ast: parseReferenceSyntax(raw), recovery: 'none' };
  } catch (strictError) {
    if (!(strictError instanceof ReferenceSyntaxError)) throw strictError;
    const strictFailure = failure(strictError);
    try {
      const ast = parseReferenceSyntax(raw, { recoverSourceDefects: true });
      return { status: 'compiled', ast, recovery: 'explicit-source-decisions', strictFailure };
    } catch (recoveryError) {
      if (!(recoveryError instanceof ReferenceSyntaxError)) throw recoveryError;
      const defect = sourceDefect(source, raw, recoveryError);
      return {
        status: 'failed', failure: failure(recoveryError), strictFailure,
        ...(defect ? { classification: 'source-defect' as const, sourceDefect: defect } : { classification: 'importer-gap' as const }),
      };
    }
  }
}
function domain(table: string): OriginalScriptDomain {
  if (table === 'Skilleffect') return 'numeric-effect';
  if (table === 'Battle' || table === 'Battleindex') return 'battle-control';
  return 'story-control';
}
function collectAst(program: ReferenceSyntaxProgram, coverage: OriginalStoryManifest['executableCoverage']): void {
  const expression = (node: ReferenceExpression): void => {
    switch (node.kind) {
      case 'call': increment(coverage.commands, node.command); node.arguments.forEach(expression); break;
      case 'array': node.elements.forEach(expression); break;
      case 'index': expression(node.target); expression(node.index); break;
      case 'unary': expression(node.operand); break;
      case 'binary': expression(node.left); expression(node.right); break;
      case 'number': case 'string': case 'boolean': case 'null': case 'omitted': case 'identifier': break;
    }
  };
  const statement = (node: ReferenceStatement): void => {
    increment(coverage.statements, node.kind);
    switch (node.kind) {
      case 'assignment': expression(node.target); expression(node.value); break;
      case 'expression': expression(node.expression); break;
      case 'if': node.branches.forEach(branch => { expression(branch.condition); branch.statements.forEach(statement); }); node.otherwise.forEach(statement); break;
      case 'while': expression(node.condition); node.statements.forEach(statement); break;
      case 'directive': increment(coverage.directives, node.name); break;
      case 'source-annotation': case 'break': break;
    }
  };
  program.statements.forEach(statement);
  for (const decision of program.designDecisions) increment(coverage.designDecisions, decision.rule);
}

export interface OriginalStoryImportResult {
  config: OriginalStoryConfig;
  manifest: OriginalStoryManifest;
  /** Development-only: never import this object into application code. */
  audit: {
    schemaVersion: 1; developmentOnly: true; sourceVersion: string;
    scripts: Record<string, SourceScript>;
    parsedLines: SourceLine[];
    stringLiterals: unknown[];
    uiCandidates: SourceCandidate[];
    unreferencedSymbols: unknown[];
    extractionWarnings: unknown[];
    candidateParseErrors: unknown[];
    candidateExtractionMethod: string;
  };
}

/** Pure offline import. Reads package JSON, compiles data syntax, never executes original game code. */
export async function importOriginalStory(sourceDirectory: string): Promise<OriginalStoryImportResult> {
  const inputDirectory = resolve(sourceDirectory);
  const dataDirectory = basename(inputDirectory) === DATA_DIRECTORY ? inputDirectory : join(inputDirectory, DATA_DIRECTORY);
  const packageDirectory = dirname(dataDirectory);
  const inputs: OriginalStoryManifest['inputs'] = [];
  const load = async (directory: string, file: string): Promise<unknown> => {
    const bytes = await readFile(join(directory, file));
    inputs.push({ file: directory === dataDirectory ? `${DATA_DIRECTORY}/${file}` : file, bytes: bytes.byteLength, sha256: sha256(bytes) });
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as unknown;
  };
  const sourceManifest = object(await load(packageDirectory, MANIFEST_FILE), MANIFEST_FILE);
  const sourceApk = object(sourceManifest.source_apk, `${MANIFEST_FILE}/source_apk`);
  const sourceVersion = string(sourceApk.version, `${MANIFEST_FILE}/source_apk/version`);
  const sourceApkSha256 = string(sourceApk.sha256, `${MANIFEST_FILE}/source_apk/sha256`).toLowerCase();
  const sourceStats = object(sourceManifest.coverage_stats, `${MANIFEST_FILE}/coverage_stats`);
  const loaded: Record<string, unknown> = dictionary();
  // Fixed file order gives repeatable fingerprints, manifests and original array ordering.
  for (const [key, file] of Object.entries(FILES)) loaded[key] = await load(dataDirectory, file);
  const rows = <T>(key: keyof typeof FILES, validate: (value: unknown, at: string) => T): T[] => array(loaded[key], FILES[key]).map((value, index) => validate(value, `${FILES[key]}/${index}`));
  const business = rows('business', validateBusiness);
  const sourceScripts = rows('scripts', validateScript);
  const sourceLines = rows('lines', validateLine);
  const sourceFlops = rows('flops', validateFlop);
  const uiComponents = rows('ui', validateUi);
  const candidates = object(loaded.candidates, FILES.candidates);
  const sourceCandidates = array(candidates.records, `${FILES.candidates}/records`).map((value, index) => validateCandidate(value, `${FILES.candidates}/records/${index}`));
  const dictionaries = validateDictionaries(loaded.dictionaries);
  const androidSupplement = rows('android', validateAndroid);
  const config: OriginalStoryConfig = {
    schemaVersion: 1, sourceVersion,
    texts: { business, storyLines: [], uiComponents, uiCandidates: sourceCandidates.map(classifyCandidate), androidSupplement },
    scripts: dictionary(), records: dictionary(), storyflops: dictionary(), dictionaries,
  };
  const manifest: OriginalStoryManifest = {
    schemaVersion: 1, sourceVersion, sourceApkSha256, ok: false, inputs, outputs: [],
    counts: dictionary(), perTable: dictionary(), classificationCounts: dictionary(),
    coverage: { checks: [], errors: [], missingStructure: MISSING_STRUCTURE },
    executableCoverage: {
      semantics: 'syntax-only', runtimeCommandsVerified: false, completePlayableCoverage: false,
      compiledVariants: 0, failedVariants: 0, recoveredVariants: 0, sourceDefectVariants: 0, importerGapVariants: 0,
      commands: dictionary(), directives: dictionary(), statements: dictionary(), designDecisions: dictionary(), sourceTypes: dictionary(), failures: [],
    },
    limitations: [
      'Syntax compilation does not execute commands, conditions, macros, JavaScript strings or SDK calls, and does not certify runtime command implementation.',
      'branch_context is static extraction evidence; it never means a condition was evaluated or a branch occurred.',
      'Confirmed source defects remain failed, retain their exact original string and block whole-variant execution. Only unclassified importer grammar gaps fail the import gate; successful import is not complete playable coverage.',
      'Task.world/a_task/type and World.mainTask/unlock are absent from this text package; join an authoritative structural table before selecting a starting task or following task prerequisites.',
      'Event.task/npc/a_event and supplied script context are exact original links, not inferred from numeric ID or text order.',
      'Source statement_index uses extractor semicolon segments, not AST indices. Source DSL offsets are Python Unicode characters; compiler error/design-decision offsets are UTF-16 code units.',
      'Storyflop raw source and nodes coexist with Copylv ASTs; no universal Storyflop-to-Copylv conversion, random probability or runtime availability is invented.',
      'Localized UI _key is a lookup key and _text is a cache, not guaranteed final display text. Candidates and Android/SDK supplements are not promoted to confirmed game UI.',
      'Executable raw DSL, literal scans and JS candidate source expressions are development-only audit data. Blocked source defects additionally retain their exact raw string in the payload for source fidelity, never execution. All supplied texts remain exact, with no generated prose or translation.',
    ],
  };
  const error = (code: string, detail: string, source_uid?: string): void => { manifest.coverage.errors.push({ code, detail, ...(source_uid === undefined ? {} : { source_uid }) }); };
  const check = (name: string, expected: number, actual: number): void => { manifest.coverage.checks.push({ name, expected, actual, passed: expected === actual }); };
  const tableCount = (table: string, key: string, amount = 1): void => {
    const counts = manifest.perTable[table] ?? (manifest.perTable[table] = dictionary());
    increment(counts, key, amount);
  };
  const record = (table: string, id: string): OriginalStoryRecord => {
    const tableRecords = config.records[table] ?? (config.records[table] = dictionary());
    return tableRecords[id] ?? (tableRecords[id] = {
      table, id, context: dictionary(), contextSourceUids: [], fields: dictionary(),
      missingStructuralFields: [...(MISSING_STRUCTURE.find(item => item.table === table)?.fields ?? [])],
    });
  };
  const field = (row: OriginalStoryRecord, name: string): OriginalStoryRecord['fields'][string] => row.fields[name] ?? (row.fields[name] = { textIndices: [], scriptSourceUids: [] });
  const businessUids = new Set<string>();
  business.forEach((row, index) => {
    if (businessUids.has(row.source_uid)) error('DUPLICATE_BUSINESS_UID', 'Duplicate business source UID; both text positions retained.', row.source_uid);
    businessUids.add(row.source_uid);
    field(record(row.table, row.id), row.field).textIndices.push(index);
    tableCount(row.table, 'paired_text_records');
    tableCount(row.table, 'base_text_values');
    if (row.text_tr !== null) tableCount(row.table, 'tr_text_values');
  });
  sourceScripts.forEach((row, source_index) => {
    if (own(config.scripts, row.source_uid)) { error('DUPLICATE_SCRIPT_UID', 'Cannot key duplicate source scripts without overwriting.', row.source_uid); return; }
    if (row.source_uid !== `${row.table}/${row.id}/${row.field}`) error('SCRIPT_IDENTITY', 'Source UID does not match original table/id/field.', row.source_uid);
    const script: OriginalScript = { source_uid: row.source_uid, source_index, table: row.table, id: row.id, field: row.field, domain: domain(row.table), context: row.context, variants: {} };
    const owner = record(row.table, row.id);
    for (const [key, value] of Object.entries(row.context)) {
      if (own(owner.context, key) && !isDeepStrictEqual(owner.context[key], value)) error('CONFLICTING_CONTEXT', `Different original values for context.${key}; no last-write-wins merge.`, row.source_uid);
      else owner.context[key] = value;
    }
    owner.contextSourceUids.push(row.source_uid);
    field(owner, row.field).scriptSourceUids.push(row.source_uid);
    tableCount(row.table, 'script_sources');
    const sourceType = `${row.table}/${row.field}`;
    const typeCoverage = manifest.executableCoverage.sourceTypes[sourceType] ?? (manifest.executableCoverage.sourceTypes[sourceType] = { sources: 0, variants: 0, compiled: 0, failed: 0 });
    typeCoverage.sources++;
    row.variants.forEach((source, variantIndex) => {
      const compiled = compile(row, source.raw);
      const variant: OriginalScriptVariant = {
        language: source.language, sourceSha256: sha256(source.raw), sourceCharacterCount: Array.from(source.raw).length,
        source_index: variantIndex, issues: source.issues, textIndices: [], ...compiled,
      };
      script.variants[source.language] = variant;
      typeCoverage.variants++;
      tableCount(row.table, 'script_variants');
      if (variant.status === 'compiled') {
        typeCoverage.compiled++;
        manifest.executableCoverage.compiledVariants++;
        if (variant.recovery !== 'none') manifest.executableCoverage.recoveredVariants++;
        collectAst(variant.ast, manifest.executableCoverage);
      } else {
        typeCoverage.failed++;
        manifest.executableCoverage.failedVariants++;
        if (variant.classification === 'source-defect') manifest.executableCoverage.sourceDefectVariants++;
        else manifest.executableCoverage.importerGapVariants++;
        manifest.executableCoverage.failures.push({
          source_uid: row.source_uid, table: row.table, id: row.id, field: row.field, language: source.language,
          domain: script.domain, failure: variant.failure, classification: variant.classification,
          ...(variant.sourceDefect ? { sourceDefect: variant.sourceDefect } : {}),
        });
      }
    });
    config.scripts[row.source_uid] = script;
  });
  sourceLines.forEach((source, index) => {
    const { raw_arguments: _arguments, speaker_raw: _speakerRaw, ...row } = source;
    const line: OriginalStoryLine = { ...row, branch_context_semantics: 'static-source-evidence-only' };
    config.texts.storyLines.push(line);
    const script = config.scripts[row.source_uid];
    const variant = script?.variants[row.language];
    if (!variant || script.table !== row.table || script.id !== row.id || script.field !== row.field) error('ORPHAN_STORY_LINE', `Language ${row.language}, source line index ${index} has no matching script variant.`, row.source_uid);
    else variant.textIndices.push(index);
    tableCount(row.table, row.language === 'base' ? 'script_base_lines' : 'script_tr_lines');
  });
  sourceFlops.forEach(row => {
    if (own(config.storyflops, row.id)) { error('DUPLICATE_STORYFLOP_ID', 'Duplicate original Storyflop ID.', row.source_uid); return; }
    if (row.table !== 'Storyflop' || row.source_uid !== `Storyflop/${row.id}`) error('STORYFLOP_IDENTITY', 'Unexpected original table or source UID.', row.source_uid);
    const keys = ['a_id_dh', 'a_tp', 'a_mz', 'a_nr', 'a_mz_tr', 'a_nr_tr'] as const;
    const length = row.raw_record.a_id_dh.length;
    if (!row.parallel_lengths_equal || row.nodes.length !== length) error('STORYFLOP_LENGTHS', 'Original parallel arrays or node lengths differ.', row.source_uid);
    for (const key of keys) if (row.raw_record[key].length !== length || row.array_lengths[key] !== row.raw_record[key].length) error('STORYFLOP_LENGTHS', `Mismatch in ${key}.`, row.source_uid);
    row.nodes.forEach((node, index) => {
      if (node.array_index !== index || keys.some(key => !isDeepStrictEqual(node[key], row.raw_record[key][index]))) error('STORYFLOP_NODE_SOURCE', `Node ${index} does not match exact parallel-array position.`, row.source_uid);
    });
    config.storyflops[row.id] = row;
    record(row.table, row.id);
  });
  const countClassification = (group: string, key: string): void => {
    const counts = manifest.classificationCounts[group] ?? (manifest.classificationCounts[group] = dictionary());
    increment(counts, key);
  };
  business.forEach(row => countClassification('business', row.category));
  sourceLines.forEach(row => { countClassification('storyLineLanguage', row.language); countClassification('storyLineClass', row.classification); });
  uiComponents.forEach(row => countClassification('uiComponent', row.category));
  config.texts.uiCandidates.forEach(row => countClassification('uiCandidateUsage', row.usage));
  androidSupplement.forEach(row => countClassification('androidUsage', row.usage));
  Object.values(config.scripts).forEach(row => countClassification('scriptDomain', row.domain));
  const literalRows = array(loaded.literals, FILES.literals);
  const warnings = array(loaded.warnings, FILES.warnings);
  const unreferencedSymbols = array(candidates.unreferenced_symbol_candidates, `${FILES.candidates}/unreferenced_symbol_candidates`);
  const candidateErrors = array(candidates.errors, `${FILES.candidates}/errors`);
  const sourceVariantCount = sourceScripts.reduce((total, row) => total + row.variants.length, 0);
  manifest.counts = {
    businessTexts: business.length, businessTranslations: business.filter(row => row.text_tr !== null).length,
    scriptSources: sourceScripts.length, scriptVariants: sourceVariantCount,
    indexedScriptSources: Object.keys(config.scripts).length,
    storyLines: config.texts.storyLines.length, literalAuditRows: literalRows.length,
    storyflopRecords: sourceFlops.length, storyflopNodes: sourceFlops.reduce((total, row) => total + row.nodes.length, 0),
    storyflopOptions: sourceFlops.reduce((total, row) => total + row.nodes.reduce((sum, node) => sum + (node.options_literal?.length ?? 0), 0), 0),
    storyflopMultiTargetOptions: sourceFlops.reduce((total, row) => total + row.nodes.reduce((sum, node) => sum + (node.options_literal?.filter(option => option.is_multi_target).length ?? 0), 0), 0),
    uiComponents: uiComponents.length, uiCandidates: sourceCandidates.length, unreferencedSymbolCandidates: unreferencedSymbols.length,
    androidSupplement: androidSupplement.length, trEffectivePairs: dictionaries.tr_effective_pairs.length,
    zhOverrides: Object.keys(dictionaries.zh_overrides).length, nativeLanguageArrays: dictionaries.native_system_language_arrays.length,
    dictionaryDefinitionHistory: dictionaries.definition_history.length, extractionWarnings: warnings.length,
    tables: Object.keys(config.records).length,
    records: Object.values(config.records).reduce((total, rows) => total + Object.keys(rows).length, 0),
    compiledVariants: manifest.executableCoverage.compiledVariants, failedVariants: manifest.executableCoverage.failedVariants,
    sourceDefectVariants: manifest.executableCoverage.sourceDefectVariants, importerGapVariants: manifest.executableCoverage.importerGapVariants,
  };
  const sourceChecks: [string, number][] = [
    ['business_paired_records', business.length], ['business_base_values', business.length],
    ['business_tr_values', manifest.counts.businessTranslations], ['script_sources', sourceScripts.length],
    ['script_variants', sourceVariantCount], ['script_text_lines', sourceLines.length],
    ['storyflop_rows', sourceFlops.length], ['storyflop_nodes', manifest.counts.storyflopNodes],
    ['script_ast_occurrences', sourceCandidates.length], ['tr_effective_dictionary_keys', dictionaries.tr_effective_pairs.length],
    ['zh_override_keys', Object.keys(dictionaries.zh_overrides).length], ['script_issues_variant_records', warnings.length],
  ];
  for (const [key, actual] of sourceChecks) check(`source-manifest/${key}`, number(sourceStats[key], `${MANIFEST_FILE}/coverage_stats/${key}`), actual);
  const expectedTables = object(sourceStats.per_table, `${MANIFEST_FILE}/coverage_stats/per_table`);
  for (const [table, value] of Object.entries(expectedTables)) {
    for (const [key, expected] of Object.entries(object(value, `${MANIFEST_FILE}/coverage_stats/per_table/${table}`))) check(`table/${table}/${key}`, number(expected, `${MANIFEST_FILE}/coverage_stats/per_table/${table}/${key}`), manifest.perTable[table]?.[key] ?? 0);
  }
  for (const [key, group] of [['script_line_languages', 'storyLineLanguage'], ['script_line_classes', 'storyLineClass']] as const) {
    for (const [name, expected] of Object.entries(object(sourceStats[key], `${MANIFEST_FILE}/coverage_stats/${key}`))) check(`${key}/${name}`, number(expected, `${MANIFEST_FILE}/coverage_stats/${key}/${name}`), manifest.classificationCounts[group]?.[name] ?? 0);
  }
  const resourceStats = object(sourceStats.resource_extraction, `${MANIFEST_FILE}/coverage_stats/resource_extraction`);
  const androidStats = object(resourceStats.android, `${MANIFEST_FILE}/coverage_stats/resource_extraction/android`);
  check('android/records', number(androidStats.records, 'source-manifest/android/records'), androidSupplement.length);
  check('ui/component-text-records', number(resourceStats.component_text_records, 'source-manifest/ui/component_text_records'), uiComponents.filter(row => row.category === '预制界面显示/输入文本（编辑器默认值）').length);
  for (const [category, expected] of Object.entries(object(resourceStats.category_counts, 'source-manifest/ui/category_counts'))) check(`ui/category/${category}`, number(expected, `source-manifest/ui/category_counts/${category}`), manifest.classificationCounts.uiComponent?.[category] ?? 0);
  check('index/all-script-sources', sourceScripts.length, Object.keys(config.scripts).length);
  check('index/all-script-variants', sourceVariantCount, manifest.executableCoverage.compiledVariants + manifest.executableCoverage.failedVariants);
  check('compilation/all-failures-classified', manifest.executableCoverage.failedVariants, manifest.executableCoverage.sourceDefectVariants + manifest.executableCoverage.importerGapVariants);
  check('compilation/no-importer-gaps', 0, manifest.executableCoverage.importerGapVariants);
  const preservedDefects = manifest.executableCoverage.failures.filter(row => {
    const defect = row.sourceDefect;
    if (row.classification !== 'source-defect' || defect?.execution !== 'blocked' || defect.originalType !== 'string') return false;
    const original = sourceScripts.find(source => source.source_uid === row.source_uid);
    return original?.variants.some(variant => variant.language === row.language && variant.raw === defect.raw);
  });
  check('compilation/source-defects-preserved-and-blocked', manifest.executableCoverage.sourceDefectVariants, preservedDefects.length);
  check('ui-candidates/no-extraction-errors', 0, candidateErrors.length);
  check('storyflop/all-records-indexed', sourceFlops.length, Object.keys(config.storyflops).length);
  const auditScripts: Record<string, SourceScript> = dictionary();
  sourceScripts.forEach(row => { if (!own(auditScripts, row.source_uid)) auditScripts[row.source_uid] = row; });
  manifest.ok = manifest.coverage.errors.length === 0 && manifest.coverage.checks.every(row => row.passed);
  return {
    config, manifest,
    audit: {
      schemaVersion: 1, developmentOnly: true, sourceVersion,
      scripts: auditScripts, parsedLines: sourceLines, stringLiterals: literalRows,
      uiCandidates: sourceCandidates, unreferencedSymbols, extractionWarnings: warnings,
      candidateParseErrors: candidateErrors, candidateExtractionMethod: string(candidates.method, `${FILES.candidates}/method`),
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--source') throw new Error('Usage: node --import tsx tools/data/import-original-story.ts --source <text-package-directory>');
  const result = await importOriginalStory(args[1]);
  const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const generatedDirectory = join(projectDirectory, 'assets/original-data');
  const configFile = 'assets/original-data/original-story.json';
  const auditFile = 'assets/original-data/original-story-audit.json';
  const configJson = `${JSON.stringify(result.config)}\n`;
  const auditJson = `${JSON.stringify(result.audit)}\n`;
  result.manifest.outputs = [
    { file: configFile, bytes: Buffer.byteLength(configJson), sha256: sha256(configJson), developmentOnly: false },
    { file: auditFile, bytes: Buffer.byteLength(auditJson), sha256: sha256(auditJson), developmentOnly: true },
  ];
  await mkdir(generatedDirectory, { recursive: true });
  await writeFile(join(projectDirectory, configFile), configJson, 'utf8');
  await writeFile(join(projectDirectory, auditFile), auditJson, 'utf8');
  // Manifest is written last. Failed source variants stay discriminated failures, never empty ASTs.
  await writeFile(join(generatedDirectory, 'original-story-manifest.json'), `${JSON.stringify(result.manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: result.manifest.ok, counts: result.manifest.counts, failedSourceTypes: Object.fromEntries(Object.entries(result.manifest.executableCoverage.sourceTypes).filter(([, row]) => row.failed > 0)) }, null, 2));
  if (!result.manifest.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Avoid leaking machine-specific source paths into generated metadata or command diagnostics.
    console.error(error instanceof Error && !('code' in error) ? error.message : 'Original story import could not read or write a required file.');
    process.exitCode = 1;
  });
}
