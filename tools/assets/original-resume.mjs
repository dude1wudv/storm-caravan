import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ORIGINAL_RGB_BOUNDARY } from './original-formats.mjs';

export function assetStats(assets, parsedMaps, failures) {
  const spineVersions = {};
  for (const record of assets) if (record.spine?.version) spineVersions[record.spine.version] = (spineVersions[record.spine.version] ?? 0) + 1;
  return {
    selectedAssets: assets.length,
    originalMapAssets: assets.filter((record) => record.type === 'cc.TiledMapAsset').length,
    parsedMaps,
    convertedMaps: assets.filter((record) => record.raster).length,
    convertedLayers: assets.reduce((n, record) => n + (record.layerRasters?.length ?? 0), 0),
    convertedMapChunks: assets.reduce((n, record) => n + (record.rasterChunks?.length ?? 0), 0),
    convertedLayerChunks: assets.reduce((n, record) => n + (record.layerRasterChunks?.length ?? 0), 0),
    convertedTextures: assets.filter((record) => record.texture).length,
    convertedSprites: assets.filter((record) => record.sprite).length,
    indexedSpine: assets.filter((record) => record.spine).length,
    spineVersions,
    indexedAudio: assets.filter((record) => record.audio?.paths?.length).length,
    rejectedVisualAssets: assets.filter((record) => record.rejectedVisuals?.files?.length).length,
    rejectedVisualFiles: assets.reduce((count, record) => count + (record.rejectedVisuals?.files?.length ?? 0), 0),
    failures,
  };
}

