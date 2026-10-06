"""Bake public original skeletons to transparent PNG frames without Spine runtime.
Dependency: Pillow (verified with 12.3.0). Inputs are resolved exclusively from
manifest paths/UUID texture references; business role IDs are NOT model IDs.
"""
import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
TOOLS = Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, TOOLS / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def sha(data):
    return hashlib.sha256(data).hexdigest()


def source_bytes(record):
    if not isinstance(record, dict) or not isinstance(record.get('path'), str):
        raise ValueError('manifest source requires an explicit path')
    relative = Path(record['path'])
    if relative.is_absolute() or '..' in relative.parts or ':' in record['path']:
        raise ValueError('unsafe manifest source path')
    path = (ROOT / relative).resolve()
    if not path.is_relative_to((ROOT / 'assets/original').resolve()):
        raise ValueError('source outside public assets/original directory')
    data = path.read_bytes()
    if record.get('sha256') and sha(data) != record['sha256']:
        raise ValueError(f'source SHA256 mismatch: {record["path"]}')
    return data


def descriptor_objects(raw):
    if not isinstance(raw, list) or not raw or raw[0] != 1:
        return raw if isinstance(raw, list) else [raw]
    classes, masks, instances = raw[3:6]
    objects = []
    for instance in instances:
        if not isinstance(instance, list) or not instance or not isinstance(instance[0], int):
            continue
        mask = masks[instance[0]]
        cls = classes[mask[0]]
        if not isinstance(cls, list) or len(cls) < 2 or not isinstance(cls[1], list):
            continue
        result = {'__type__': cls[0]}
        for i in range(1, len(instance)):
            field = cls[1][mask[i]]
            if not isinstance(field, str):
                raise ValueError('unsupported public descriptor field mask')
            result[field] = instance[i]
        objects.append(result)
    return objects


def skeleton_source(asset, binary, json_reader):
    native = [v for v in asset.get('native', []) if v.get('extension') == 'bin']
    if len(native) > 1:
        raise ValueError('ambiguous binary sources in manifest')
    if native:
        data = source_bytes(native[0])
        return binary.parse(data), {**native[0], 'format': 'binary', 'sha256': sha(data)}
    explicit = asset.get('spine', {}).get('skeletonJson')
    if isinstance(explicit, dict) and explicit.get('path'):
        data = source_bytes(explicit)
        return json_reader.parse(json.loads(data)), {**explicit, 'format': 'json', 'sha256': sha(data)}
    json_native = [v for v in asset.get('native', []) if v.get('extension') == 'json']
    if len(json_native) == 1:
        data = source_bytes(json_native[0])
        return json_reader.parse(json.loads(data)), {**json_native[0], 'format': 'json', 'sha256': sha(data)}
    descriptor = asset.get('descriptor')
    data = source_bytes(descriptor)
    objects = descriptor_objects(json.loads(data).get('serialized'))
    candidates = [v['_skeletonJson'] for v in objects if isinstance(v, dict) and v.get('__type__') == 'sp.SkeletonData' and v.get('_skeletonJson')]
    if len(candidates) != 1:
        raise ValueError('manifest has no unambiguous binary/JSON skeleton source')
    j = json.loads(candidates[0]) if isinstance(candidates[0], str) else candidates[0]
    return json_reader.parse(j), {**descriptor, 'format': 'embedded-json', 'sha256': sha(data), 'jsonSha256': sha(json.dumps(j, sort_keys=True, ensure_ascii=False).encode())}


def atlas_pages(asset):
    spine = asset['spine']
    text = spine.get('atlasText')
    if not text:
        native = [v for v in asset.get('native', []) if v.get('extension') == 'atlas']
        if len(native) != 1:
            raise ValueError('manifest has no unambiguous atlas text/path')
        text = source_bytes(native[0]).decode('utf8')
    pages, current, region = [], None, None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            current, region = None, None
        elif ':' in line:
            key, value = line.split(':', 1)
            if current is None:
                raise ValueError('atlas field without a page')
            (region if region else current)['attributes'][key.strip()] = value.strip()
        elif current is None:
            current = {'name': line, 'attributes': {}, 'regions': []}
            pages.append(current)
        else:
            region = {'name': line, 'attributes': {}}
            current['regions'].append(region)
    if not pages or any(not p['regions'] for p in pages):
        raise ValueError('empty atlas pages/regions')
    return pages, sha(text.encode('utf8'))


