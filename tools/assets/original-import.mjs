import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { cocosDocument, decodeEtcTexture, decodeUuid, parseAtlas, spineHeader, spineJsonInfo, ORIGINAL_RGB_BOUNDARY } from './original-formats.mjs';
import { readTiledMap, renderTiledMap } from './original-maps.mjs';
import { assetStats, loadResume } from './original-resume.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = path.join(ROOT, 'assets/original');
const MANIFEST = path.join(ROOT, 'assets/manifests/original-assets.json');
const BUNDLES = ['bundle', 'bundle1', 'bundle2', 'resources'];
const ROOTS = new Set(['spine', 'map', 'audio', 'view', 'part', 'img', 'texture', 'font', 'particle', 'animation']);
const EXCLUDED_NAME = /(?:^|\/)(?:[^/]*(?:recharge|chongzhi|login|account|payment|purchase|privacy|realname|shiming|advert|register)[^/]*)(?:\/|$)/i;
const SUPPORTED_TYPES = new Set(['cc.TextAsset', 'cc.JsonAsset', 'cc.Texture2D', 'cc.SpriteFrame', 'cc.TiledMapAsset', 'cc.AudioClip', 'sp.SkeletonData', 'cc.Prefab', 'cc.AnimationClip', 'cc.BitmapFont', 'cc.ParticleAsset', 'cc.SpriteAtlas', 'cc.Asset']);
const NATIVE_EXTENSIONS = new Set(['pkm', 'png', 'jpg', 'jpeg', 'webp', 'atlas', 'bin', 'mp3', 'ogg', 'wav', 'm4a', 'plist', 'fnt', 'ttf', 'otf']);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
let sourceApkSha256;
let reusableOutputs = new Map();
const posix = (value) => value.split(path.sep).join('/');
const decodeJson = (bytes) => JSON.parse(Buffer.from(bytes).toString('utf8'));

