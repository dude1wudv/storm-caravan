import type { ReferenceSyntaxProgram } from './reference-syntax';

export type OriginalJson = null | boolean | number | string | OriginalJson[] | { [key: string]: OriginalJson };
export type OriginalLanguage = 'base' | 'tr';
export type OriginalTextUsage = 'game-ui' | 'candidate' | 'sdk-account-payment' | 'development';
export type OriginalScriptDomain = 'story-control' | 'battle-control' | 'numeric-effect';

/** Source names, IDs, fields and array positions are never translated or re-numbered. */
export interface OriginalBusinessText {
  source_uid: string;
  table: string;
  id: string;
  field: string;
  field_path: string;
  array_path: (string | number)[];
  category: string;
  text: string;
  text_tr: string | null;
  original_record_name: string;
  source_status: string;
  visibility: string;
  table_zh: string;
  field_zh: string;
  source_language: string;
  translation_language: string | null;
  text_role?: string;
}

/** Static extraction evidence, NOT an evaluated predicate or an executed branch. */
export interface OriginalBranchEvidence { if_statement: string; active_branch: string }
export interface OriginalStoryLine {
  source_uid: string;
  table: string;
  id: string;
  field: string;
  record_name: string;
  language: OriginalLanguage;
  /** Source extractor's semicolon-segment index; NOT an AST statement index. */
  statement_index: number;
  /** Original extractor path; its meaning depends on command and parse_status. */
  line_path: number[];
  command: string;
  speaker: string | null;
  text: string;
  branch_context: OriginalBranchEvidence[];
  branch_context_semantics: 'static-source-evidence-only';
  classification: string;
  parse_status: string;
  field_zh: string;
  command_zh: string;
}

export interface OriginalUiText {
  source_uid: string;
  apk_entry: string;
  json_pointer: string;
  asset_paths: { asset_path: string; asset_type: string }[];
  component_class: string;
  field: string;
  instance_pointer: string;
  embedded: boolean;
  node_reference_raw: OriginalJson;
  node_index: number | null;
  node_name: string | null;
  category: string;
  text: string;
  has_cjk: boolean;
  source_status: string;
  localization_key?: string;
  cached_text?: string | null;
  localization_status?: string;
  field_zh: string;
}

/** No JS expressions or expanded source code is included in the runtime payload. */
export interface OriginalUiCandidate {
  source: string;
  module: string;
  function: string;
  offset: number;
  line: number;
  column: number;
  ast_type: string;
  category: string;
  dynamic_fragment: boolean;
  text: string;
  assignment_target: string;
  call_target: string;
  usage: OriginalTextUsage;
  usage_basis: 'source-category' | 'module-name-heuristic';
  visibility: 'confirmed-consumer' | 'candidate-only';
}

export interface OriginalAndroidText {
  source_uid: string;
  apk_entry: string;
  package: string;
  resource_id: string;
  resource_type: string;
  resource_name: string;
  locale_language: string;
  locale_region: string;
  config_hex: string;
  map_key: OriginalJson;
  pool_index: number;
  text: string;
  has_cjk: boolean;
  category: string;
  usage: 'sdk-account-payment' | 'candidate';
  usage_basis: 'resource-name-heuristic' | 'android-supplement-only';
}

/** Exact source diagnostics; source offsets use Python Unicode-character positions, not compiler UTF-16 offsets. */
export type OriginalScriptIssue =
  | { issue: string; statement_index?: number }
  | { error: string; statement_index: number; offset: number; raw_literal: string; text_fragment: string };
export interface OriginalScriptFailure { name: string; message: string; offset: number | null; offsetUnit: 'utf16-code-unit' }
/** Confirmed source defect, not an importer grammar gap. No executable AST is manufactured. */
export interface OriginalScriptSourceDefect {
  rule: 'npc-visibility-comma-literal' | 'unterminated-npc-option-string' | 'truncated-npc-dialogue-string';
  offset: number;
  message: string;
  originalType: 'string';
  raw: string;
  execution: 'blocked';
}
export type OriginalScriptVariant = {
  language: OriginalLanguage;
  /** Hash and index bind this AST to the exact development-only DSL source. */
  sourceSha256: string;
  sourceCharacterCount: number;
  source_index: number;
  issues: OriginalScriptIssue[];
  /** Indices into texts.storyLines, in the original extraction order. */
  textIndices: number[];
} & (
  | { status: 'compiled'; ast: ReferenceSyntaxProgram; recovery: 'none' | 'explicit-source-decisions'; strictFailure?: OriginalScriptFailure }
  | { status: 'failed'; failure: OriginalScriptFailure; strictFailure: OriginalScriptFailure } & (
    | { classification: 'source-defect'; sourceDefect: OriginalScriptSourceDefect }
    | { classification: 'importer-gap'; sourceDefect?: never }
  )
);
export interface OriginalScript {
  source_uid: string;
  source_index: number;
  table: string;
  id: string;
  field: string;
  domain: OriginalScriptDomain;
  context: Record<string, OriginalJson>;
  variants: Partial<Record<OriginalLanguage, OriginalScriptVariant>>;
}