def texture_sources(asset, assets, pages, image_module):
    textures, sources = {}, []
    for page in pages:
        refs = [t for t in asset['spine'].get('textures', []) if t.get('page') == page['name']]
        if len(refs) != 1 or not refs[0].get('uuid'):
            raise ValueError(f'atlas page {page["name"]!r} has no unambiguous manifest texture UUID')
        candidates = [r for r in assets if r.get('uuid') == refs[0]['uuid'] and r.get('texture', {}).get('path')]
        paths = {r['texture']['path']: r['texture'] for r in candidates}
        if len(paths) != 1:
            raise ValueError(f'texture UUID {refs[0]["uuid"]} is not unambiguously converted to PNG; finish original import first')
        source = next(iter(paths.values()))
        data = source_bytes(source)
        import io
        image = image_module.open(io.BytesIO(data))
        image.load()
        size = page['attributes'].get('size')
        if size:
            expected = tuple(int(v.strip()) for v in size.split(','))
            if expected != (0, 0) and image.size != expected:
                raise ValueError(f'atlas page size {expected} disagrees with texture {image.size}')
        textures[page['name']] = image
        sources.append({**source, 'page': page['name'], 'sha256': sha(data)})
    return textures, sources


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf8')


def bake_animation(s, name, skin, regions, renderer, fps, scale, destination, output):
    animation = s['animations'][name]
    duration = animation['duration']
    if not math.isfinite(duration) or duration < 0 or duration > 600:
        raise ValueError(f'unsafe animation duration {duration}')
    count = max(1, math.ceil(duration * fps - 1e-8))
    times = [i / fps for i in range(count)]
    # Include the exact endpoint for bounds/feature validation, not the looped
    # frame sequence. One-shot playback has a separate exact terminal PNG.
    points = []
    for time in [*times, duration]:
        for item in renderer.geometry(s, animation, time, skin, regions):
            points.extend(item['vertices'])
    if not points:
        raise ValueError('animation has no visible region/mesh geometry')
    if not all(math.isfinite(v) for point in points for v in point):
        raise ValueError('nonfinite posed geometry')
    bounds = [math.floor(min(p[0] for p in points)) - 2, math.floor(min(p[1] for p in points)) - 2, math.ceil(max(p[0] for p in points)) + 2, math.ceil(max(p[1] for p in points)) + 2]
    # Never overwrite a changed bake. Every invocation has a content-addressed
    # directory; existing frames must match before they can be reused.
    destination.parent.mkdir(parents=True, exist_ok=True)
    frames = []
    with tempfile.TemporaryDirectory(prefix='.bake-', dir=destination.parent) as temporary:
        stage = Path(temporary)
        for i, time in enumerate([*times, duration]):
            items = renderer.geometry(s, animation, time, skin, regions)
            image = renderer.rasterize(items, bounds, scale)
            if image.getbbox() is None:
                # Transparent frames are legitimate during a vanish/death.
                visible_pixels = False
            else:
                visible_pixels = True
            filename = f'{i:04d}.png' if i < count else 'terminal.png'
            path = stage / filename
            image.save(path, format='PNG')
            digest = sha(path.read_bytes())
            frames.append({'path': (destination / filename).relative_to(output).as_posix(), 'sha256': digest, 'time': time, 'width': image.width, 'height': image.height, 'visiblePixels': visible_pixels})
        if not any(f['visiblePixels'] for f in frames):
            raise ValueError('all rendered frames are fully transparent')
        if destination.exists():
            for frame in frames:
                existing = destination / Path(frame['path']).name
                if not existing.is_file() or sha(existing.read_bytes()) != frame['sha256']:
                    raise ValueError('existing bake differs; refusing to overwrite user changes')
        else:
            # Rename inside the output filesystem: a failed bake never publishes
            # an incomplete animation to the generated require index.
            destination.mkdir()
            for file in stage.iterdir():
                file.rename(destination / file.name)
    return {'name': name, 'origin': 'original', 'motionOrigin': 'original-timeline', 'duration': duration, 'fps': fps, 'sampleTimes': times, 'bakedFrameCount': count, 'frames': frames[:-1], 'terminalFrame': frames[-1], 'bounds': bounds, 'width': frames[0]['width'], 'height': frames[0]['height'], 'pivot': {'x': -bounds[0] * scale, 'y': bounds[3] * scale}, 'scale': scale, 'events': [t['frames'] for t in animation['timelines'] if t['kind'] == 'events']}




