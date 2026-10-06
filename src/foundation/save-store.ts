import { encodeJson } from './json';
import { ORIGINAL_APK_SHA256 } from './original-data';

/** Subset implemented by Expo SQLite; also exercised against real Node SQLite. */
export interface SaveDatabase {
  execSync(sql: string): void;
  runSync(sql: string, ...params: (string | number | null)[]): { changes: number };
  getFirstSync<T>(sql: string, ...params: (string | number | null)[]): T | null;
  withTransactionSync(work: () => void): void;
}
export interface StateCodec<T> { version: number; parse(value: unknown): T }
export interface SavedState<T> { revision: number; state: T }
export interface SaveReceipt { operationId: string; requestFingerprint: string }
export interface CommitResult { revision: number; duplicate: boolean }
interface SlotRow { source_sha256: string; schema_version: number; revision: number; payload: string }
export class SaveConflict extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Save revision conflict: expected ${expectedRevision}, found ${actualRevision}`);
  }
}

/** Infrastructure schema, not the original game's player/save schema. No implicit new-game state. */
export class SaveStore<T> {
  constructor(private readonly db: SaveDatabase, private readonly codec: StateCodec<T>) {
    if (!Number.isSafeInteger(codec.version) || codec.version < 1) throw new Error('Invalid state schema version');
    db.execSync(`
      CREATE TABLE IF NOT EXISTS reconstruction_slots (
        slot TEXT PRIMARY KEY NOT NULL,
        source_sha256 TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK(schema_version > 0),
        revision INTEGER NOT NULL CHECK(revision > 0),
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reconstruction_receipts (
        slot TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        applied_revision INTEGER NOT NULL CHECK(applied_revision > 0),
        PRIMARY KEY(slot, operation_id)
      );
    `);
  }

  load(slot: string): SavedState<T> | null {
    this.checkSlot(slot);
    const row = this.db.getFirstSync<SlotRow>('SELECT * FROM reconstruction_slots WHERE slot = ?', slot);
    if (!row) return null;
    return this.decode(row);
  }

  /** Caller supplies a source-proven state transition. Receipt + snapshot commit atomically. */
  commit(slot: string, expectedRevision: number, state: T, receipt?: SaveReceipt): CommitResult {
    this.checkSlot(slot);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid expected save revision');
    }
    if (receipt && (!receipt.operationId.trim() || receipt.operationId.length > 256 || !/^[0-9a-f]{64}$/.test(receipt.requestFingerprint))) {
      throw new Error('Invalid operation receipt');
    }
    // Validate the actual round-tripped payload, not only the caller's in-memory object.
    const payload = encodeJson(state);
    this.codec.parse(JSON.parse(payload));
    const nextRevision = expectedRevision + 1;
    let result: CommitResult = { revision: nextRevision, duplicate: false };
    this.db.withTransactionSync(() => {
      const row = this.db.getFirstSync<SlotRow>('SELECT * FROM reconstruction_slots WHERE slot = ?', slot);
      if (row) this.decode(row);
      if (receipt) {
        const previous = this.db.getFirstSync<{ request_fingerprint: string; applied_revision: number }>(
          'SELECT request_fingerprint, applied_revision FROM reconstruction_receipts WHERE slot = ? AND operation_id = ?',
          slot, receipt.operationId,
        );
        if (previous) {
          if (!row || previous.applied_revision > row.revision) throw new Error('Receipt references missing save state');
          if (previous.request_fingerprint !== receipt.requestFingerprint) throw new Error('Operation ID was reused for a different request');
          result = { revision: previous.applied_revision, duplicate: true };
          return;
        }
      }
      const actualRevision = row?.revision ?? 0;
      if (actualRevision !== expectedRevision) throw new SaveConflict(expectedRevision, actualRevision);
      if (row) {
        const changed = this.db.runSync(
          'UPDATE reconstruction_slots SET revision = ?, payload = ? WHERE slot = ? AND revision = ?',
          nextRevision, payload, slot, expectedRevision,
        );
        if (changed.changes !== 1) throw new SaveConflict(expectedRevision, actualRevision);
      } else {
        this.db.runSync(
          'INSERT INTO reconstruction_slots(slot, source_sha256, schema_version, revision, payload) VALUES (?, ?, ?, ?, ?)',
          slot, ORIGINAL_APK_SHA256, this.codec.version, nextRevision, payload,
        );
      }
      if (receipt) {
        this.db.runSync(
          'INSERT INTO reconstruction_receipts(slot, operation_id, request_fingerprint, applied_revision) VALUES (?, ?, ?, ?)',
          slot, receipt.operationId, receipt.requestFingerprint, nextRevision,
        );
      }
    });
    return result;
  }

  private decode(row: SlotRow): SavedState<T> {
    if (row.source_sha256 !== ORIGINAL_APK_SHA256) throw new Error('Save belongs to a different original version');
    if (row.schema_version !== this.codec.version) throw new Error('Save schema requires an explicit migration');
    if (!Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Invalid stored revision');
    return { revision: row.revision, state: this.codec.parse(JSON.parse(row.payload)) };
  }

  private checkSlot(slot: string): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(slot)) throw new Error('Invalid local save slot');
  }
}