function argumentsFrom(argv) {
  const options = { layers: false, sprites: true, textures: true, chunkSize: 2048, python: 'python' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apk') { if (!argv[i + 1]) throw new Error('--apk requires a file'); options.apk = argv[++i]; }
    else if (arg === '--layers') options.layers = true;
    else if (arg === '--no-sprites') options.sprites = false;
    else if (arg === '--maps-only') { options.sprites = false; options.textures = false; }
    else if (arg === '--python') { if (!argv[i + 1]) throw new Error('--python requires an executable'); options.python = argv[++i]; }
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--only-assets') { if (!argv[i + 1]) throw new Error('--only-assets requires failed or comma-separated original UUID/logical IDs'); options.onlyAssets = argv[++i]; }
    else if (arg === '--chunk-size') {
      options.chunkSize = Number(argv[++i]);
      if (!Number.isInteger(options.chunkSize) || options.chunkSize !== 0 && (options.chunkSize < 256 || options.chunkSize > 4096)) throw new Error('--chunk-size must be 0 or an integer from 256 to 4096');
    }
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.apk && !options.help) throw new Error('Required: --apk <public APK ZIP file>');
  if (options.onlyAssets && !options.resume) throw new Error('--only-assets requires --resume; partial imports cannot replace a complete manifest');
  return options;
}
function safeMetadata(value) {
  if (typeof value === 'string' && (/^[a-z]:[\\/]/i.test(value) || /^\/(?:Users|home|mnt|data|storage)\//i.test(value))) throw new Error('Absolute filesystem path in imported metadata; refuse to publish');
  if (Array.isArray(value)) value.forEach(safeMetadata);
  else if (value && typeof value === 'object') Object.values(value).forEach(safeMetadata);
}
async function outputFile(relative, bytes, kind, sourceEntry, extra = {}) {
  if (relative.split('/').some((segment) => segment === '..')) throw new Error('Unsafe output path');
  const destination = path.join(OUTPUT, relative);
  const metadata = { origin: kind === 'original' ? 'original' : 'added', kind, path: `assets/original/${relative}`, sha256: digest(bytes), bytes: bytes.length, sourceEntry, sourceApkSha256, ...extra };
  const prior = reusableOutputs.get(metadata.path);
  if (!prior || prior.sha256 !== metadata.sha256 || prior.bytes !== metadata.bytes) {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  return metadata;
}
async function outputJson(relative, value, sourceEntry) {
  safeMetadata(value);
  return outputFile(relative, Buffer.from(`${JSON.stringify(value)}\n`), 'metadata', sourceEntry);
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.help) {
    console.log('node tools/assets/original-import.mjs --apk <file.apk> [--python <executable>] [--layers] [--chunk-size 2048] [--maps-only] [--no-sprites] [--resume [--only-assets failed|<UUID/logical IDs>]]\nRequires texture2ddecoder==1.0.6. Resume verifies source APK SHA256, every output hash/size/provenance and prior 617-map/statistics coverage before reuse; conversion options must match. Unsupported data remains a recorded failure; no fake maps or animation baking.');
    return;
  }
  const apkBytes = await readFile(options.apk);
  const apkSha256 = digest(apkBytes);
  sourceApkSha256 = apkSha256;
  const resume = options.resume ? await loadResume(ROOT, MANIFEST, apkSha256, options) : null;
  reusableOutputs = resume?.files ?? new Map();
  const names = new Set();
  const configNames = new Set(BUNDLES.map((bundle) => `assets/assets/${bundle}/config.json`));
  // ZIP central-directory names are public. Extract only four public asset configs,
  // never code, libraries, SDK/ad/private data or arbitrary archive entries.
  const configFiles = unzipSync(apkBytes, { filter: (entry) => { names.add(entry.name); return configNames.has(entry.name); } });
  const records = new Map();
  const blocked = new Set();
  const originalManifests = [];
  for (const bundle of BUNDLES) {
    const configPath = `assets/assets/${bundle}/config.json`;
    if (!configFiles[configPath]) throw new Error(`Public bundle config missing: ${configPath}`);
    const config = decodeJson(configFiles[configPath]);
    if (config.encrypted || config.packs && Object.keys(config.packs).length) throw new Error(`Unsupported encrypted/packed config: ${bundle}; no bypass attempted`);
    if (config.importBase && config.importBase !== 'import' || config.nativeBase && config.nativeBase !== 'native') throw new Error('Unsupported asset bundle base paths');
    const acceptedPaths = {};
    let excludedCount = 0;
    for (const [index, tuple] of Object.entries(config.paths ?? {})) {
      const logicalId = tuple[0], type = config.types[tuple[1]];
      const uuid = decodeUuid(config.uuids[Number(index)]);
      const excluded = !ROOTS.has(logicalId.split('/')[0]) || EXCLUDED_NAME.test(logicalId) || !SUPPORTED_TYPES.has(type);
      if (excluded) { blocked.add(uuid); excludedCount++; continue; }
      acceptedPaths[index] = tuple;
      const key = `${bundle}:${uuid}`;
      const record = records.get(key) ?? { origin: 'original', bundle, uuid, type, logicalIds: [], manifestEntry: configPath, manifestIndex: Number(index), manifestTuple: tuple, namedInManifest: true };
      record.logicalIds.push(logicalId); records.set(key, record);
    }
    originalManifests.push({ origin: 'original', bundle, sourceEntry: configPath, sha256: digest(configFiles[configPath]), originalLogicalEntryCount: Object.keys(config.paths ?? {}).length, selectedLogicalEntryCount: Object.keys(acceptedPaths).length, excludedLogicalEntryCount: excludedCount, paths: acceptedPaths, types: config.types, uuids: config.uuids, deps: config.deps ?? [], redirect: config.redirect ?? [], scope: 'gameplay allowlist; SDK/ad/account/payment/engine paths excluded' });
  }
  if (resume) for (const [key, record] of records) {
    const prior = resume.records.get(key);
    if (!prior || prior.type !== record.type || JSON.stringify(prior.logicalIds) !== JSON.stringify(record.logicalIds)) throw new Error(`Resume named asset identity differs from current public manifest: ${key}`);
    records.set(key, { ...prior, ...record });
  }
  const importCandidates = new Map();
  const nativeCandidates = new Map();
  for (const name of names) {
    const match = /^assets\/assets\/(bundle|bundle1|bundle2|resources)\/(import|native)\/[a-f\d]{2}\/([a-f\d-]{36})(?:\.[a-f\d]+)?\.([\w]+)$/i.exec(name);
    if (!match) continue;
    const [, bundle, mode, uuid, ext] = match;
    if (blocked.has(uuid)) continue;
    const key = `${bundle}:${uuid}`;
    if (mode === 'import' && ext === 'json') {
      if (importCandidates.has(key)) throw new Error(`Ambiguous public import file for ${key}`);
      importCandidates.set(key, name);
    } else if (mode === 'native' && NATIVE_EXTENSIONS.has(ext.toLowerCase())) {
      const list = nativeCandidates.get(key) ?? []; list.push(name); nativeCandidates.set(key, list);
    }
  }
  const documents = new Map();
  const errors = [];
  if (resume) for (const failure of resume.manifest.failures) {
    const record = resume.records.get(`${failure.bundle}:${failure.asset}`);
    if (record && !record.rejectedVisuals && !resume.shouldAttempt(record) && ['map-data', 'map-render', 'texture-conversion', 'sprite-conversion'].includes(failure.phase)) errors.push(failure);
  }
  const recordError = (phase, record, error) => {
    const message = String(error?.message ?? error).replaceAll(options.apk, '<input-apk>').replaceAll(ROOT, '<project>');
    errors.push({ phase, asset: record?.uuid, bundle: record?.bundle, logicalIds: record?.logicalIds, message });
  };
  if (resume && [...resume.records.values()].some((record) => record.rejectedVisuals)) recordError('source-rgb-quality', undefined, new Error(ORIGINAL_RGB_BOUNDARY));
  // Resolve only referenced gameplay assets. A dependency explicitly classified as
  // SDK/account/payment is never extracted, even when a game prefab references it.
  let pending = [...records.keys()];
  while (pending.length) {
    const batch = pending; pending = [];
    const wanted = new Set(batch.map((key) => importCandidates.get(key)).filter(Boolean));
    const files = unzipSync(apkBytes, { filter: (entry) => wanted.has(entry.name) });
    for (const key of batch) {
      const record = records.get(key);
      const importPath = importCandidates.get(key);
      if (!importPath) { record.importStatus = 'missing'; recordError('descriptor', record, new Error('Original import descriptor missing')); continue; }
      try {
        const bytes = Buffer.from(files[importPath]);
        const raw = decodeJson(bytes), decoded = cocosDocument(raw);
        documents.set(key, { raw, decoded, sourceEntry: importPath });
        record.importStatus = 'read'; record.importEntry = importPath;
        record.descriptor = await outputJson(`descriptors/${record.bundle}/${record.uuid}.json`, { origin: 'original', serialized: raw }, importPath);
        record.references = decoded.references.map((uuid) => ({ uuid, excluded: blocked.has(uuid) }));
        const object = decoded.objects.find((item) => item?.__type__ === record.type) ?? decoded.objects[0];
        if (!record.namedInManifest && object?.__type__) record.type = object.__type__;
        if (record.type === 'cc.SpriteFrame') record.spriteFrame = object?.value?.[0] ?? object;
        if (record.type === 'cc.Texture2D') {
          const setting = object?.value?.[0];
          const match = typeof setting === 'string' ? /^(?:\d+@)?(\d+),/.exec(setting) : null;
          record.textureSettings = { origin: 'original', serialized: setting, pixelFormat: match ? Number(match[1]) : null };
        }
        if (record.type === 'cc.AnimationClip') record.animation = { origin: 'original', serializedFormatVersion: raw[0] === 1 ? 1 : null, engineAnimationVersion: 'not-declared-in-asset', fields: object, playableInReactNative: false, bakingStatus: 'not-performed' };
        if (record.type === 'cc.AudioClip') record.audio = { nativeExtension: object?._native, duration: object?._duration ?? object?.duration, fields: object };
        if (record.type === 'cc.Prefab') record.prefab = { serializedFormatVersion: raw[0] === 1 ? 1 : null, descriptorPath: record.descriptor.path, componentTypes: [...new Set(decoded.objects.map((item) => item?.__type__).filter(Boolean))], playableInReactNative: false, conversionStatus: 'original-node/component-data-preserved; no RN prefab adapter' };
        for (const uuid of decoded.references) {
          if (blocked.has(uuid)) continue;
          let dependencyKey = BUNDLES.map((bundle) => `${bundle}:${uuid}`).find((candidate) => records.has(candidate));
          if (!dependencyKey) {
            const candidates = BUNDLES.map((bundle) => `${bundle}:${uuid}`).filter((candidate) => importCandidates.has(candidate));
            if (!candidates.length) {
              const reference = record.references.find((item) => item.uuid === uuid);
              reference.status = 'external-or-unresolved; not-extracted';
              continue;
            }
            if (candidates.length > 1) { recordError('dependency', record, new Error(`Reference ${uuid} has ${candidates.length} public import candidates`)); continue; }
            dependencyKey = candidates[0];
            const prior = resume?.records.get(dependencyKey);
            records.set(dependencyKey, prior ? { ...prior } : { origin: 'original', bundle: dependencyKey.split(':')[0], uuid, type: 'dependency', logicalIds: [], namedInManifest: false, referencedBy: record.uuid });
            pending.push(dependencyKey);
          }
        }
      } catch (error) { record.importStatus = 'failed'; recordError('descriptor', record, error); }
    }
  }
  if (resume && (records.size !== resume.records.size || [...records.keys()].some((key) => !resume.records.has(key)))) throw new Error('Resume original asset reference closure differs from prior complete manifest');
  const wantedNative = new Set([...records.keys()].flatMap((key) => nativeCandidates.get(key) ?? []));
  const nativeFiles = unzipSync(apkBytes, { filter: (entry) => wantedNative.has(entry.name) });
  for (const [key, record] of records) {
    record.native = [];
    for (const entry of nativeCandidates.get(key) ?? []) {
      const ext = entry.split('.').at(-1).toLowerCase();
      const bytes = Buffer.from(nativeFiles[entry]);
      record.native.push(await outputFile(`native/${record.bundle}/${path.posix.basename(entry)}`, bytes, 'original', entry, { extension: ext }));
    }
    const document = documents.get(key);
    const skeleton = document?.decoded.objects.find((object) => object?.__type__ === 'sp.SkeletonData');
    if (skeleton) {
      try {
        const binary = record.native.find((file) => file.extension === 'bin');
        if (!binary && !skeleton._skeletonJson) throw new Error('Original Spine has neither binary nor embedded JSON skeleton');
        const info = binary ? spineHeader(Buffer.from(nativeFiles[binary.sourceEntry])) : spineJsonInfo(skeleton._skeletonJson);
        const text = skeleton._atlasText ?? Buffer.from(nativeFiles[record.native.find((file) => file.extension === 'atlas')?.sourceEntry] ?? []).toString('utf8');
        const pages = parseAtlas(text);
        if (!pages.length) throw new Error('Spine atlas pages missing');
        record.spine = { origin: 'original', ...info, atlasText: text, pages, textureNames: skeleton.textureNames ?? [], textures: (skeleton.textures ?? []).map((ref, i) => ({ page: skeleton.textureNames?.[i], uuid: typeof ref === 'number' ? document.decoded.references[ref] : ref?.__uuid__ })) };
      } catch (error) { recordError('spine-index', record, error); }
    }
    if (record.type === 'cc.AudioClip') {
      record.audio ??= {};
      record.audio.paths = record.native.filter((file) => ['mp3', 'ogg', 'wav', 'm4a'].includes(file.extension)).map((file) => ({ path: file.path, sourceEntry: file.sourceEntry, sha256: file.sha256, extension: file.extension }));
      if (!record.audio.paths.length) recordError('audio', record, new Error('No original playable audio file'));
    }
  }
  const maps = [];
  for (const [key, record] of records) {
    if (record.type !== 'cc.TiledMapAsset') continue;
    if (resume && record.map && record.collision && (record.raster || record.rejectedVisuals?.files?.some((entry) => entry.role === 'raster'))) { maps.push({ record, map: null }); continue; }
    try {
      const document = documents.get(key);
      if (!document) throw new Error('Map descriptor not decoded');
      const asset = document.decoded.objects.find((object) => object?.__type__ === 'cc.TiledMapAsset');
      const map = readTiledMap(asset, document.decoded.references, (uuid) => {
        const textDocument = [...documents.entries()].find(([candidate]) => candidate.endsWith(`:${decodeUuid(uuid)}`))?.[1];
        const object = textDocument?.decoded.objects.find((item) => item?.__type__ === 'cc.TextAsset');
        const value = object?.text ?? object?._text ?? object?.value?.[0];
        if (typeof value !== 'string') throw new Error('Referenced TSX is not plain text');
        return value;
      }, (type, filename) => {
        const basename = filename.replaceAll('\\', '/').split('/').at(-1).replace(/\.(tsx|png)$/i, '');
        const matches = [...records.values()].filter((candidate) => candidate.bundle === 'bundle1' && candidate.type === type && candidate.logicalIds.some((logicalId) => logicalId.split('/').at(-1) === basename));
        if (matches.length !== 1) throw new Error(`Explicit tileset filename ${filename} has ${matches.length} original manifest ${type} matches`);
        return matches[0].uuid;
      });
      record.map = await outputJson(`maps/${record.uuid}.json`, map, document.sourceEntry);
      const candidates = map.layers.filter((layer) => layer.collision).map((layer) => ({ layerIndex: layer.index, name: layer.name, width: layer.width, height: layer.height, gids: layer.gids, properties: layer.properties, ...layer.collision }));
      record.collision = await outputJson(`collision/${record.uuid}.json`, { origin: 'added', status: 'candidate', rule: 'not-verified', candidates, originalObjectgroups: map.layers.filter((layer) => layer.kind === 'objectgroup').map((layer) => ({ layerIndex: layer.index, xml: layer.xml })), npcCoordinates: 'not-inferred' }, document.sourceEntry);
      maps.push({ record, map });
    } catch (error) { recordError('map-data', record, error); }
  }
  const expectedSizes = new Map();
  function expectSize(uuid, size) {
    const old = expectedSizes.get(uuid);
    if (old && (old.width !== size.width || old.height !== size.height)) throw new Error(`Conflicting explicit dimensions for texture ${uuid}`);
    expectedSizes.set(uuid, size);
  }
  for (const { map } of maps) if (map) for (const set of map.tilesets) expectSize(set.image.textureUuid, { width: set.image.width, height: set.image.height });
  for (const record of records.values()) for (const texture of record.spine?.textures ?? []) {
    const page = record.spine.pages.find((candidate) => candidate.name === texture.page);
    const dims = page?.attributes.size?.split(',').map((n) => Number(n.trim()));
    if (texture.uuid && dims?.length === 2 && dims.every((n) => Number.isInteger(n) && n > 0)) expectSize(texture.uuid, { width: dims[0], height: dims[1] });
  }
  const textureSources = new Map([...records.values()].filter((record) => record.type === 'cc.Texture2D').map((record) => [record.uuid, record]));
  for (const record of records.values()) {
    if (record.type !== 'cc.SpriteFrame') continue;
    const frame = record.spriteFrame;
    const uuid = frame?._texture?.__uuid__ ?? record.references?.[0]?.uuid;
    const source = textureSources.get(uuid);
    if (source?.textureSettings?.pixelFormat !== 4 || !Array.isArray(frame?.rect) || !Array.isArray(frame?.originalSize)) continue;
    const [left, top, width, height] = frame.rect;
    if (left !== 0 || top !== 0 || frame.rotated || width !== frame.originalSize[0] || height !== frame.originalSize[1] || frame.offset?.some((value) => value !== 0)) continue;
    expectSize(uuid, { width, height });
    source.singlePlaneEvidence = { origin: 'original', spriteFrameUuid: record.uuid, rect: frame.rect, originalSize: frame.originalSize, texturePixelFormat: 4 };
  }
  const textureCache = new Map();
  const textureRecords = new Map();
  async function texture(uuid, explicitSize) {
    const key = [...records.keys()].find((candidate) => candidate.endsWith(`:${decodeUuid(uuid)}`));
    const record = records.get(key);
    if (!record) {
      const normalized = decodeUuid(uuid);
      if ([...names].some((name) => name.startsWith('assets/assets/internal/') && name.includes(normalized))) throw new Error(`Excluded engine texture ${normalized}: public internal bundle is outside gameplay-only extraction scope; no replacement invented`);
      throw new Error(`Texture ${normalized} has no allowed source asset; external/unresolved data is not fabricated`);
    }
    const expected = explicitSize ?? expectedSizes.get(uuid);
    if (textureCache.has(uuid)) {
      const cached = textureCache.get(uuid);
      if (expected && (cached.width !== expected.width || cached.height !== expected.height)) throw new Error('Cached texture differs from explicit dimensions');
      return cached;
    }
    if (record.texture) {
      textureRecords.set(uuid, record);
      const result = await sharp(await readFile(path.join(ROOT, record.texture.path))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const cached = { data: result.data, width: result.info.width, height: result.info.height };
      if (expected && (cached.width !== expected.width || cached.height !== expected.height)) throw new Error('Converted texture differs from explicit dimensions');
      textureCache.set(uuid, cached);
      if (textureCache.size > 24) textureCache.delete(textureCache.keys().next().value);
      return cached;
    }
    const native = record.native.find((file) => file.extension === 'pkm') ?? record.native.find((file) => ['png', 'jpg', 'jpeg', 'webp'].includes(file.extension));
    if (!native) throw new Error(`No convertible native texture for ${uuid}`);
    const bytes = Buffer.from(nativeFiles[native.sourceEntry]);
    let decoded;
    if (native.extension === 'pkm') decoded = decodeEtcTexture(bytes, expected, options.python);
    else {
      const result = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      decoded = { data: result.data, width: result.info.width, height: result.info.height, conversion: 'ordinary image to RGBA' };
      if (expected && (decoded.width !== expected.width || decoded.height !== expected.height)) throw new Error('Image differs from explicit source dimensions');
    }
    const png = await sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }).png().toBuffer();
    record.texture = await outputFile(`textures/${record.bundle}/${record.uuid}.png`, png, 'converted-texture', native.sourceEntry, { sourceSha256: native.sha256, width: decoded.width, height: decoded.height, conversion: decoded.conversion, originalHeader: decoded.originalHeader, pixelFormat: decoded.pixelFormat, alphaLayout: decoded.alphaLayout, singlePlaneEvidence: record.singlePlaneEvidence, formatField: decoded.formatField, codec: decoded.codec, escapeBlocks: decoded.escapeBlocks, decoder: decoded.decoder, encodedWidth: decoded.encodedWidth, encodedHeight: decoded.encodedHeight, sourceWidth: decoded.sourceWidth, sourceHeight: decoded.sourceHeight, planeHeight: decoded.planeHeight, croppedPaddingRows: decoded.croppedPaddingRows, croppedPaddingColumns: decoded.croppedPaddingColumns, dimensionEvidence: record.singlePlaneEvidence ? 'original Texture2D format + full SpriteFrame size/rect equals header' : expected ? 'original TMX/TSX image or Spine atlas page' : 'public envelope + grayscale plane validation' });
    textureCache.set(uuid, decoded); textureRecords.set(uuid, record);
    // Bound raw texture cache: converted PNGs remain available and can be decoded
    // again. The seven map textures fit comfortably; large visual catalogs do not.
    if (textureCache.size > 24) textureCache.delete(textureCache.keys().next().value);
    return decoded;
  }
  for (const { record, map } of maps) {
    if (!map) continue;
    try {
      const rendered = await renderTiledMap(map, texture, { layers: options.layers, chunkSize: options.chunkSize });
      record.raster = await outputFile(`maps/${record.uuid}.png`, rendered.png, 'converted-map', record.importEntry, { width: rendered.width, height: rendered.height, policy: rendered.policy, omittedNonVisualLayers: rendered.omittedNonVisualLayers, sourceTextureSha256: map.tilesets.map((set) => ({ uuid: set.image.textureUuid, sha256: textureRecords.get(set.image.textureUuid)?.texture?.sourceSha256 })) });
      record.rasterChunks = [];
      for (const image of rendered.chunks) record.rasterChunks.push(await outputFile(`chunks/${record.uuid}/${image.x}-${image.y}.png`, image.png, 'converted-map-chunk', record.importEntry, { width: image.width, height: image.height, x: image.x, y: image.y }));
      record.layerRasters = [];
      record.layerRasterChunks = [];
      for (const image of rendered.images) {
        record.layerRasters.push(await outputFile(`layers/${record.uuid}/${image.layerIndex}.png`, image.png, 'converted-layer', record.importEntry, { width: rendered.width, height: rendered.height, layerIndex: image.layerIndex }));
        for (const chunk of image.chunks) record.layerRasterChunks.push(await outputFile(`chunks/${record.uuid}/layer-${image.layerIndex}/${chunk.x}-${chunk.y}.png`, chunk.png, 'converted-layer-chunk', record.importEntry, { width: chunk.width, height: chunk.height, x: chunk.x, y: chunk.y, layerIndex: image.layerIndex }));
      }
    } catch (error) { record.renderStatus = 'failed'; recordError('map-render', record, error); }
  }
  if (options.textures) for (const record of records.values()) {
    if (resume && (record.texture || record.rejectedVisuals || !resume.shouldAttempt(record))) continue;
    if (!record.native.some((file) => ['pkm', 'png', 'jpg', 'jpeg', 'webp'].includes(file.extension))) continue;
    try { await texture(record.uuid); } catch (error) { recordError('texture-conversion', record, error); }
  }
  if (options.sprites) for (const [key, record] of records) {
    if (record.type !== 'cc.SpriteFrame') continue;
    if (resume && (record.sprite || record.rejectedVisuals || !resume.shouldAttempt(record))) continue;
    try {
      const frame = record.spriteFrame;
      const document = documents.get(key);
      const uuid = frame?._texture?.__uuid__ ?? document?.decoded.references[0];
      if (!uuid || !Array.isArray(frame?.rect)) throw new Error('SpriteFrame lacks public texture/rect metadata');
      const source = await texture(uuid);
      const [left, top, frameWidth, frameHeight] = frame.rect;
      const rotated = !!frame.rotated;
      const crop = { left, top, width: rotated ? frameHeight : frameWidth, height: rotated ? frameWidth : frameHeight };
      if (!Object.values(crop).every((n) => Number.isInteger(n) && n >= 0) || !crop.width || !crop.height) throw new Error('SpriteFrame crop is not positive integer geometry');
      let image = sharp(source.data, { raw: { width: source.width, height: source.height, channels: 4 } }).extract(crop);
      if (rotated) image = image.rotate(-90);
      const png = await image.png().toBuffer();
      record.sprite = await outputFile(`sprites/${record.bundle}/${record.uuid}.png`, png, 'converted-sprite', record.importEntry, { width: frameWidth, height: frameHeight, textureUuid: uuid, sourceTextureSha256: textureRecords.get(uuid)?.texture?.sourceSha256, originalRect: frame.rect, rotated, originalSize: frame.originalSize, offset: frame.offset, capInsets: frame.capInsets, reconstructionPolicy: 'trimmed sprite pixels; retain originalSize/offset for runtime placement, not a guessed full-size center' });
    } catch (error) { recordError('sprite-conversion', record, error); }
  }
  const assetList = [...records.values()];
  const stats = assetStats(assetList, maps.length, errors.length);
  if (stats.originalMapAssets !== 617 || stats.parsedMaps !== stats.originalMapAssets || stats.convertedMaps !== stats.originalMapAssets) {
    recordError('coverage', undefined, new Error(`Required 617 original maps; found ${stats.originalMapAssets}, parsed ${stats.parsedMaps}, rendered ${stats.convertedMaps}`));
    stats.failures = errors.length;
  }
  const manifest = {
    schemaVersion: 1,
    origin: 'added',
    source: { origin: 'original', kind: 'public-apk-zip', sha256: apkSha256 },
    scope: {
      originalBundleNames: BUNDLES,
      allowlistedLogicalRoots: [...ROOTS],
      exclusions: ['SDK', 'ads', 'accounts', 'payments', 'engine materials/effects', 'code', 'protection libraries', 'unreferenced archive files'],
      npcBusinessMappings: 'not-inferred',
      collisionRules: 'candidate-only',
      directReactNativeSpinePlayback: false,
      animationBaking: 'not-performed',
      generatedArt: false,
    },
    conversion: {
      tool: 'tools/assets/original-import.mjs',
      version: 4,
      options: { layers: options.layers, allVisualTextures: options.textures, sprites: options.sprites, chunkSize: options.chunkSize },
      resume: resume?.audit ?? null,
      originalAssetMarker: 'origin: original',
      derivedAssetMarker: 'origin: added',
      runtimeMapStrategy: 'One full PNG per map/layer plus default 2048px viewport chunks for large maps. RN mounts only visible chunks, not one view per tile. Preserve layerIndex when inserting actors; collision remains independent and unverified.',
      textureSupport: 'Standard PKM ETC1/ETC2 RGB8 via texture2ddecoder==1.0.6 and ordinary images. Public PNG 10 custom RGB interpretation fails closed after observed standard-decoder color-noise diagnostics; its prior texture/sprite/map/layer/chunk images are rejected evidence, never usable original pixels.',
      originalRgbStatus: 'unsupported-custom-PNG10-RGB-semantics',
      originalRgbBoundary: ORIGINAL_RGB_BOUNDARY,
      diagnosticEvidence: 'assets/original/diagnostics/map-111/evidence.json',
      licensingBoundary: 'Original Spine binary/JSON skeleton versions and atlas are indexed and textures converted only. Animation playback/baking needs a version-compatible runtime/exporter with its applicable license; no unlicensed new-engine bake or RN compatibility is claimed.',
    },
    originalManifests,
    stats,
    assets: assetList,
    failures: errors,
  };
  safeMetadata(manifest);
  await mkdir(path.dirname(MANIFEST), { recursive: true });
  await writeFile(MANIFEST, `${JSON.stringify(manifest)}\n`);
  console.log(JSON.stringify({ manifest: posix(path.relative(ROOT, MANIFEST)), sourceApkSha256: apkSha256, stats }, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
