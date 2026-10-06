import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeUuid } from './original-formats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OPTIONS = { manifest: path.join(ROOT, 'assets/manifests/original-assets.json'), sourcePack: path.resolve(ROOT, '../../games/合金机兵_UI与剧情文本完整包'), helpListReference: path.resolve(ROOT, '../../05-builds/storm-caravan/reference-play/15-original-help-document.png') };
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--manifest') OPTIONS.manifest = path.resolve(process.argv[++index]);
  else if (argument === '--source-pack') OPTIONS.sourcePack = path.resolve(process.argv[++index]);
  else if (argument === '--help-list-reference') OPTIONS.helpListReference = path.resolve(process.argv[++index]);
  else if (argument === '--help') { console.log('node tools/assets/original-ui.mjs [--manifest FILE] [--source-pack DIRECTORY] [--help-list-reference ORIGINAL_SCREENSHOT]\\nStatic public Prefab data only; no original JavaScript is executed.'); process.exit(0); }
  else throw new Error(`Unknown argument: ${argument}`);
}
const PREFABS = {
  Main: 'view/LayoutMain', Battle: 'view/LayoutBattle', Team: 'view/LayoutTeam',
  HelpHandbook: 'view/LayoutHelpHandbook', Talk: 'view/LayoutTalk',
  HelpHandbookInner1: 'part/PartHelpHandbookInner1',
  UserRes: 'part/PartUserRes', UserRes2: 'part/PartUserRes2',
  PlayerInfo: 'view/LayoutPlayerInfo', MainRole: 'part/PartMainRole',
};
const NAMES = Object.keys(PREFABS);
const LOCALIZED = '04d65i9CSpIY5rjNK0PE+Xl';
const SUPPORTED = { 'cc.Sprite': true, 'cc.Label': true, 'cc.RichText': true, 'cc.EditBox': true, 'cc.Widget': true, 'cc.Button': true, 'cc.ScrollView': true, 'cc.Layout': true, 'cc.PrefabInfo': true, 'cc.LabelOutline': true, 'cc.LabelShadow': true, [LOCALIZED]: true };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = filename => path.relative(ROOT, filename).split(path.sep).join('/');
const number = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

