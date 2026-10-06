import {
  effectiveField, type ImportResult, type JsonValue, type ReferenceSource,
} from './reference-import';

interface Decimal { coefficient: bigint; exponent: number }
export interface NumericPoint { sourceId: string; rawValue: number | string; decimal: { coefficient: string; exponent: number }; unsafeNumber: boolean }
export interface AttributeCurve {
  field: string;
  eligibleCount: number;
  excluded: { sourceId: string; presence: string; rawValue: JsonValue; reason: string }[];
  sorted: NumericPoint[];
  quantiles: Record<string, NumericPoint | null>;
  percentileBySourceId: Record<string, number>;
}
export interface DslOccurrence { table: string; sourceId: string; field: string; offset: number; sourceFile: string | null; snippet: string }
export interface DslInventory {
  execution: 'never';
  interpretation: 'lexical-candidates-not-verified-APIs';
  fields: { table: string; field: string; rows: number; strings: number; emptyStrings: number; nulls: number; absent: number; nonStrings: number }[];
  candidates: { name: string; occurrences: DslOccurrence[] }[];
  controlSyntax: { name: string; occurrences: DslOccurrence[] }[];
  texts: { table: string; sourceId: string; field: string; rawValue: JsonValue; presence: string; sourceFile: string | null }[];
}

/** Exact decimal comparison retains e.g. the 1e19 HP numeric string; no float interpolation. */
export function parseDecimal(value: JsonValue): Decimal | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(value));
  if (!match) return undefined;
  const exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) return undefined;
  let coefficient = BigInt(`${match[1] === '-' ? '-' : ''}${match[2]}${match[3] ?? ''}`);
  let normalizedExponent = exponent;
  if (coefficient === 0n) return { coefficient: 0n, exponent: 0 };
  while (coefficient % 10n === 0n) { coefficient /= 10n; normalizedExponent++; }
  return { coefficient, exponent: normalizedExponent };
}
export function compareDecimals(left: Decimal, right: Decimal): number {
  const exponent = Math.min(left.exponent, right.exponent);
  const a = left.coefficient * 10n ** BigInt(left.exponent - exponent);
  const b = right.coefficient * 10n ** BigInt(right.exponent - exponent);
  return a < b ? -1 : a > b ? 1 : 0;
}
export function compareOriginalIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    if (a !== b) return a < b ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}
export function selectPlayerRoles(source: ReferenceSource): { vehicles: string[]; pilots: string[]; unclassified: string[] } {
  const roles = source.tables.Role;
  if (!roles) throw new Error('Role table is required.');
  const vehicles: string[] = [];
  const pilots: string[] = [];
  const unclassified: string[] = [];
  for (const [id, row] of Object.entries(roles.data)) {
    const profession = effectiveField(row, roles.defaults, 'profession').value;
    const number = parseDecimal(profession);
    if (!number) { unclassified.push(id); continue; }
    if (compareDecimals(number, { coefficient: 10n, exponent: 0 }) > 0 && compareDecimals(number, { coefficient: 20n, exponent: 0 }) < 0) vehicles.push(id);
    if (compareDecimals(number, { coefficient: 20n, exponent: 0 }) > 0 && compareDecimals(number, { coefficient: 30n, exponent: 0 }) < 0) pilots.push(id);
  }
  return { vehicles: vehicles.sort(compareOriginalIds), pilots: pilots.sort(compareOriginalIds), unclassified: unclassified.sort(compareOriginalIds) };
}
export function attributeCurve(source: ReferenceSource, ids: string[], field: string): AttributeCurve {
  const table = source.tables.Role;
  const points: { decimal: Decimal; output: NumericPoint }[] = [];
  const excluded: AttributeCurve['excluded'] = [];
  for (const sourceId of ids) {
    const effective = effectiveField(table.data[sourceId], table.defaults, field);
    const decimal = effective.presence === 'absent' ? undefined : parseDecimal(effective.value);
    if (!decimal || (typeof effective.value !== 'number' && typeof effective.value !== 'string')) {
      const reason = effective.presence === 'absent' ? 'absent' : effective.value === null ? 'explicit-null' : effective.value === '' ? 'empty-string' : typeof effective.value === 'string' ? 'expression-or-non-numeric-string' : 'non-numeric-type';
      excluded.push({ sourceId, presence: effective.presence, rawValue: effective.value, reason });
    } else {
      points.push({ decimal, output: { sourceId, rawValue: effective.value, decimal: { coefficient: decimal.coefficient.toString(), exponent: decimal.exponent }, unsafeNumber: typeof effective.value === 'number' && Number.isInteger(effective.value) && !Number.isSafeInteger(effective.value) } });
    }
  }
  points.sort((a, b) => compareDecimals(a.decimal, b.decimal) || compareOriginalIds(a.output.sourceId, b.output.sourceId));
  const quantiles: AttributeCurve['quantiles'] = {};
  for (const quantile of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    quantiles[String(quantile)] = points.length ? points[Math.max(0, Math.ceil(quantile * points.length) - 1)].output : null;
  }
  const percentileBySourceId: Record<string, number> = {};
  for (let index = 0; index < points.length;) {
    let end = index + 1;
    while (end < points.length && compareDecimals(points[index].decimal, points[end].decimal) === 0) end++;
    // Empirical CDF: every tied value gets the same upper rank. No invented game stats.
    for (let position = index; position < end; position++) percentileBySourceId[points[position].output.sourceId] = end / points.length;
    index = end;
  }
  return { field, eligibleCount: points.length, excluded, sorted: points.map(point => point.output), quantiles, percentileBySourceId };
}

