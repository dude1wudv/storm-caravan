import { ORIGINAL_APK_SHA256 } from './original-data';

export interface SourceAsset {
  id: string;
  sourceApkSha256: string;
  sourceEntry: string;
  sourceSha256: string;
  localPath: string;
  outputSha256: string;
  availability: 'source-verified' | 'missing' | 'rejected' | 'unverified';
  transformation: string;
}
export interface AssetBytes {
  read(localPath: string): Promise<Uint8Array>;
  sha256(bytes: Uint8Array): Promise<string>;
}

/** Source readiness is independent of rendering/behavior acceptance. No silent placeholder assets. */
export class SourceAssets {
  private readonly records: Record<string, Readonly<SourceAsset>> = Object.create(null);

  constructor(records: readonly SourceAsset[], private readonly bytes: AssetBytes) {
    for (const record of records) {
      if (!record.id || Object.hasOwn(this.records, record.id)) throw new Error('Duplicate or empty original asset ID');
      if (record.sourceApkSha256 !== ORIGINAL_APK_SHA256) throw new Error('Original asset baseline mismatch');
      if (!record.sourceEntry || !record.transformation || !/^[0-9a-f]{64}$/.test(record.sourceSha256) || !/^[0-9a-f]{64}$/.test(record.outputSha256)) {
        throw new Error(`Invalid asset provenance: ${record.id}`);
      }
      if (!['source-verified', 'missing', 'rejected', 'unverified'].includes(record.availability)) throw new Error('Unknown source availability');
      if (!record.localPath || record.localPath.startsWith('/') || record.localPath.includes('\\') || record.localPath.includes(':') || record.localPath.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error('Original asset path must be a local relative path');
      }
      this.records[record.id] = Object.freeze({ ...record });
    }
  }

  async load(id: string): Promise<{ bytes: Uint8Array; source: Readonly<SourceAsset> }> {
    if (!Object.hasOwn(this.records, id)) throw new Error(`Original asset not indexed: ${id}`);
    const source = this.records[id];
    if (source.availability !== 'source-verified') throw new Error(`Original asset is ${source.availability}: ${id}`);
    // The adapter can reuse buffers; own the bytes before awaiting a digest.
    const bytes = new Uint8Array(await this.bytes.read(source.localPath));
    if (await this.bytes.sha256(bytes) !== source.outputSha256) throw new Error(`Original asset digest mismatch: ${id}`);
    return { bytes, source };
  }
}
