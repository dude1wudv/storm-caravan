import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { encodeJson } from '../src/foundation/json';
import { ORIGINAL_APK_SHA256, OriginalTables, type SourceProof } from '../src/foundation/original-data';
import { SaveConflict, SaveStore, type SaveDatabase, type StateCodec } from '../src/foundation/save-store';
import { ServiceClient, ServiceUnavailable, type ServiceBinding } from '../src/foundation/service-client';
import { SourceAssets, type SourceAsset } from '../src/foundation/source-assets';

const sha256 = async (value: string) => createHash('sha256').update(value).digest('hex');
const codec: StateCodec<{ marker: number }> = {
  version: 1,
  parse(value) {
    assert.ok(value !== null && typeof value === 'object' && 'marker' in value);
    assert.equal(typeof value.marker, 'number');
    assert.ok(Number.isSafeInteger(value.marker));
    return { marker: value.marker as number };
  },
};

function sqlite(path = ':memory:'): { native: DatabaseSync; db: SaveDatabase } {
  const native = new DatabaseSync(path);
  const db: SaveDatabase = {
    execSync(sql) { native.exec(sql); },
    runSync(sql, ...params) { return { changes: Number(native.prepare(sql).run(...params).changes) }; },
    getFirstSync<T>(sql: string, ...params: (string | number | null)[]): T | null {
      return (native.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    withTransactionSync(work) {
      native.exec('BEGIN IMMEDIATE');
      try { work(); native.exec('COMMIT'); } catch (error) { native.exec('ROLLBACK'); throw error; }
    },
  };
  return { native, db };
}

async function proof(text: string, completeness: SourceProof['completeness'] = 'field-projection'): Promise<SourceProof> {
  return { sourceApkSha256: ORIGINAL_APK_SHA256, sourceEntry: 'test fixture, not game configuration', contentSha256: await sha256(text), completeness };
}

test('JSON persistence rejects lossy values without treating explicit empties as missing', () => {
  assert.equal(encodeJson({ a: null, b: '', c: [], d: false, e: 0 }), '{"a":null,"b":"","c":[],"d":false,"e":0}');
  for (const value of [undefined, NaN, Infinity, { a: undefined }, [undefined], new Date(), [, 1]]) {
    assert.throws(() => encodeJson(value));
  }
  const circular: unknown[] = []; circular.push(circular);
  assert.throws(() => encodeJson(circular), /Cyclic/);
  class CustomArray extends Array<number> { toJSON() { return null; } }
  assert.throws(() => encodeJson(new CustomArray(1, 2)), /prototype/);
  let reads = 0;
  const computed = [1];
  Object.defineProperty(computed, '0', { enumerable: true, get() { reads++; return reads; } });
  assert.throws(() => encodeJson(computed), /computed/);
  assert.equal(reads, 0);
  const hidden = [1];
  Object.defineProperty(hidden, 'extra', { value: 3 });
  assert.throws(() => encodeJson(hidden), /extra/);
});

test('original tables preserve missing/default/null and cannot expose mutable source values', async () => {
  const text = JSON.stringify({ Fixture: { keys: ['missing', 'nil', 'blank', 'array', 'absent'], defaults: { missing: 9, nil: 8 }, data: { '0': { nil: null, blank: '', array: [] } } } });
  const data = await OriginalTables.load(text, await proof(text), sha256, 'document');
  assert.deepEqual(data.field('Fixture', '0', 'missing'), { presence: 'default', value: 9 });
  assert.deepEqual(data.field('Fixture', '0', 'nil'), { presence: 'explicit', value: null });
  assert.deepEqual(data.field('Fixture', '0', 'blank'), { presence: 'explicit', value: '' });
  assert.deepEqual(data.field('Fixture', '0', 'absent'), { presence: 'absent' });
  const field = data.field('Fixture', '0', 'array');
  if (field.presence !== 'absent' && Array.isArray(field.value)) field.value.push(7);
  assert.deepEqual(data.field('Fixture', '0', 'array'), { presence: 'explicit', value: [] });
  assert.throws(() => data.field('Fixture', '0', 'not-exported'), /not included/);
  assert.throws(() => data.field('Fixture', '1', 'nil'), /Missing original record/);
  assert.throws(() => data.field('toString', '0', 'nil'), /Missing original table/);
  assert.throws(() => data.requireComplete(), /projection/);
  await assert.rejects(OriginalTables.load(text + ' ', await proof(text), sha256, 'document'), /digest/);
  await assert.rejects(OriginalTables.load(text, { ...await proof(text), sourceApkSha256: '0'.repeat(64) }, sha256, 'document'), /baseline/);
});

test('existing 2581 numerical export loads without inventing the excluded structural tables', async () => {
  const path = 'E:/MobileAppWorkspace/games/合金机兵_属性数据完整包/合金机兵_属性数据/属性原始数据.json';
  const text = readFileSync(path, 'utf8');
  const data = await OriginalTables.load(text, {
    sourceApkSha256: ORIGINAL_APK_SHA256,
    sourceEntry: path,
    contentSha256: '15117d4fb34e20db1b133a8c2c1732ef4ad24eb24f4ddccb1d308719701be5bb',
    completeness: 'field-projection',
  }, sha256, 'tables');
  assert.equal(data.names().length, 31);
  assert.equal(data.names().reduce((sum, name) => sum + data.ids(name).length, 0), 34214);
  assert.equal(data.ids('Award').length, 1611);
  assert.throws(() => data.ids('Mapnpc'), /Missing original table/);
  assert.throws(() => data.requireComplete(), /projection/);
});

test('save snapshot and deduplication receipt survive close/reopen and reject stale writers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'alloy-foundation-'));
  let connection = sqlite(join(directory, 'save.db'));
  try {
    let store = new SaveStore(connection.db, codec);
    assert.equal(store.load('primary'), null);
    const receipt = { operationId: 'source-event-instance', requestFingerprint: await sha256('same request') };
    assert.deepEqual(store.commit('primary', 0, { marker: 1 }, receipt), { revision: 1, duplicate: false });
    connection.native.close();
    connection = sqlite(join(directory, 'save.db'));
    store = new SaveStore(connection.db, codec);
    assert.deepEqual(store.load('primary'), { revision: 1, state: { marker: 1 } });
    assert.deepEqual(store.commit('primary', 0, { marker: 1 }, receipt), { revision: 1, duplicate: true });
    assert.throws(() => store.commit('primary', 0, { marker: 2 }), SaveConflict);
    assert.throws(() => store.commit('primary', 1, { marker: 2 }, { ...receipt, requestFingerprint: 'f'.repeat(64) }), /reused/);
    assert.deepEqual(store.commit('primary', 1, { marker: 2 }), { revision: 2, duplicate: false });
    assert.deepEqual(store.commit('primary', 0, { marker: 1 }, receipt), { revision: 1, duplicate: true });
    assert.deepEqual(store.load('primary'), { revision: 2, state: { marker: 2 } });
    assert.throws(() => store.commit('primary', 2, { marker: NaN }), /JSON/);
  } finally { connection.native.close(); rmSync(directory, { recursive: true }); }
});

test('failure during receipt insertion rolls back snapshot and keeps the operation retryable', async () => {
  const { native, db } = sqlite();
  try {
    const store = new SaveStore(db, codec);
    store.commit('primary', 0, { marker: 0 });
    native.exec("CREATE TRIGGER inject_receipt_failure BEFORE INSERT ON reconstruction_receipts BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END;");
    const receipt = { operationId: 'once', requestFingerprint: await sha256('operation') };
    assert.throws(() => store.commit('primary', 1, { marker: 1 }, receipt), /injected disk failure/);
    assert.deepEqual(store.load('primary'), { revision: 1, state: { marker: 0 } });
    native.exec('DROP TRIGGER inject_receipt_failure');
    assert.deepEqual(store.commit('primary', 1, { marker: 1 }, receipt), { revision: 2, duplicate: false });
  } finally { native.close(); }
});

test('unknown baseline/schema and corrupted saves fail closed without resetting progress', () => {
  const { native, db } = sqlite();
  try {
    const store = new SaveStore(db, codec);
    store.commit('primary', 0, { marker: 3 });
    db.runSync('UPDATE reconstruction_slots SET source_sha256 = ? WHERE slot = ?', '0'.repeat(64), 'primary');
    assert.throws(() => store.load('primary'), /different original version/);
    assert.throws(() => store.commit('primary', 1, { marker: 4 }), /different original version/);
    db.runSync('UPDATE reconstruction_slots SET source_sha256 = ?, schema_version = 2 WHERE slot = ?', ORIGINAL_APK_SHA256, 'primary');
    assert.throws(() => store.load('primary'), /migration/);
    db.runSync('UPDATE reconstruction_slots SET schema_version = 1, payload = ? WHERE slot = ?', 'not json', 'primary');
    assert.throws(() => store.load('primary'));
    assert.equal(db.getFirstSync<{ payload: string }>('SELECT payload FROM reconstruction_slots WHERE slot = ?', 'primary')?.payload, 'not json');
  } finally { native.close(); }
});

const serviceBinding: ServiceBinding<{ ok: boolean }> = {
  path: 'fixture', method: 'POST', sourceApkSha256: ORIGINAL_APK_SHA256,
  sourceLocator: 'test transport fixture only; not a recovered original route',
  parseResponse(value) {
    assert.ok(value !== null && typeof value === 'object' && 'ok' in value && typeof value.ok === 'boolean');
    return { ok: value.ok };
  },
};

test('unconfigured services never simulate success or issue a request', async () => {
  let calls = 0;
  const send: typeof fetch = async () => { calls++; return new Response('{}'); };
  await assert.rejects(new ServiceClient(null, send).request(serviceBinding, {}), (error: unknown) => error instanceof ServiceUnavailable && error.reason === 'not-configured');
  assert.equal(calls, 0);
});

test('service transport stays under configured HTTPS base and does not retry mutations', async () => {
  const calls: { url: string; options: RequestInit | undefined }[] = [];
  const send: typeof fetch = async (url, options) => { calls.push({ url: String(url), options }); return new Response('{"ok":true}', { status: 200 }); };
  const client = new ServiceClient('https://self-hosted.invalid/api/', send);
  assert.deepEqual(await client.request(serviceBinding, { original: 1 }), { ok: true });
  assert.equal(calls[0].url, 'https://self-hosted.invalid/api/fixture');
  assert.equal(calls[0].options?.body, '{"original":1}');
  assert.equal(calls[0].options?.credentials, 'omit');
  assert.equal(calls[0].options?.redirect, 'error');
  for (const path of ['../escape', '//elsewhere.invalid/', 'https://elsewhere.invalid/', '/root', 'a\\b']) {
    await assert.rejects(client.request({ ...serviceBinding, path }));
  }
  assert.equal(calls.length, 1);
  const fail: typeof fetch = async () => { calls.push({ url: 'failed', options: undefined }); return new Response('{}', { status: 503 }); };
  await assert.rejects(new ServiceClient('https://self-hosted.invalid/', fail).request(serviceBinding), (error: unknown) => error instanceof ServiceUnavailable && error.status === 503);
  assert.equal(calls.length, 2);
  assert.throws(() => new ServiceClient('http://self-hosted.invalid/', send), /HTTPS/);
});

test('service cancellation and invalid response remain failures', async () => {
  const signal = AbortSignal.abort();
  const canceled: typeof fetch = async (_url, options) => { assert.equal(options?.signal?.aborted, true); throw new Error('aborted'); };
  await assert.rejects(new ServiceClient('https://self-hosted.invalid/', canceled).request(serviceBinding, undefined, signal), /aborted/);
  const invalid: typeof fetch = async () => new Response('{"notOk":true}');
  await assert.rejects(new ServiceClient('https://self-hosted.invalid/', invalid).request(serviceBinding), (error: unknown) => error instanceof ServiceUnavailable && error.reason === 'invalid-response');
});

test('asset loading rejects old rejected files, missing sources and changed bytes', async () => {
  const originalBytes = new TextEncoder().encode('source bytes');
  const outputSha256 = createHash('sha256').update(originalBytes).digest('hex');
  const record: SourceAsset = {
    id: 'fixture', sourceApkSha256: ORIGINAL_APK_SHA256,
    sourceEntry: 'fixture.bin', sourceSha256: outputSha256,
    localPath: 'original/fixture.bin', outputSha256,
    availability: 'source-verified', transformation: 'test byte-identical fixture',
  };
  let reads = 0;
  const adapter = {
    async read() { reads++; return originalBytes; },
    async sha256(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); },
  };
  for (const availability of ['rejected', 'missing', 'unverified'] as const) {
    await assert.rejects(new SourceAssets([{ ...record, availability }], adapter).load('fixture'), new RegExp(availability));
  }
  assert.equal(reads, 0);
  const assets = new SourceAssets([record], adapter);
  record.availability = 'rejected';
  const loaded = await assets.load('fixture');
  assert.equal(loaded.source.availability, 'source-verified');
  loaded.bytes[0] = 0;
  assert.equal((await assets.load('fixture')).bytes[0], originalBytes[0]);
  originalBytes[0] = 0;
  await assert.rejects(assets.load('fixture'), /digest mismatch/);
  await assert.rejects(assets.load('toString'), /not indexed/);
  assert.throws(() => new SourceAssets([{ ...record, localPath: '../outside' }], adapter), /relative path/);
});