// Deserialize only class/mask instances and fields whose engine dtype establishes
// their context. In particular an arbitrary list is never guessed to be an instance.
function decodeCompiled(data, unsupported) {
  if (!Array.isArray(data) || data.length !== 11 || data[0] !== 1 || !Array.isArray(data[3]) || !Array.isArray(data[4]) || !Array.isArray(data[5])) throw new Error('Unsupported compiled Prefab envelope (expected ordinary v1, 11 fields)');
  if (data[6] !== 0) throw new Error(`Custom instance payload count ${JSON.stringify(data[6])} is not supported`);
  const instances = data[5];
  let count = instances.length;
  let rootIndex = 0;
  if (typeof instances[count - 1] === 'number') {
    const root = instances[--count];
    rootIndex = root < 0 ? ~root : root;
  }
  const decoded = new Map();
  const reference = (value, pointer) => {
    if (value === null) return null;
    const index = Number.isInteger(value) ? (value < 0 ? data[7]?.[3 * (~value) + 2] : value) : undefined;
    if (!Number.isInteger(index) || index < 0 || index >= count) { unsupported.push({ pointer, reason: `Invalid instance reference ${JSON.stringify(value)}` }); return null; }
    return { ref: `/5/${index}` };
  };
  const dependency = (value, pointer) => {
    const uuidIndex = Number.isInteger(value) ? data[10]?.[value] : undefined;
    const encoded = Number.isInteger(uuidIndex) ? data[1]?.[uuidIndex] : undefined;
    if (typeof encoded !== 'string') { unsupported.push({ pointer, reason: `Unresolved asset dependency slot ${JSON.stringify(value)}` }); return null; }
    try { return { uuid: decodeUuid(encoded) }; }
    catch (error) { unsupported.push({ pointer, reason: error.message }); return null; }
  };
  const typed = (type, value, pointer) => {
    switch (type) {
      case 0: return value;
      case 1: return reference(value, pointer);
      case 2: return Array.isArray(value) ? value.map((child, index) => reference(child, `${pointer}/${index}`)) : fail(type, value, pointer);
      case 3: return Array.isArray(value) ? value.map((child, index) => dependency(child, `${pointer}/${index}`)) : fail(type, value, pointer);
      case 4: return instance(value, pointer);
      case 5: return Array.isArray(value) ? { valueType: value[0], values: value.slice(1) } : fail(type, value, pointer);
      case 6: return dependency(value, pointer);
      case 7: return Array.isArray(value) ? value : fail(type, value, pointer);
      case 9: return Array.isArray(value) ? value.map((child, index) => instance(child, `${pointer}/${index}`)) : fail(type, value, pointer);
      case 11: {
        if (!Array.isArray(value) || !value[0] || typeof value[0] !== 'object' || (value.length - 1) % 3) return fail(type, value, pointer);
        const result = { ...value[0] };
        for (let index = 1; index < value.length; index += 3) result[value[index]] = typed(value[index + 1], value[index + 2], `${pointer}/${index + 2}`);
        return result;
      }
      case 12: {
        if (!Array.isArray(value) || !Array.isArray(value[0]) || value.length !== value[0].length + 1) return fail(type, value, pointer);
        return value[0].map((child, index) => typed(value[index + 1], child, `${pointer}/0/${index}`));
      }
      default: return fail(type, value, pointer);
    }
  };
  const fail = (type, value, pointer) => { unsupported.push({ pointer, reason: `Unsupported/malformed engine dtype ${type}; raw retained, not treated as instance` }); return { unsupportedType: type, raw: value }; };
  const instance = (raw, pointer) => {
    if (decoded.has(pointer)) return { ref: pointer };
    const mask = Array.isArray(raw) && Number.isInteger(raw[0]) ? data[4][raw[0]] : undefined;
    const schema = Array.isArray(mask) ? data[3][mask[0]] : undefined;
    const boundary = mask?.at(-1);
    if (!Array.isArray(schema) || !Array.isArray(schema[1]) || raw.length !== mask.length - 1 || !Number.isInteger(boundary) || boundary < 1 || boundary > raw.length) { unsupported.push({ pointer, reason: 'Malformed class/mask instance; not promoted to an object' }); return null; }
    const object = { class: schema[0], pointer, fields: {}, rawFields: {}, fieldPointers: {} };
    decoded.set(pointer, object);
    for (let index = 1; index < raw.length; index++) {
      const propertyIndex = mask[index];
      const field = schema[1][propertyIndex];
      const fieldPointer = `${pointer}/${index}`;
      if (typeof field !== 'string') { unsupported.push({ pointer: fieldPointer, reason: `Invalid property index ${propertyIndex}` }); continue; }
      object.rawFields[field] = raw[index];
      object.fieldPointers[field] = fieldPointer;
      object.fields[field] = typed(index < boundary ? 0 : schema[propertyIndex + schema[2]], raw[index], fieldPointer);
    }
    return { ref: pointer };
  };
  for (let index = 0; index < count; index++) instance(instances[index], `/5/${index}`);
  return { decoded, rootIndex };
}

