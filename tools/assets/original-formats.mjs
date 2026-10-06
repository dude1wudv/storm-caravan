import { gunzipSync, inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function decodeUuid(value) {
  if (typeof value !== 'string') throw new Error('UUID must be a string');
  const [base, ...suffix] = value.split('@');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(base)) return value;
  if (base.length !== 22 || !/^[0-9a-f]{2}[A-Za-z0-9+/]{20}$/i.test(base)) throw new Error(`Unsupported Cocos UUID: ${value}`);
  let hex = base.slice(0, 2);
  for (let i = 2; i < 22; i += 2) hex += (BASE64.indexOf(base[i]) * 64 + BASE64.indexOf(base[i + 1])).toString(16).padStart(3, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}${suffix.length ? `@${suffix.join('@')}` : ''}`;
}

// Decode only the ordinary, public serialized fields. Keep the original document for
// Cocos reference tables/custom component data rather than inventing engine objects.
export function cocosDocument(raw) {
  if (!Array.isArray(raw) || raw[0] !== 1) {
    const objects = Array.isArray(raw) ? raw : [raw];
    const references = new Set();
    const scan = (v) => { if (!v || typeof v !== 'object') return; if (typeof v.__uuid__ === 'string') references.add(decodeUuid(v.__uuid__)); Object.values(v).forEach(scan); };
    scan(raw);
    return { objects, references: [...references] };
  }
  const references = Array.isArray(raw[1]) ? raw[1].map(decodeUuid) : [];
  const classes = raw[3];
  const masks = raw[4];
  const instances = raw[5];
  if (!Array.isArray(classes) || !Array.isArray(instances)) throw new Error('Unsupported public Cocos document layout');
  if (typeof classes[0] === 'string') {
    return { objects: [{ __type__: classes[0], value: instances }], references };
  }
  const objects = instances.map((instance) => {
    if (!Array.isArray(instance) || !Number.isInteger(instance[0])) return instance;
    const mask = masks?.[instance[0]];
    const cls = classes[mask?.[0]];
    if (!Array.isArray(mask) || !Array.isArray(cls) || !Array.isArray(cls[1])) return { serialized: instance };
    const result = { __type__: cls[0] };
    for (let i = 1; i < instance.length; i++) {
      const field = cls[1][mask[i]];
      if (typeof field !== 'string') throw new Error(`Unsupported field mask in ${cls[0]}`);
      result[field] = instance[i];
    }
    return result;
  });
  return { objects, references };
}

function xmlText(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity[0] === '#') return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
  });
}
export function parseXml(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('External XML entities are not supported');
  const root = { name: '#document', attributes: {}, children: [], text: '' };
  const stack = [root];
  const tokens = source.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^>"']|"[^"]*"|'[^']*')+>|[^<]+/g) ?? [];
  for (const token of tokens) {
    const current = stack[stack.length - 1];
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { current.text += token.slice(9, -3); continue; }
    if (!token.startsWith('<')) { current.text += xmlText(token); continue; }
    if (token.startsWith('</')) {
      if (stack.length === 1 || current.name !== token.slice(2, -1).trim()) throw new Error('Mismatched XML close tag');
      stack.pop(); continue;
    }
    const match = /^<([\w:.-]+)([\s\S]*?)\/?\s*>$/.exec(token);
    if (!match) throw new Error('Unsupported XML token');
    const attributes = {};
    let remaining = match[2];
    for (const attr of remaining.matchAll(/([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g)) attributes[attr[1]] = xmlText(attr[2].slice(1, -1));
    remaining = remaining.replace(/([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g, '').trim();
    if (remaining) throw new Error('Unsupported XML attribute syntax');
    const child = { name: match[1], attributes, children: [], text: '' };
    current.children.push(child);
    if (!/\/\s*>$/.test(token)) stack.push(child);
  }
  if (stack.length !== 1 || root.children.length !== 1) throw new Error('Incomplete XML document');
  return root.children[0];
}
export const children = (node, name) => node.children.filter((child) => child.name === name);
export const child = (node, name) => children(node, name)[0];
export function properties(node) {
  return children(child(node, 'properties') ?? { children: [] }, 'property').map((p) => ({ ...p.attributes, value: p.attributes.value ?? p.text, children: p.children }));
}
export function numberAttribute(node, key, fallback) {
  if (node.attributes[key] === undefined && fallback !== undefined) return fallback;
  const number = Number(node.attributes[key]);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${node.name}.${key}`);
  return number;
}
export function layerGids(data, width, height) {
  if (children(data, 'chunk').length) throw new Error('Infinite/chunked maps require an explicit renderer');
  let gids;
  switch (data.attributes.encoding) {
    case 'base64': {
      const text = data.text.replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('Invalid base64 tile layer');
      let bytes = Buffer.from(text, 'base64');
      if (data.attributes.compression === 'zlib') bytes = inflateSync(bytes);
      else if (data.attributes.compression === 'gzip') bytes = gunzipSync(bytes);
      else if (data.attributes.compression) throw new Error(`Unsupported tile compression ${data.attributes.compression}`);
      if (bytes.length !== width * height * 4) throw new Error('Tile layer byte count differs from geometry');
      gids = Array.from({ length: width * height }, (_, i) => bytes.readUInt32LE(i * 4));
      break;
    }
    case 'csv': gids = data.text.trim().split(/\s*,\s*/).map(Number); break;
    case undefined: gids = children(data, 'tile').map((tile) => numberAttribute(tile, 'gid')); break;
    default: throw new Error(`Unsupported tile encoding ${data.attributes.encoding}`);
  }
  if (gids.length !== width * height || gids.some((gid) => !Number.isInteger(gid) || gid < 0 || gid > 0xffffffff)) throw new Error('Invalid tile GIDs');
  return gids;
}