def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', default='assets/manifests/original-assets.json')
    parser.add_argument('--ids', required=True, help='Comma-separated exact Spine logical IDs; no fuzzy/business ID matching. Use all to explicitly request all indexed skeletons.')
    parser.add_argument('--fps', type=float, default=12)
    parser.add_argument('--output', default='assets/original-animations')
    parser.add_argument('--skin', help='Exact original skin name. Without this: default, or the single original skin; ambiguous choices fail.')
    parser.add_argument('--animations', help='Comma-separated exact original animation names; otherwise all original names.')
    parser.add_argument('--scale', type=float, default=1)
    options = parser.parse_args()
    if not math.isfinite(options.fps) or not 1 <= options.fps <= 60 or not math.isfinite(options.scale) or not 0.05 <= options.scale <= 4:
        parser.error('fps must be 1..60 and scale must be 0.05..4')
    manifest = Path(options.manifest)
    manifest = manifest if manifest.is_absolute() else ROOT / manifest
    manifest_bytes = manifest.read_bytes()
    m = json.loads(manifest_bytes)
    assets = m['assets']
    output = Path(options.output)
    output = (output if output.is_absolute() else ROOT / output).resolve()
    if not output.is_relative_to((ROOT / 'assets/original-animations').resolve()):
        parser.error('output must stay within assets/original-animations')
    output.mkdir(parents=True, exist_ok=True)
    binary = load_module('spine_public_binary', 'spine-public-binary.py')
    json_reader = load_module('spine_public_json', 'spine-public-json.py')
    renderer = load_module('spine_public_render', 'spine-public-render.py')
    ids = sorted({i for a in assets if a.get('spine') for i in a.get('logicalIds', [])}) if options.ids == 'all' else list(dict.fromkeys(options.ids.split(',')))
    report = {'schemaVersion': 1, 'origin': 'added', 'method': 'independent-public-format-reader-and-2d-rasterizer', 'formatReferences': ['https://esotericsoftware.com/spine-binary-format', 'https://esotericsoftware.com/spine-json-format', 'https://esotericsoftware.com/spine-atlas-format'], 'externalSpineRuntimeUsed': False, 'source': {'manifestSha256': sha(manifest_bytes), 'sourceApkSha256': m.get('source', {}).get('sha256')}, 'fps': options.fps, 'resources': [], 'failures': [], 'addedMotion': [], 'businessMapping': {'policy': 'exact logical IDs only; no role ID to model ID equivalence assumed', 'knownMissingBinding': ['Role11002/武装拖拉机: source Role has no img binding', 'talk:211/约书亚: talk ID does not establish a skeleton logical ID']}}
    report['slotCompositing'] = {
        'normal': 'straight RGBA source-over',
        'additive': 'SRC_ALPHA/ONE RGB; premultiplied plus-lighter coverage, clamped and unpremultiplied for transparent PNG',
        'multiplyAndScreen': 'separable RGB blend with Porter-Duff source-over coverage',
        'limitation': 'Slot blending is baked against the entity layers, not a future map backdrop. One flattened RGBA frame cannot reproduce backdrop-dependent blend modes on every possible RN background.',
    }
    def failure(requested, phase, error, **extra):
        message = str(error).replace(str(ROOT), '<project>')
        report['failures'].append({'requestedId': requested, 'phase': phase, 'unsupported': isinstance(error, binary.Unsupported), 'message': message, **extra})
    for requested in ids:
        candidates = [a for a in assets if requested in a.get('logicalIds', []) and a.get('type') == 'sp.SkeletonData']
        # Duplicate manifest records are not silently picked by bundle order.
        if len(candidates) != 1:
            matches = [{'logicalIds': a.get('logicalIds'), 'type': a.get('type'), 'bundle': a.get('bundle'), 'uuid': a.get('uuid')} for a in assets if requested in a.get('logicalIds', [])]
            failure(requested, 'logical-id-resolution', ValueError('missing exact Spine logical ID' if not candidates else 'ambiguous exact Spine logical ID'), exactManifestMatches=matches)
            continue
        asset = candidates[0]
        resource = {'requestedId': requested, 'logicalIds': asset['logicalIds'], 'uuid': asset['uuid'], 'bundle': asset['bundle'], 'version': asset.get('spine', {}).get('version'), 'animations': [], 'bakedFrameCount': 0}
        report['resources'].append(resource)
        try:
            s, source = skeleton_source(asset, binary, json_reader)
            if resource['version'] and resource['version'] != s['version']:
                raise ValueError('manifest version disagrees with source skeleton')
            resource.update({'source': source, 'version': s['version'], 'skeletonHash': s['hash'], 'animationNames': list(s['animations']), 'animationDurations': {n: a['duration'] for n, a in s['animations'].items()}, 'binaryBytesConsumed': s.get('binaryBytesConsumed'), 'boneCount': len(s['bones']), 'slotCount': len(s['slots']), 'constraintCounts': {'ik': len(s['ik']), 'transform': len(s['transform'])}, 'skinNames': [v['name'] for v in s['skins']]})
            names = resource['skinNames']
            skin = options.skin or ('default' if 'default' in names else names[0] if len(names) == 1 else None)
            if not skin or skin not in names:
                raise ValueError(f'choose exact --skin from {names}; no guessed skin')
            resource['skin'] = skin
            pages, atlas_sha = atlas_pages(asset)
            textures, texture_records = texture_sources(asset, assets, pages, renderer.Image)
            resource['atlasSha256'], resource['textureSources'] = atlas_sha, texture_records
            regions = renderer.atlas_regions(pages, textures)
            config = {'source': source['sha256'], 'atlas': atlas_sha, 'textures': [r['sha256'] for r in texture_records], 'fps': options.fps, 'scale': options.scale, 'skin': skin, 'implementationSha256': sha(b''.join((TOOLS / f).read_bytes() for f in ('original-animation.py', 'spine-public-binary.py', 'spine-public-json.py', 'spine-public-render.py')))}
            bake_id = asset['uuid'] + '-' + sha(json.dumps(config, sort_keys=True).encode())[:16]
            animation_names = list(dict.fromkeys(options.animations.split(','))) if options.animations else list(s['animations'])
            if not animation_names:
                raise ValueError('source skeleton has no animations; no new motion created')
            for name in animation_names:
                try:
                    if name not in s['animations']:
                        raise ValueError(f'exact original animation name missing: {name!r}')
                    slug = re.sub(r'[^a-zA-Z0-9_-]', '_', name)[:48] or 'animation'
                    destination = output / bake_id / (slug + '-' + sha(name.encode())[:8])
                    baked = bake_animation(s, name, skin, regions, renderer, options.fps, options.scale, destination, output)
                    resource['animations'].append(baked)
                    resource['bakedFrameCount'] += baked['bakedFrameCount']
                except (ValueError, KeyError, IndexError, OSError) as error:
                    failure(requested, 'animation-bake', error, animation=name, skin=skin)
        except (ValueError, KeyError, IndexError, OSError, TypeError) as error:
            failure(requested, 'source-load', error)
    unsupported = Counter(f['message'] for f in report['failures'] if f['unsupported'])
    report['stats'] = {'requestedResources': len(ids), 'loadedResources': sum('source' in r for r in report['resources']), 'bakedResources': sum(bool(r['animations']) for r in report['resources']), 'bakedAnimations': sum(len(r['animations']) for r in report['resources']), 'bakedFrameCount': sum(r['bakedFrameCount'] for r in report['resources']), 'failureCount': len(report['failures']), 'unsupportedCount': sum(unsupported.values()), 'unsupportedByReason': dict(unsupported), 'allIndexedSkeletonCount': sum(bool(a.get('spine')) for a in assets)}
    save_json(output / 'report.json', report)
    print(json.dumps(report['stats'], ensure_ascii=False))
    print(f'Report: {output / "report.json"}')
    return 1 if report['failures'] else 0


if __name__ == '__main__':
    sys.exit(main())