async function main() {
  const manifestBytes = await readFile(OPTIONS.manifest);
  const manifest = JSON.parse(manifestBytes);
  const localizationBytes = await readFile(path.join(OPTIONS.sourcePack, '合金机兵_文本数据/界面本地化字典.json'));
  const extractionBytes = await readFile(path.join(OPTIONS.sourcePack, '合金机兵_文本数据/界面预制组件文本.json'));
  const localization = JSON.parse(localizationBytes);
  const extraction = JSON.parse(extractionBytes);
  const assets = new Map(manifest.assets.map(asset => [asset.uuid, asset]));
  const images = new Map();
  const output = path.join(ROOT, 'assets/original-ui');
  await mkdir(output, { recursive: true });
  const layouts = {};
  const commandNodes = {};
  const verified = new Map();
  const trustedVisual = async uuid => {
    if (verified.has(uuid)) return verified.get(uuid);
    const asset = assets.get(uuid);
    const texture = assets.get(asset?.sprite?.textureUuid);
    let reason;
    if (asset?.rejectedVisuals || texture?.rejectedVisuals) reason = 'rejectedRGB: manifest explicitly rejects the original visual; retained files are diagnostics only';
    else if (!asset?.sprite) reason = 'No successfully converted sprite in original manifest';
    else if (!texture?.texture) reason = 'Sprite source texture has no successful conversion';
    else if (texture.texture.originalHeader === 'PNG 10' || JSON.stringify([asset, texture]).match(/rejectedRGB|unverified|diagnostic-only/i)) reason = 'rejectedRGB: original PNG 10 RGB is unverified; diagnostic images must not become UI art';
    else if (texture.texture.conversion !== 'ordinary image to RGBA' && texture.texture.visualStatus !== 'verified') reason = 'Texture has no verified ordinary-image/explicit visual evidence';
    else {
      try {
        const bytes = await readFile(path.join(ROOT, asset.sprite.path));
        const textureBytes = await readFile(path.join(ROOT, texture.texture.path));
        if (sha(bytes) !== asset.sprite.sha256 || sha(textureBytes) !== texture.texture.sha256) reason = 'Manifest image SHA mismatch';
        else if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) reason = 'Sprite is not an ordinary decoded PNG';
        else if (asset.sprite.sourceTextureSha256 !== texture.texture.sourceSha256) reason = 'Sprite source texture provenance does not match';
        else { images.set(uuid, asset.sprite); verified.set(uuid, { image: uuid }); return { image: uuid }; }
      } catch (error) { reason = `Sprite file unavailable: ${error.code ?? error.message}`; }
    }
    const failure = { image: null, missingVisual: reason };
    verified.set(uuid, failure);
    return failure;
  };
  for (const name of NAMES) {
    const logicalId = PREFABS[name];
    const asset = manifest.assets.find(candidate => candidate.type === 'cc.Prefab' && candidate.logicalIds.includes(logicalId));
    if (!asset?.descriptor?.path) throw new Error(`Missing original Prefab descriptor: ${logicalId}`);
    const descriptorBytes = await readFile(path.join(ROOT, asset.descriptor.path));
    if (sha(descriptorBytes) !== asset.descriptor.sha256) throw new Error(`Descriptor SHA mismatch: ${logicalId}`);
    const serialized = JSON.parse(descriptorBytes).serialized;
    const unsupported = [];
    const { decoded, rootIndex } = decodeCompiled(serialized, unsupported);
    const dereference = value => value?.ref ? decoded.get(value.ref) : undefined;
    const nodes = [...decoded.values()].filter(object => object.class === 'cc.Node' || object.class === 'cc.PrivateNode');
    const rootObject = decoded.get(`/5/${rootIndex}`);
    const rootNode = dereference(rootObject?.fields.data) ?? nodes.find(node => !dereference(node.fields._parent));
    if (!rootNode) throw new Error(`No original root cc.Node: ${logicalId}`);
    const paths = new Map();
    const ordered = [];
    const walk = (object, parentPath) => {
      if (paths.has(object.pointer)) { unsupported.push({ pointer: object.pointer, reason: 'Duplicate/cyclic node child reference' }); return; }
      const segment = String(object.fields._name ?? '(unnamed)').replaceAll('/', '%2F');
      let nodePath = parentPath ? `${parentPath}/${segment}` : segment;
      if (ordered.some(node => node.path === nodePath)) nodePath += `@${object.pointer.replaceAll('/', '_')}`;
      paths.set(object.pointer, nodePath);
      ordered.push({ object, path: nodePath, parent: parentPath });
      for (const child of object.fields._children ?? []) {
        const target = dereference(child);
        if (target?.class === 'cc.Node' || target?.class === 'cc.PrivateNode') walk(target, nodePath);
        else unsupported.push({ pointer: object.pointer, reason: `Unresolved/non-Node child ${JSON.stringify(child)}` });
      }
    };
    walk(rootNode, null);
    for (const node of nodes) if (!paths.has(node.pointer)) unsupported.push({ pointer: node.pointer, reason: 'Node is not reachable from original root; not displayed' });
    const componentOwners = new Map();
    for (const node of ordered) for (const ref of node.object.fields._components ?? []) if (ref?.ref) componentOwners.set(ref.ref, node.path);
    const resolvePath = value => paths.get(value?.ref) ?? componentOwners.get(value?.ref) ?? null;
    const fieldsReferencing = new Map();
    for (const object of decoded.values()) {
      if (object.class.startsWith('cc.') || object.class.startsWith('sp.') || object.class === LOCALIZED) continue;
      for (const [field, value] of Object.entries(object.fields)) {
        const values = Array.isArray(value) ? value : [value];
        for (let index = 0; index < values.length; index++) {
          const targetPath = resolvePath(values[index]);
          if (!targetPath) continue;
          const list = fieldsReferencing.get(targetPath) ?? [];
          list.push(`${object.class}.${field}${Array.isArray(value) ? `[${index}]` : ''}`);
          fieldsReferencing.set(targetPath, list);
        }
      }
    }
    const resultNodes = [];
    for (const entry of ordered) {
      const { object, path: nodePath, parent } = entry;
      const fields = object.fields;
      const components = (fields._components ?? []).map(dereference).filter(Boolean);
      const transforms = fields._trs ?? [];
      const size = fields._contentSize?.values ?? [0, 0];
      const anchor = fields._anchorPoint?.values ?? [0.5, 0.5];
      const packed = fields._color?.values?.[0] ?? 0xffffffff;
      const node = {
        name: String(fields._name ?? ''), path: nodePath, pointer: object.pointer, parent,
        children: (fields._children ?? []).map(resolvePath).filter(Boolean), active: fields._active !== false && fields._active !== 0,
        position: [number(transforms[0]), number(transforms[1])], size: [number(size[0]), number(size[1])], anchor: [number(anchor[0], 0.5), number(anchor[1], 0.5)],
        scale: [number(transforms[7], 1), number(transforms[8], 1)],
        rotation: fields._eulerAngles?.values?.[2] ?? (Math.atan2(2 * (number(transforms[6], 1) * number(transforms[5]) + number(transforms[3]) * number(transforms[4])), 1 - 2 * (number(transforms[4]) ** 2 + number(transforms[5]) ** 2)) * 180 / Math.PI),
        opacity: number(fields._opacity, 255) * ((packed >>> 24) / 255), color: `#${[packed & 255, (packed >>> 8) & 255, (packed >>> 16) & 255].map(channel => channel.toString(16).padStart(2, '0')).join('')}`,
        components: components.map(component => ({ class: component.class, pointer: component.pointer, fields: component.fields, rawFields: component.rawFields })), rawFields: object.rawFields,
        source: { prefab: logicalId, nodeName: String(fields._name ?? ''), nodePath, componentPointer: object.pointer, componentClass: object.class, componentFields: fieldsReferencing.get(nodePath) ?? [] },
      };
      const label = components.find(component => (component.class === 'cc.Label' || component.class === 'cc.RichText') && component.fields._enabled !== false && component.fields._enabled !== 0);
      const localized = components.find(component => component.class === LOCALIZED && component.fields._enabled !== false && component.fields._enabled !== 0);
      if (label) {
        node.source.componentPointer = label.pointer;
        node.source.componentClass = label.class;
        const values = label.fields;
        const raw = String(values._string ?? values['_N$string'] ?? '');
        const key = localized?.fields._key;
        node.text = {
          raw, value: typeof key === 'string' ? (localization.zh_overrides[key] ?? key) : raw,
          ...(typeof key === 'string' ? { localizedKey: key, cache: localized.fields._text } : {}),
          fontSize: number(values._fontSize ?? values['_N$fontSize'], 40), lineHeight: number(values._lineHeight ?? values['_N$lineHeight'], 40),
          fontFamily: typeof values._fontFamily === 'string' ? values._fontFamily : undefined,
          maxWidth: number(values['_N$maxWidth'] ?? values._maxWidth),
          horizontalAlign: number(values['_N$horizontalAlign']), verticalAlign: number(values['_N$verticalAlign']), wrap: values._enableWrapText !== false && values._enableWrapText !== 0,
          rich: label.class === 'cc.RichText', overflow: number(values['_N$overflow']), fontUuid: (values['_N$file'] ?? values._font)?.uuid,
        };
        const extracted = extraction.filter(row => row.apk_entry === asset.importEntry && row.instance_pointer === label.pointer);
        for (const row of extracted) if (row.node_name && row.node_name !== node.name) unsupported.push({ pointer: label.pointer, reason: `Extraction node identity differs: ${row.node_name} != ${node.name}` });
        if (node.text.fontUuid) unsupported.push({ pointer: label.pointer, component: label.class, reason: `Original font ${node.text.fontUuid} preserved; RN custom/bitmap font registration not provided` });
      }
      const sprite = components.find(component => component.class === 'cc.Sprite' && component.fields._enabled !== false && component.fields._enabled !== 0);
      if (sprite) {
        const uuid = sprite.fields._spriteFrame?.uuid ?? null;
        const visual = uuid ? await trustedVisual(uuid) : { image: null, missingVisual: 'Original sprite has no serialized SpriteFrame; external image binding required' };
        const frame = assets.get(uuid)?.spriteFrame;
        node.sprite = { uuid, ...visual, type: number(sprite.fields._type), trimmed: sprite.fields._isTrimmedMode !== false && sprite.fields._isTrimmedMode !== 0, ...(frame ? { rect: frame.rect, originalSize: frame.originalSize, offset: frame.offset, capInsets: frame.capInsets } : {}) };
        if (node.sprite.type > 1) unsupported.push({ pointer: sprite.pointer, component: 'cc.Sprite', reason: `Sprite rendering mode ${node.sprite.type} (tiled/filled) retained but not implemented` });
      }
      const button = components.find(component => component.class === 'cc.Button');
      if (button) {
        const events = button.fields.clickEvents ?? button.fields['_N$clickEvents'] ?? [];
        node.button = { interactable: [button.fields['_N$interactable'], button.fields.interactable, button.fields._enabled].every(value => value !== false && value !== 0), events: events.map(event => {
          const object = dereference(event);
          const values = object?.fields ?? event;
          return { handler: String(values.handler ?? ''), target: resolvePath(values.target), component: String(values.component ?? values._componentId ?? ''), customEventData: String(values.customEventData ?? ''), raw: object?.rawFields ?? values };
        }) };
        node.source.componentPointer = button.pointer;
        node.source.componentClass = button.class;
      }
      const edit = components.find(component => component.class === 'cc.EditBox' && component.fields._enabled !== false && component.fields._enabled !== 0);
      if (edit) {
        node.source.componentPointer = edit.pointer;
        node.source.componentClass = edit.class;
        const labelString = reference => { const object = dereference(reference); return object?.fields._string ?? object?.fields['_N$string'] ?? ''; };
        node.edit = { value: String(edit.fields._string ?? edit.fields['_N$string'] ?? labelString(edit.fields['_N$textLabel'])), placeholder: String(edit.fields._placeholder ?? edit.fields['_N$placeholder'] ?? labelString(edit.fields['_N$placeholderLabel'])), maxLength: number(edit.fields.maxLength, 20), inputMode: number(edit.fields['_N$inputMode']) };
      }
      const widget = components.find(component => component.class === 'cc.Widget');
      if (widget) node.widget = { ...widget.fields, _target: resolvePath(widget.fields._target) };
      const ccLayout = components.find(component => component.class === 'cc.Layout' && component.fields._enabled !== false && component.fields._enabled !== 0);
      if (ccLayout) {
        node.layout = ccLayout.fields;
        const mode = number(ccLayout.fields['_N$layoutType'] ?? ccLayout.fields._layoutType);
        if (mode < 0 || mode > 3) unsupported.push({ pointer: ccLayout.pointer, component: ccLayout.class, reason: `Unknown original Layout type ${mode}; no guessed reflow` });
      }
      const scroll = components.find(component => component.class === 'cc.ScrollView' && component.fields._enabled !== false && component.fields._enabled !== 0);
      if (scroll) {
        const contentObject = dereference(scroll.fields['_N$content'] ?? scroll.fields.content);
        const content = resolvePath(scroll.fields['_N$content'] ?? scroll.fields.content);
        const viewport = resolvePath(contentObject?.fields._parent) ?? ordered.find(entry => entry.path === content)?.parent ?? null;
        node.scroll = {
          content, viewport,
          horizontal: scroll.fields.horizontal !== false && scroll.fields.horizontal !== 0,
          vertical: scroll.fields.vertical !== false && scroll.fields.vertical !== 0,
          inertia: scroll.fields.inertia !== false && scroll.fields.inertia !== 0,
          elastic: scroll.fields.elastic !== false && scroll.fields.elastic !== 0,
        };
        if (!content || !viewport) unsupported.push({ pointer: scroll.pointer, component: scroll.class, reason: 'Original ScrollView content/viewport reference cannot be resolved; no substituted scroll geometry' });
        if (node.scroll.horizontal && node.scroll.vertical) unsupported.push({ pointer: scroll.pointer, component: scroll.class, reason: 'Original two-axis ScrollView uses vertical RN scrolling; simultaneous two-axis gestures are not implemented' });
      }
      const mask = components.find(component => component.class === 'cc.Mask' && component.fields._enabled !== false && component.fields._enabled !== 0);
      node.clip = Boolean(mask && number(mask.fields._type) === 0 && !mask.fields._inverted && !mask.fields.inverted);
      if (mask && !node.clip) unsupported.push({ pointer: mask.pointer, component: mask.class, reason: `Mask mode ${number(mask.fields._type)} / inverted=${Boolean(mask.fields._inverted ?? mask.fields.inverted)} cannot be represented by the rectangular static clip` });
      for (const component of components) if (!SUPPORTED[component.class] && component !== mask) unsupported.push({ pointer: component.pointer, component: component.class, reason: component.class.startsWith('cc.') ? 'Engine runtime component preserved; only static geometry is rendered' : component.class === 'sp.Skeleton' ? 'Original Spine requires verified pixels/runtime; no substitute art rendered' : 'Custom game component preserved as source bindings; original JavaScript is not executed' });
      resultNodes.push(node);
    }
    const byPath = new Map(resultNodes.map(node => [node.path, node]));
    for (const node of resultNodes) {
      if (node.name !== 'RICHTEXT_CHILD') continue;
      let ancestor = node.parent ? byPath.get(node.parent) : undefined;
      while (ancestor && !ancestor.text?.rich) ancestor = ancestor.parent ? byPath.get(ancestor.parent) : undefined;
      if (ancestor) node.renderedByParentRichText = ancestor.path;
    }
    if (logicalId === 'part/PartHelpHandbookInner1') {
      const listOwner = resultNodes.find(node => node.name === 'LeftTabListView');
      const component = listOwner?.components.find(component => component.class === 'e41f6dvc/pL5IWF8mMBPtQm' && component.fields.itemName === 'PartHelpHandbookInner1Item');
      const content = listOwner?.scroll?.content ? byPath.get(listOwner.scroll.content) : undefined;
      const template = content?.children.map(child => byPath.get(child)).find(node => node?.name === 'item');
      if (component && content && template && template.size[0] === 165 && template.size[1] === 51) {
        try {
          const frame = await readFile(OPTIONS.helpListReference);
          content.observedList = {
            direction: 'vertical', spacing: 0, templateHeight: 51,
            basis: 'Original item 165x51 + original help screenshot: seven top-to-bottom rows at approximately 86 pixels / 1.6875 scale; not execution or generic restoration of ListView JS',
            sourceComponentPointer: component.pointer, sourceComponentClass: component.class,
            referenceFrame: '15-original-help-document.png', referenceSha256: sha(frame),
          };
        } catch (error) {
          unsupported.push({ pointer: component.pointer, component: component.class, reason: `Observed help ListView adapter unavailable: original screenshot evidence is missing (${error.code ?? error.message}); no guessed tab spacing` });
        }
      } else {
        unsupported.push({ pointer: component?.pointer ?? rootNode.pointer, component: component?.class, reason: 'Observed help ListView adapter does not match the original 165x51 item/content references' });
      }
    }
    const originalRootSize = rootNode.fields._contentSize?.values ?? [0, 0];
    const designSize = logicalId.startsWith('view/') ? [1136, 640] : [number(originalRootSize[0]), number(originalRootSize[1])];
    if (designSize.some(size => size <= 0)) throw new Error(`Original atomic Prefab has no usable root size: ${logicalId}`);
    const layout = { name, logicalId, designSize, root: paths.get(rootNode.pointer), nodes: resultNodes, source: { apkSha256: manifest.source.sha256, descriptorSha256: sha(descriptorBytes), serializedSha256: sha(JSON.stringify(serialized)), apkEntry: asset.importEntry, localizationSha256: sha(localizationBytes), textExtractionSha256: sha(extractionBytes) }, unsupported };
    layouts[name] = layout;
    commandNodes[name] = resultNodes.filter(node => node.button).map(node => ({ nodeName: node.name, nodePath: node.path, source: node.source, events: node.button.events, active: node.active }));
    await writeFile(path.join(output, `${logicalId.split('/').at(-1)}.json`), JSON.stringify(layout));
  }
  // Also make every SHA-verified ordinary sprite available to external bindings.
  for (const asset of manifest.assets) if (asset.sprite && !asset.rejectedVisuals) await trustedVisual(asset.uuid);
  const index = {
    origin: 'original', apkSha256: manifest.source.sha256, manifestSha256: sha(manifestBytes), designSize: [1136, 640],
    converted: Object.values(PREFABS),
    prefabs: manifest.assets.filter(asset => asset.type === 'cc.Prefab').map(asset => ({
      uuid: asset.uuid, bundle: asset.bundle, logicalIds: asset.logicalIds, apkEntry: asset.importEntry ?? null,
      descriptor: asset.descriptor ?? null, converted: asset.logicalIds.some(id => Object.values(PREFABS).includes(id)),
    })),
    commandNodes, visuals: [...images].map(([uuid, image]) => ({ uuid, ...image })),
    boundary: 'Static original nodes/text/bindings, not restoration of all original UI logic. PNG 10/rejectedRGB is excluded; missingVisual is explicit. All other original Prefab descriptors remain indexed.',
  };
  await writeFile(path.join(output, 'index.json'), JSON.stringify(index));
  console.log(JSON.stringify({ layouts: Object.fromEntries(NAMES.map(name => [name, { nodes: layouts[name].nodes.length, buttons: commandNodes[name].length, missingVisual: layouts[name].nodes.filter(node => node.sprite?.missingVisual).length, unsupported: layouts[name].unsupported.length }])), verifiedImages: images.size, indexedPrefabs: index.prefabs.length, output: relative(output) }, null, 2));
}
main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