const signed3 = (n) => n > 3 ? n - 8 : n;
export const ORIGINAL_RGB_BOUNDARY = 'PNG 10 RGB semantics are unverified: standard ETC1/ETC2 decoding of original map1 produces visible color noise while alpha is correct. No protection analysis/bypass, alpha-only background or fabricated replacement is permitted. Prior PNG 10-derived images are diagnostic evidence, not usable original pixels.';
export function decodeEtcTexture(bytes, expectedSize, python) {
  if (bytes.length < 16) throw new Error('Truncated public ETC header');
  const signature = bytes.subarray(0, 6).toString('ascii');
  if (signature === 'PNG 10') throw new Error(ORIGINAL_RGB_BOUNDARY);
  if (!['PKM 10', 'PKM 20'].includes(signature)) throw new Error(`Unsupported PKM header ${JSON.stringify(signature)}`);
  const format = bytes.readUInt16BE(6);
  if (format !== 0 && !(signature === 'PKM 20' && format === 1)) throw new Error(`Unsupported public ETC format ${format}`);
  const encodedWidth = bytes.readUInt16BE(8), encodedHeight = bytes.readUInt16BE(10);
  const width = bytes.readUInt16BE(12), height = bytes.readUInt16BE(14);
  if (!width || !height || encodedWidth % 4 || encodedHeight % 4 || encodedWidth < width || encodedHeight < height || encodedWidth - width > 3 || encodedHeight - height > 3) throw new Error('Invalid public ETC geometry');
  if (encodedWidth * encodedHeight > 128_000_000 || bytes.length !== 16 + encodedWidth * encodedHeight / 2) throw new Error('Invalid public ETC RGB8 payload size');
  let escapeBlocks = 0;
  for (let offset = 16; offset < bytes.length; offset += 8) {
    const high = bytes.readUInt32BE(offset);
    if (!(high & 2)) continue;
    for (const shift of [24, 16, 8]) {
      const value = (high >>> shift) & 255;
      const second = (value >>> 3) + signed3(value & 7);
      if (second < 0 || second > 31) { escapeBlocks++; break; }
    }
  }
  if (format === 0 && escapeBlocks) throw new Error('Standard ETC1 PKM contains invalid differential blocks');
  const codec = format === 1 ? 'etc2' : 'etc1';
  if (expectedSize && (width !== expectedSize.width || height !== expectedSize.height)) throw new Error('Standard PKM geometry differs from explicit original source dimensions');
  const process = spawnSync(python, [fileURLToPath(new URL('./original-etc.py', import.meta.url)), '--codec', codec, '--width', String(encodedWidth), '--height', String(encodedHeight)], { input: bytes.subarray(16), maxBuffer: encodedWidth * encodedHeight * 4 + 1_048_576, windowsHide: true });
  if (process.error) throw new Error('ETC decoder process unavailable; configure --python and install texture2ddecoder==1.0.6');
  if (process.status !== 0) throw new Error(`Standard ETC decoder failed: ${String(process.stderr).trim()}`);
  if (process.stdout.length !== encodedWidth * encodedHeight * 4) throw new Error('Standard ETC decoder returned invalid pixel length');
  const decoded = process.stdout;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) decoded.copy(rgba, y * width * 4, y * encodedWidth * 4, (y * encodedWidth + width) * 4);
  return { data: rgba, width, height, originalHeader: signature, alphaLayout: 'opaque-single-plane', formatField: format, codec, escapeBlocks, decoder: 'texture2ddecoder==1.0.6 (standard ETC RGB8; BGRA to RGBA)', encodedWidth, encodedHeight, sourceWidth: width, sourceHeight: height, croppedPaddingRows: encodedHeight - height, croppedPaddingColumns: encodedWidth - width, conversion: `standard ${codec.toUpperCase()} RGB` };
}