/** Discover c_work in every table, not only Skilleffect; expression fields are separate domains. */
export function inventoryDsl(result: ImportResult): DslInventory {
  const candidates = new Map<string, DslOccurrence[]>();
  const controls = new Map<string, DslOccurrence[]>();
  const fields: DslInventory['fields'] = [];
  const texts: DslInventory['texts'] = [];
  const recordFiles = new Map(result.records.map(record => [`${record.table}\u0000${record.sourceId}`, record.sourceFile]));
  for (const [tableName, table] of Object.entries(result.source.tables)) {
    const domains = [...new Set([...table.keys, ...Object.keys(table.defaults), ...Object.values(table.data).flatMap(row => Object.keys(row))])].filter(field => field === 'c_work' || (tableName === 'Role' && (field === 'value1' || field === 'value2')) || (tableName === 'Battle' && field === 'lv_work'));
    for (const field of domains) {
      const stats = { table: tableName, field, rows: 0, strings: 0, emptyStrings: 0, nulls: 0, absent: 0, nonStrings: 0 };
      for (const [sourceId, row] of Object.entries(table.data)) {
        stats.rows++;
        const effective = effectiveField(row, table.defaults, field);
        const rawValue = effective.value;
        const sourceFile = recordFiles.get(`${tableName}\u0000${sourceId}`) ?? null;
        texts.push({ table: tableName, sourceId, field, rawValue, presence: effective.presence, sourceFile });
        if (effective.presence === 'absent') { stats.absent++; continue; }
        if (rawValue === null) { stats.nulls++; continue; }
        if (typeof rawValue !== 'string') { stats.nonStrings++; continue; }
        stats.strings++;
        if (rawValue === '') { stats.emptyStrings++; continue; }
        for (const match of rawValue.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
          const name = match[1];
          const offset = match.index ?? 0;
          const occurrence = { table: tableName, sourceId, field, sourceFile, offset, snippet: rawValue.slice(Math.max(0, offset - 35), offset + match[0].length + 100) };
          const occurrences = candidates.get(name);
          if (occurrences) occurrences.push(occurrence);
          else candidates.set(name, [occurrence]);
        }
        for (const match of rawValue.matchAll(/\b(if|elseif|else|endif|while|end|break|and|or|not)\b/g)) {
          const name = match[1];
          const offset = match.index ?? 0;
          const occurrence = { table: tableName, sourceId, field, sourceFile, offset, snippet: rawValue.slice(Math.max(0, offset - 20), offset + 80) };
          const occurrences = controls.get(name);
          if (occurrences) occurrences.push(occurrence);
          else controls.set(name, [occurrence]);
        }
      }
      fields.push(stats);
    }
  }
  return {
    execution: 'never', interpretation: 'lexical-candidates-not-verified-APIs', fields, texts,
    candidates: [...candidates].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, occurrences]) => ({ name, occurrences })),
    controlSyntax: [...controls].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, occurrences]) => ({ name, occurrences })),
  };
}
