import sharp from 'sharp';
import { child, children, layerGids, numberAttribute, parseXml, properties } from './original-formats.mjs';

export function readTiledMap(asset, references, resolveText, resolveNamedAsset) {
  const source = parseXml(asset.tmxXmlStr);
  if (source.name !== 'map') throw new Error('TiledMapAsset does not contain a map');
  const tilesets = children(source, 'tileset').map((entry) => {
    let xml = entry;
    let externalUuid;
    const referenceResolution = [];
    if (entry.attributes.source) {
      const index = asset.tsxFileNames?.indexOf(entry.attributes.source);
      const ref = index === undefined || index < 0 ? undefined : asset.tsxFiles?.[index];
      externalUuid = typeof ref === 'number' ? references[ref] : ref?.__uuid__;
      if (!externalUuid) {
        externalUuid = resolveNamedAsset('cc.TextAsset', entry.attributes.source);
        referenceResolution.push({ origin: 'added', kind: 'external-tsx', filename: entry.attributes.source, uuid: externalUuid, evidence: 'unique original manifest logical basename matches explicit TMX source basename' });
      }
      xml = parseXml(resolveText(externalUuid));
      if (xml.name !== 'tileset') throw new Error('External TSX root is not tileset');
    }
    const image = child(xml, 'image');
    if (!image) throw new Error('Image-collection tilesets require a separate renderer');
    const imageName = image.attributes.source;
    const textureIndex = asset.textureNames?.indexOf(imageName);
    const textureRef = textureIndex === undefined || textureIndex < 0 ? undefined : asset.textures?.[textureIndex];
    let textureUuid = typeof textureRef === 'number' ? references[textureRef] : textureRef?.__uuid__;
    if (!textureUuid) {
      textureUuid = resolveNamedAsset('cc.Texture2D', imageName);
      referenceResolution.push({ origin: 'added', kind: 'tileset-texture', filename: imageName, uuid: textureUuid, evidence: 'unique original manifest logical basename matches explicit TSX image basename' });
    }
    const tileWidth = numberAttribute(xml, 'tilewidth'), tileHeight = numberAttribute(xml, 'tileheight');
    const spacing = numberAttribute(xml, 'spacing', 0), margin = numberAttribute(xml, 'margin', 0);
    const imageWidth = numberAttribute(image, 'width'), imageHeight = numberAttribute(image, 'height');
    const columns = numberAttribute(xml, 'columns', Math.floor((imageWidth - 2 * margin + spacing) / (tileWidth + spacing)));
    const tileCount = numberAttribute(xml, 'tilecount', columns * Math.floor((imageHeight - 2 * margin + spacing) / (tileHeight + spacing)));
    if (![tileWidth, tileHeight, columns, tileCount].every((n) => Number.isInteger(n) && n > 0)) throw new Error('Invalid tileset geometry');
    return { origin: 'original', firstGid: numberAttribute(entry, 'firstgid'), name: xml.attributes.name, tileWidth, tileHeight, spacing, margin, columns, tileCount, image: { ...image.attributes, textureUuid, width: imageWidth, height: imageHeight }, externalSource: entry.attributes.source, externalUuid, referenceResolution, properties: properties(xml), xml };
  });
  const layers = [];
  const visit = (node, parentIndex) => {
    if (!['layer', 'group', 'objectgroup', 'imagelayer'].includes(node.name)) return;
    const index = layers.length;
    const layer = { origin: 'original', index, parentIndex, kind: node.name, name: node.attributes.name ?? '', attributes: node.attributes, properties: properties(node), xml: node };
    if (node.name === 'layer') {
      layer.width = numberAttribute(node, 'width'); layer.height = numberAttribute(node, 'height');
      const data = child(node, 'data');
      if (!data) throw new Error('Tile layer has no data');
      layer.gids = layerGids(data, layer.width, layer.height);
      // Unsigned GIDs retain all four high bits. No pathfinding rule is inferred.
      if (layer.name.toLowerCase() === 'pz') layer.collision = { origin: 'added', status: 'candidate', evidence: 'original layer name pz', rule: 'unverified; nonzero GID is not asserted to mean blocked' };
    }
    layers.push(layer);
    if (node.name === 'group') node.children.forEach((nested) => visit(nested, index));
  };
  source.children.forEach((node) => visit(node, null));
  return { origin: 'original', attributes: source.attributes, width: numberAttribute(source, 'width'), height: numberAttribute(source, 'height'), tileWidth: numberAttribute(source, 'tilewidth'), tileHeight: numberAttribute(source, 'tileheight'), orientation: source.attributes.orientation, renderOrder: source.attributes.renderorder ?? 'right-down', properties: properties(source), tilesets, layers, sourceXml: asset.tmxXmlStr, objectPlacementPolicy: 'original XML only; no NPC coordinates or business-to-visual IDs inferred' };
}