export interface OriginalStoryRecord {
  table: string;
  id: string;
  /** Exact context supplied by script sources. Empty means not supplied, not zero/default. */
  context: Record<string, OriginalJson>;
  contextSourceUids: string[];
  fields: Record<string, { textIndices: number[]; scriptSourceUids: string[] }>;
  /** Text package does not supply these structural columns; never infer from ID ordering. */
  missingStructuralFields: string[];
}

export interface OriginalStoryflopOption {
  target_expression_raw: string;
  target_ids_raw: string[];
  target_id_raw?: string;
  label: string;
  raw: string;
  is_multi_target: boolean;
  semantic_status: string;
}
export interface OriginalStoryflopNode {
  array_index: number;
  a_id_dh: number;
  a_tp: string;
  a_mz: string;
  a_nr: string;
  a_mz_tr: string;
  a_nr_tr: string;
  node_category: string;
  portrait_slots_derived?: { pos: number; position_zh: string; image_id_raw: string; image_id: number }[];
  portrait_semantic_status?: string;
  options_literal?: OriginalStoryflopOption[];
}
export interface OriginalStoryflop {
  source_uid: string;
  table: string;
  id: string;
  original_name: string;
  /** Source encoding, not DSL; kept whole, including empty fields and parallel array order. */
  raw_record: { name: string; a_id_dh: number[]; a_tp: string[]; a_mz: string[]; a_nr: string[]; a_mz_tr: string[]; a_nr_tr: string[] };
  array_lengths: Record<string, number>;
  parallel_lengths_equal: boolean;
  nodes: OriginalStoryflopNode[];
}

export interface OriginalLocalizationDictionaries {
  language_codes: Record<string, string>;
  tr_effective_pairs: { key: string; text: string; text_tr: string; source: string; base_source: string; translation_type: string }[];
  zh_overrides: Record<string, string>;
  native_system_language_arrays: {
    source: string; module: string; source_kind: string; source_offset: number; key: string;
    values: string[]; language_order: string[]; native_array_length: number;
    missing_language_codes: string[]; note: string;
  }[];
  definition_history: {
    source: string; module: string; source_kind: string; source_offset: number;
    key: string; text: string; definition_kind: string; note: string;
  }[];
}

/** Offline imported text/AST only. No SDK networking, no DSL eval, no fabricated story. */
export interface OriginalStoryConfig {
  schemaVersion: 1;
  sourceVersion: string;
  texts: {
    business: OriginalBusinessText[];
    storyLines: OriginalStoryLine[];
    uiComponents: OriginalUiText[];
    uiCandidates: OriginalUiCandidate[];
    androidSupplement: OriginalAndroidText[];
  };
  /** Key is exact source_uid (e.g. Event/100/c_work). Failed variants never have ast. */
  scripts: Record<string, OriginalScript>;
  /** First key is original table, second key is original string ID. */
  records: Record<string, Record<string, OriginalStoryRecord>>;
  /** Original Storyflop ID, no inferred Copylv conversion. */
  storyflops: Record<string, OriginalStoryflop>;
  dictionaries: OriginalLocalizationDictionaries;
}

export interface OriginalStoryManifest {
  schemaVersion: 1;
  sourceVersion: string;
  sourceApkSha256: string;
  /** Compilation gate only, NOT a claim that commands are implemented by the game. */
  ok: boolean;
  inputs: { file: string; bytes: number; sha256: string }[];
  outputs: { file: string; bytes: number; sha256: string; developmentOnly: boolean }[];
  counts: Record<string, number>;
  perTable: Record<string, Record<string, number>>;
  classificationCounts: Record<string, Record<string, number>>;
  coverage: {
    checks: { name: string; expected: number; actual: number; passed: boolean }[];
    errors: { code: string; source_uid?: string; detail: string }[];
    missingStructure: { table: string; fields: string[]; reason: 'not-provided-in-text-package' }[];
  };
  executableCoverage: {
    semantics: 'syntax-only';
    runtimeCommandsVerified: false;
    /** Import success does not assert that all original branches can run. */
    completePlayableCoverage: false;
    compiledVariants: number;
    failedVariants: number;
    recoveredVariants: number;
    sourceDefectVariants: number;
    importerGapVariants: number;
    /** Occurrences are recursively counted in successfully compiled ASTs, never raw regex matches. */
    commands: Record<string, number>;
    directives: Record<string, number>;
    statements: Record<string, number>;
    designDecisions: Record<string, number>;
    sourceTypes: Record<string, { sources: number; variants: number; compiled: number; failed: number }>;
    failures: {
      source_uid: string; table: string; id: string; field: string; language: OriginalLanguage;
      domain: OriginalScriptDomain; failure: OriginalScriptFailure;
      classification: 'source-defect' | 'importer-gap'; sourceDefect?: OriginalScriptSourceDefect;
    }[];
  };
  limitations: string[];
}