export async function loadResume(root, manifestPath, sourceHash, options) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.origin !== 'added' || manifest.source?.sha256 !== sourceHash) throw new Error('Resume source APK SHA256/schema does not match prior manifest');
  if (![2, 3, 4].includes(manifest.conversion?.version)) throw new Error('Resume requires an indexed manifest version 2, 3 or 4');
  const oldOptions = manifest.conversion.options;
  for (const [key, value] of Object.entries({ layers: options.layers, allVisualTextures: options.textures, sprites: options.sprites, chunkSize: options.chunkSize })) {
    if (oldOptions?.[key] !== value) throw new Error(`Resume conversion option differs: ${key}`);
  }
  if (!Array.isArray(manifest.assets) || !Array.isArray(manifest.failures)) throw new Error('Resume manifest asset/failure tables missing');
  const records = new Map();
  for (const record of manifest.assets) {
    const key = `${record.bundle}:${record.uuid}`;
    if (records.has(key)) throw new Error('Duplicate resume asset identity');
    records.set(key, record);
  }
  const stats = assetStats(manifest.assets, manifest.assets.filter((record) => record.map).length, manifest.failures.length);
  for (const [key, value] of Object.entries(stats)) {
    if (key.startsWith('rejectedVisual') && manifest.conversion.version < 4) continue;
    if (key === 'spineVersions') {
      const old = manifest.stats?.spineVersions ?? {};
      if (Object.keys(old).length !== Object.keys(value).length || Object.entries(value).some(([version, count]) => old[version] !== count)) throw new Error('Resume Spine version coverage differs from prior statistics');
    } else if (manifest.stats?.[key] !== value) throw new Error(`Resume prior manifest statistics mismatch: ${key}`);
  }
  if (stats.originalMapAssets !== 617 || stats.parsedMaps !== 617 || manifest.assets.some((record) => record.type === 'cc.TiledMapAsset' && !record.raster && !record.rejectedVisuals?.files?.some((file) => file.role === 'raster'))) throw new Error('Resume requires 617 original map data records and their existing raster/quality-rejected raster evidence; incomplete prior coverage requires full import');
  const files = new Map();
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string' && typeof value.sha256 === 'string' && typeof value.bytes === 'number' && typeof value.kind === 'string') {
      if (!value.path.startsWith('assets/original/') || value.path.includes('\\') || value.path.split('/').some((part) => !part || part === '..' || part === '.') || value.path.includes(':')) throw new Error('Unsafe resume output path');
      if (!/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.sourceApkSha256 !== sourceHash) throw new Error(`Invalid resume provenance for ${value.path}`);
      const old = files.get(value.path);
      if (old && (old.sha256 !== value.sha256 || old.bytes !== value.bytes)) throw new Error(`Conflicting resume metadata for ${value.path}`);
      files.set(value.path, value);
    }
    for (const child of Object.values(value)) if (typeof child === 'object') collect(child);
  }
  manifest.assets.forEach(collect);
  let verifiedBytes = 0;
  const boundary = await realpath(path.join(root, 'assets/original'));
  // Stream hashes rather than materializing every large map/layer PNG in memory.
  for (const file of files.values()) {
    const hash = createHash('sha256');
    const resolved = await realpath(path.join(root, file.path));
    const relative = path.relative(boundary, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Resume output resolves outside original asset directory: ${file.path}`);
    let bytes = 0;
    let header = Buffer.alloc(0);
    for await (const chunk of createReadStream(resolved)) {
      hash.update(chunk); bytes += chunk.length;
      if (header.length < 24) header = Buffer.concat([header, chunk.subarray(0, 24 - header.length)]);
    }
    if (file.path.endsWith('.png') && file.width !== undefined && file.height !== undefined) {
      if (header.length < 24 || header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || header.readUInt32BE(16) !== file.width || header.readUInt32BE(20) !== file.height) throw new Error(`Resume PNG geometry differs from recorded dimensions: ${file.path}`);
    }
    if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`Resume output SHA256/byte count mismatch: ${file.path}`);
    verifiedBytes += bytes;
  }
  const rejectedTextureIds = new Set(manifest.assets.filter((record) => record.texture?.originalHeader === 'PNG 10' || record.rejectedVisuals?.files?.some((entry) => entry.role === 'texture' && entry.file.originalHeader === 'PNG 10')).map((record) => record.uuid));
  function reject(record, role) {
    const value = record[role];
    if (!value) return;
    const prior = record.rejectedVisuals ?? { status: 'rejected-original-rgb', reason: ORIGINAL_RGB_BOUNDARY, files: [] };
    for (const file of Array.isArray(value) ? value : [value]) prior.files.push({ role, file });
    record.rejectedVisuals = prior;
    delete record[role];
  }
  for (const record of manifest.assets) {
    if (rejectedTextureIds.has(record.uuid)) reject(record, 'texture');
    if (record.sprite?.textureUuid && rejectedTextureIds.has(record.sprite.textureUuid)) reject(record, 'sprite');
    if (record.raster?.sourceTextureSha256?.some((texture) => rejectedTextureIds.has(texture.uuid))) {
      for (const role of ['raster', 'rasterChunks', 'layerRasters', 'layerRasterChunks']) reject(record, role);
      record.renderStatus = 'failed';
    }
  }
  const selected = new Set();
  const selectors = options.onlyAssets?.split(',').map((item) => item.trim()).filter(Boolean);
  if (selectors) {
    for (const selector of selectors) {
      if (selector === 'failed') { manifest.failures.forEach((failure) => { if (failure.asset) selected.add(`${failure.bundle}:${failure.asset}`); }); continue; }
      const matches = manifest.assets.filter((record) => record.uuid === selector || `${record.bundle}:${record.uuid}` === selector || record.logicalIds.includes(selector));
      if (!matches.length) throw new Error(`Unknown --only-assets selector ${selector}`);
      matches.forEach((record) => selected.add(`${record.bundle}:${record.uuid}`));
    }
    // A chosen texture selects its referencing SpriteFrames; a chosen SpriteFrame
    // selects its real original texture. This is an asset graph, not a game-ID map.
    const textures = new Map(manifest.assets.filter((record) => record.type === 'cc.Texture2D').map((record) => [record.uuid, record]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of manifest.assets) {
        if (record.type !== 'cc.SpriteFrame') continue;
        const key = `${record.bundle}:${record.uuid}`;
        const texture = record.references?.map((reference) => textures.get(reference.uuid)).find(Boolean);
        if (!texture) continue;
        const textureKey = `${texture.bundle}:${texture.uuid}`;
        if (selected.has(key) || selected.has(textureKey)) for (const candidate of [key, textureKey]) if (!selected.has(candidate)) { selected.add(candidate); changed = true; }
      }
    }
  }
  return { manifest, records, files, shouldAttempt: (record) => !selectors || selected.has(`${record.bundle}:${record.uuid}`), audit: { priorConversionVersion: manifest.conversion.version, verifiedFiles: files.size, verifiedBytes, sourceApkSha256: sourceHash, mode: selectors ? 'selected-original-asset-reference-closure' : 'retry-missing-conversions', selectedAssets: selectors ? selected.size : records.size } };
}