function blend(target, destination, source, pixel, opacity) {
  const alpha = source[pixel + 3] / 255 * opacity;
  if (!alpha) return;
  if (alpha === 1) {
    target[destination] = source[pixel]; target[destination + 1] = source[pixel + 1]; target[destination + 2] = source[pixel + 2]; target[destination + 3] = 255;
    return;
  }
  const oldAlpha = target[destination + 3] / 255;
  const resultAlpha = alpha + oldAlpha * (1 - alpha);
  for (let channel = 0; channel < 3; channel++) target[destination + channel] = Math.round((source[pixel + channel] * alpha + target[destination + channel] * oldAlpha * (1 - alpha)) / resultAlpha);
  target[destination + 3] = Math.round(resultAlpha * 255);
}
function layerState(map, layer) {
  let visible = true, opacity = 1, x = 0, y = 0;
  let current = layer;
  while (current) {
    visible &&= current.attributes.visible !== '0';
    opacity *= Number(current.attributes.opacity ?? 1);
    x += Number(current.attributes.offsetx ?? 0) + Number(current.attributes.x ?? 0) * map.tileWidth;
    y += Number(current.attributes.offsety ?? 0) + Number(current.attributes.y ?? 0) * map.tileHeight;
    if (current.attributes.tintcolor || Number(current.attributes.parallaxx ?? 1) !== 1 || Number(current.attributes.parallaxy ?? 1) !== 1) throw new Error('Tinted/parallax map layers require an explicit renderer');
    current = current.parentIndex === null ? null : map.layers[current.parentIndex];
  }
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1 || !Number.isInteger(x) || !Number.isInteger(y)) throw new Error('Unsupported fractional layer offsets or opacity');
  return { visible, opacity, x, y };
}
async function rasterChunks(data, width, height, chunkSize) {
  if (!chunkSize || width <= chunkSize && height <= chunkSize) return [];
  const images = [];
  for (let y = 0; y < height; y += chunkSize) for (let x = 0; x < width; x += chunkSize) {
    const cropWidth = Math.min(chunkSize, width - x), cropHeight = Math.min(chunkSize, height - y);
    images.push({ x, y, width: cropWidth, height: cropHeight, png: await sharp(data, { raw: { width, height, channels: 4 } }).extract({ left: x, top: y, width: cropWidth, height: cropHeight }).png().toBuffer() });
  }
  return images;
}