function spineVersionInfo(skeletonHash, version, dataFormat, headerBytes) {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version ?? '')) throw new Error(`Unrecognized Spine ${dataFormat} version`);
  return { skeletonHash, version, dataFormat, headerBytes, playableInReactNative: false, bakingStatus: 'not-performed', licensingBoundary: 'Original skeleton/atlas indexing and texture conversion do not execute Spine. Baking animation requires a version-compatible runtime/exporter and its applicable license; no new engine license is assumed.' };
}

export function spineJsonInfo(value) {
  const json = typeof value === 'string' ? JSON.parse(value) : value;
  if (!json || typeof json !== 'object' || !json.skeleton) throw new Error('Original Spine JSON header missing');
  return { ...spineVersionInfo(json.skeleton.hash ?? null, json.skeleton.spine, 'json', 0), animationNames: Object.keys(json.animations ?? {}) };
}

export function spineHeader(bytes) {
  let position = 0;
  function string() {
    let length = 0, shift = 0;
    for (let count = 0; count < 5; count++) {
      if (position >= bytes.length) throw new Error('Truncated Spine header');
      const b = bytes[position++]; length |= (b & 127) << shift;
      if (!(b & 128)) {
        if (length === 0) return null;
        const size = length - 1;
        if (size < 0 || position + size > bytes.length) throw new Error('Invalid Spine header string');
        const value = bytes.subarray(position, position + size).toString('utf8'); position += size; return value;
      }
      shift += 7;
    }
    throw new Error('Invalid Spine string varint');
  }
  const skeletonHash = string(), version = string();
  return spineVersionInfo(skeletonHash, version, 'binary', position);
}

export function parseAtlas(text) {
  const pages = [];
  let page, region, afterBlank = true;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) { afterBlank = true; region = undefined; continue; }
    const colon = line.indexOf(':');
    if (colon < 0) {
      if (!page || afterBlank) { page = { name: line, attributes: {}, regions: [] }; pages.push(page); region = undefined; }
      else { region = { name: line, attributes: {} }; page.regions.push(region); }
      afterBlank = false; continue;
    }
    if (!page) throw new Error('Atlas property precedes page');
    (region ?? page).attributes[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return pages;
}
