import { encodeJson, jsonObject, type JsonValue } from './json';

export const ORIGINAL_APK_SHA256 = 'd660393138d25d6419bc814e1662a3b693cb0a7cc973e3759b5e840271146e63';
export interface SourceProof {
  sourceApkSha256: string;
  sourceEntry: string;
  contentSha256: string;
  completeness: 'complete-table' | 'field-projection';
}
export type OriginalField =
  | { presence: 'explicit' | 'default'; value: JsonValue }
  | { presence: 'absent' };
interface OriginalTable { keys: string[]; defaults: Record<string, JsonValue>; data: Record<string, Record<string, JsonValue>> }
export type Sha256Text = (text: string) => Promise<string>;

/** Reads original table structure only. Neither IDs nor DSL strings imply execution order. */
export class OriginalTables {
  private constructor(private readonly tables: Record<string, OriginalTable>, readonly proof: Readonly<SourceProof>) {}

  static async load(text: string, proof: SourceProof, sha256: Sha256Text, root: 'tables' | 'document'): Promise<OriginalTables> {
    const provenance = Object.freeze({ ...proof });
    if (provenance.sourceApkSha256 !== ORIGINAL_APK_SHA256) throw new Error('Original APK baseline mismatch');
    if (!provenance.sourceEntry.trim() || !/^[0-9a-f]{64}$/.test(provenance.contentSha256)) throw new Error('Invalid source provenance');
    if (!['complete-table', 'field-projection'].includes(provenance.completeness)) throw new Error('Unknown source completeness');
    if (await sha256(text) !== provenance.contentSha256) throw new Error('Original data digest mismatch');
    const document = jsonObject(JSON.parse(text), 'Original source');
    const source = jsonObject(root === 'tables' ? document.tables : document, 'Original tables');
    const tables: Record<string, OriginalTable> = Object.create(null);
    for (const [name, raw] of Object.entries(source)) {
      const table = jsonObject(raw, `Table ${name}`);
      if (!Array.isArray(table.keys) || !table.keys.every((key): key is string => typeof key === 'string') || new Set(table.keys).size !== table.keys.length) {
        throw new Error(`Invalid keys in original table ${name}`);
      }
      const keys = table.keys;
      const defaults = jsonObject(table.defaults, `${name}.defaults`);
      const data = jsonObject(table.data, `${name}.data`);
      const rows: Record<string, Record<string, JsonValue>> = Object.create(null);
      const assertKeys = (row: Record<string, JsonValue>) => {
        for (const field of Object.keys(row)) if (!keys.includes(field)) throw new Error(`Undeclared original field ${name}.${field}`);
      };
      assertKeys(defaults);
      for (const [id, value] of Object.entries(data)) {
        rows[id] = jsonObject(value, `${name}/${id}`);
        assertKeys(rows[id]);
      }
      tables[name] = { keys, defaults, data: rows };
    }
    return new OriginalTables(tables, provenance);
  }

  names(): string[] { return Object.keys(this.tables); }
  ids(name: string): string[] { return Object.keys(this.table(name).data); }
  keys(name: string): string[] { return [...this.table(name).keys]; }

  requireComplete(): void {
    if (this.proof.completeness !== 'complete-table') throw new Error('Field projection cannot supply complete original table semantics');
  }

  field(name: string, id: string, key: string): OriginalField {
    const table = this.table(name);
    if (!Object.hasOwn(table.data, id)) throw new Error(`Missing original record ${name}/${id}`);
    if (!table.keys.includes(key)) throw new Error(`Field ${name}.${key} is not included in this source`);
    const row = table.data[id];
    if (Object.hasOwn(row, key)) return { presence: 'explicit', value: JSON.parse(encodeJson(row[key])) as JsonValue };
    if (Object.hasOwn(table.defaults, key)) return { presence: 'default', value: JSON.parse(encodeJson(table.defaults[key])) as JsonValue };
    return { presence: 'absent' };
  }

  private table(name: string): OriginalTable {
    if (!Object.hasOwn(this.tables, name)) throw new Error(`Missing original table ${name}`);
    return this.tables[name];
  }
}