export async function renderTiledMap(map, getTexture, { layers = false, chunkSize = 2048, maxPixels = 128_000_000 } = {}) {
  if (map.orientation !== 'orthogonal' || map.attributes.infinite === '1') throw new Error(`Unsupported map orientation ${map.orientation}`);
  const width = map.width * map.tileWidth, height = map.height * map.tileHeight;
  if (!Number.isSafeInteger(width * height) || width * height <= 0 || width * height > maxPixels) throw new Error('Map exceeds raster pixel limit');
  const textures = new Map();
  for (const set of map.tilesets) {
    if (children(set.xml, 'tile').some((tile) => child(tile, 'animation'))) throw new Error('Animated tiles require animation baking; no static frame substituted');
    if (child(set.xml, 'tileoffset')) throw new Error('Tileset offsets require an explicit renderer');
    textures.set(set.image.textureUuid, await getTexture(set.image.textureUuid, { width: set.image.width, height: set.image.height }));
  }
  const orderedTilesets = [...map.tilesets].sort((a, b) => b.firstGid - a.firstGid);
  const complete = Buffer.alloc(width * height * 4);
  if (map.attributes.backgroundcolor) {
    const color = map.attributes.backgroundcolor;
    if (!/^#[\da-f]{6}$/i.test(color)) throw new Error('Unsupported Tiled background color');
    for (let i = 0; i < width * height; i++) { complete[i * 4] = parseInt(color.slice(1, 3), 16); complete[i * 4 + 1] = parseInt(color.slice(3, 5), 16); complete[i * 4 + 2] = parseInt(color.slice(5, 7), 16); complete[i * 4 + 3] = 255; }
  }
  const images = [];
  const omittedNonVisualLayers = [];
  for (const layer of map.layers) {
    const state = layerState(map, layer);
    if (layer.kind === 'group') continue;
    if (layer.kind === 'imagelayer') throw new Error('Image layer rendering is not supported; refuse incomplete map');
    if (layer.kind === 'objectgroup') {
      if (children(layer.xml, 'object').some((object) => object.attributes.gid || object.attributes.template || child(object, 'text'))) throw new Error('Visual tile/template/text objects require an explicit renderer');
      omittedNonVisualLayers.push(layer.index); continue;
    }
    if (!state.visible) continue;
    const raster = layers ? Buffer.alloc(width * height * 4) : null;
    const ys = Array.from({ length: layer.height }, (_, y) => y);
    const xs = Array.from({ length: layer.width }, (_, x) => x);
    if (map.renderOrder.endsWith('up')) ys.reverse();
    if (map.renderOrder.startsWith('left')) xs.reverse();
    if (!['right-down', 'right-up', 'left-down', 'left-up'].includes(map.renderOrder)) throw new Error('Unsupported tile render order');
    for (const gy of ys) for (const gx of xs) {
      const rawGid = layer.gids[gy * layer.width + gx] >>> 0;
      if (rawGid & 0x10000000) throw new Error('Hexagonal rotation bit in orthogonal map');
      const gid = rawGid & 0x0fffffff;
      if (!gid) continue;
      const set = orderedTilesets.find((candidate) => candidate.firstGid <= gid);
      if (!set || gid - set.firstGid >= set.tileCount) throw new Error(`GID ${gid} has no tileset tile`);
      const tile = gid - set.firstGid;
      const texture = textures.get(set.image.textureUuid);
      const sourceX = set.margin + tile % set.columns * (set.tileWidth + set.spacing);
      const sourceY = set.margin + Math.floor(tile / set.columns) * (set.tileHeight + set.spacing);
      if (sourceX + set.tileWidth > texture.width || sourceY + set.tileHeight > texture.height) throw new Error('Tile crop exceeds original image');
      const horizontal = !!(rawGid & 0x80000000), vertical = !!(rawGid & 0x40000000), diagonal = !!(rawGid & 0x20000000);
      if (diagonal && set.tileWidth !== set.tileHeight) throw new Error('Diagonal rectangular tile requires an explicit renderer');
      for (let sy = 0; sy < set.tileHeight; sy++) for (let sx = 0; sx < set.tileWidth; sx++) {
        // Tiled orthogonal flag order: exchange axes, then horizontal/vertical.
        let dx = diagonal ? sy : sx, dy = diagonal ? sx : sy;
        if (horizontal) dx = set.tileWidth - 1 - dx;
        if (vertical) dy = set.tileHeight - 1 - dy;
        dx += gx * map.tileWidth + state.x;
        dy += gy * map.tileHeight + map.tileHeight - set.tileHeight + state.y;
        if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
        const sourcePixel = ((sourceY + sy) * texture.width + sourceX + sx) * 4;
        const destination = (dy * width + dx) * 4;
        blend(complete, destination, texture.data, sourcePixel, state.opacity);
        if (raster) blend(raster, destination, texture.data, sourcePixel, state.opacity);
      }
    }
    if (raster) images.push({ layerIndex: layer.index, png: await sharp(raster, { raw: { width, height, channels: 4 } }).png().toBuffer(), chunks: await rasterChunks(raster, width, height, chunkSize) });
  }
  return { width, height, png: await sharp(complete, { raw: { width, height, channels: 4 } }).png().toBuffer(), chunks: await rasterChunks(complete, width, height, chunkSize), images, omittedNonVisualLayers, policy: 'Original visible tile layers in original order. Geometric objectgroups preserved as data, not invented gameplay visuals. Collision candidates do not affect rendering. Large rasters additionally provide viewport-sized PNG chunks, not per-tile views.' };
}
