"""Normalize public Spine JSON exports into the independent baker's model."""
import math
from spine_public_binary import Unsupported


def color(value='ffffffff'):
    if not isinstance(value, str) or len(value) not in (6, 8):
        raise ValueError(f'invalid RGBA color {value!r}')
    return [int(value[i:i + 2], 16) / 255 for i in range(0, len(value), 2)] + ([1] if len(value) == 6 else [])


def parse(j):
    version = j.get('skeleton', {}).get('spine')
    if version not in ('3.8.55', '3.5.49'):
        raise Unsupported(f'JSON version {version!r}; supported: 3.8.55, 3.5.49')
    if j.get('path'):
        raise Unsupported('JSON path constraints')
    allowed = {'skeleton', 'bones', 'slots', 'skins', 'events', 'animations', 'ik', 'transform', 'path'}
    if set(j) - allowed:
        raise Unsupported(f'JSON skeleton sections {sorted(set(j) - allowed)}')
    s = {'version': version, 'hash': j['skeleton'].get('hash'), 'bones': [], 'slots': [], 'ik': [], 'transform': [], 'skins': [], 'animations': {}}
    bn = {b['name']: i for i, b in enumerate(j.get('bones', []))}
    if len(bn) != len(j.get('bones', [])):
        raise ValueError('duplicate bone names')
    for i, raw in enumerate(j.get('bones', [])):
        if 'inheritRotation' in raw or 'inheritScale' in raw:
            raise Unsupported(f'legacy inheritance flags on bone {raw["name"]}')
        b = {'name': raw['name'], 'parent': bn[raw['parent']] if raw.get('parent') else None, 'transform': raw.get('transform', 'normal'), 'skin': raw.get('skin', False)}
        if b['parent'] is not None and b['parent'] >= i:
            raise ValueError('bone parent must precede child')
        for k in ('x', 'y', 'rotation', 'shearX', 'shearY', 'length', 'scaleX', 'scaleY'):
            b[k] = raw.get(k, 1 if k.startswith('scale') else 0)
        s['bones'].append(b)
    sn = {v['name']: i for i, v in enumerate(j.get('slots', []))}
    if len(sn) != len(j.get('slots', [])):
        raise ValueError('duplicate slot names')
    for raw in j.get('slots', []):
        s['slots'].append({'name': raw['name'], 'bone': bn[raw['bone']], 'color': color(raw.get('color', 'ffffffff')), 'dark': color(raw['dark'])[:3] if 'dark' in raw else None, 'attachment': raw.get('attachment'), 'blend': raw.get('blend', 'normal')})
    for raw in j.get('ik', []):
        c = {'name': raw['name'], 'order': raw.get('order', 0), 'skin': raw.get('skin', False), 'bones': [bn[n] for n in raw['bones']], 'target': bn[raw['target']], 'mix': raw.get('mix', 1), 'softness': raw.get('softness', 0), 'bend': 1 if raw.get('bendPositive', True) else -1}
        c.update({k: raw.get(k, False) for k in ('compress', 'stretch', 'uniform')})
        s['ik'].append(c)
    for raw in j.get('transform', []):
        c = {'name': raw['name'], 'order': raw.get('order', 0), 'skin': raw.get('skin', False), 'bones': [bn[n] for n in raw.get('bones', [raw.get('bone')])], 'target': bn[raw['target']], 'local': raw.get('local', False), 'relative': raw.get('relative', False)}
        for k in ('rotation', 'x', 'y', 'scaleX', 'scaleY', 'shearY', 'rotateMix', 'translateMix', 'scaleMix', 'shearMix'):
            c[k] = raw.get(k, 1 if k.endswith('Mix') else 0)
        s['transform'].append(c)
    skins = j.get('skins', [])
    if isinstance(skins, dict):
        skins = [{'name': name, 'attachments': values} for name, values in skins.items()]
    for raw in skins:
        if any(raw.get(k) for k in ('bones', 'ik', 'transform', 'path')):
            raise Unsupported(f'skin-specific bones/constraints in {raw["name"]}')
        skin = {'name': raw['name'], 'attachments': {}}
        for slot_name, entries in raw.get('attachments', {}).items():
            out = {}
            for key, value in entries.items():
                a = dict(value)
                kind = a.get('type', 'region')
                if kind not in ('region', 'mesh', 'linkedmesh', 'boundingbox', 'point'):
                    raise Unsupported(f'JSON attachment {kind!r}')
                a['type'] = {'region': 0, 'mesh': 2, 'linkedmesh': 3, 'boundingbox': 1, 'point': 5}[kind]
                a['name'] = a.get('name', key)
                a['path'] = a.get('path', a['name'])
                a['color'] = color(a.get('color', 'ffffffff'))
                if kind == 'region':
                    for k in ('x', 'y', 'rotation', 'scaleX', 'scaleY'):
                        a[k] = a.get(k, 1 if k.startswith('scale') else 0)
                    if not a.get('width') or not a.get('height'):
                        raise ValueError('region missing width/height')
                if kind == 'mesh':
                    values = a['vertices']
                    n = len(a['uvs']) // 2
                    if len(a['uvs']) % 2:
                        raise ValueError('odd mesh UV count')
                    a['weighted'] = len(values) != n * 2
                    if a['weighted']:
                        out_vertices, cursor = [], 0
                        for _ in range(n):
                            count = values[cursor]
                            cursor += 1
                            if not isinstance(count, int) or count < 1:
                                raise ValueError('invalid mesh influence count')
                            influences = []
                            for _ in range(count):
                                v = values[cursor:cursor + 4]
                                cursor += 4
                                if len(v) != 4 or not isinstance(v[0], int) or v[0] < 0 or v[0] >= len(bn):
                                    raise ValueError('invalid weighted mesh vertex')
                                influences.append(v)
                            if abs(sum(v[3] for v in influences) - 1) > 0.002:
                                raise ValueError('mesh weights do not sum to one')
                            out_vertices.append(influences)
                        if cursor != len(values):
                            raise ValueError('unconsumed weighted mesh values')
                        a['vertices'] = out_vertices
                    if len(a['triangles']) % 3 or any(not isinstance(i, int) or i < 0 or i >= n for i in a['triangles']):
                        raise ValueError('invalid mesh triangles')
                if kind == 'linkedmesh':
                    a['skin'], a['deform'] = a.get('skin', 'default'), a.get('deform', True)
                out[key] = a
            skin['attachments'][sn[slot_name]] = out
        s['skins'].append(skin)
    ikn = {c['name']: i for i, c in enumerate(s['ik'])}
    tcn = {c['name']: i for i, c in enumerate(s['transform'])}
    for name, raw in j.get('animations', {}).items():
        extra = set(raw) - {'bones', 'slots', 'ik', 'transform', 'deform', 'ffd', 'drawOrder', 'draworder', 'events'}
        if extra:
            raise Unsupported(f'JSON animation sections {sorted(extra)} in {name}')
        timelines = []
        def add(kind, index, source, values, **extra):
            frames = []
            for v in source:
                time = v.get('time', 0)
                if not math.isfinite(time) or time < 0 or frames and time <= frames[-1]['time'] and kind != 'events':
                    raise ValueError(f'nonincreasing keyframes in {name}/{kind}')
                curve = v.get('curve', 'linear')
                if isinstance(curve, (int, float)):
                    curve = [curve, v.get('c2', 0), v.get('c3', 1), v.get('c4', 1)]
                frames.append({'time': time, 'values': values(v), 'curve': curve})
            timelines.append({'kind': kind, 'index': index, 'frames': frames, **extra})
        for bone, entries in raw.get('bones', {}).items():
            for kind, frames in entries.items():
                if kind not in ('rotate', 'translate', 'scale', 'shear'):
                    raise Unsupported(f'JSON bone timeline {kind}')
                add(kind, bn[bone], frames, lambda v: [v.get('angle', 0)] if kind == 'rotate' else [v.get('x', 1 if kind == 'scale' else 0), v.get('y', 1 if kind == 'scale' else 0)])
        for slot, entries in raw.get('slots', {}).items():
            for kind, frames in entries.items():
                if kind not in ('attachment', 'color', 'twoColor'):
                    raise Unsupported(f'JSON slot timeline {kind}')
                add(kind, sn[slot], frames, lambda v: [v.get('name')] if kind == 'attachment' else color(v.get('color', 'ffffffff')) if kind == 'color' else color(v['light']) + color(v['dark'])[:3])
        for constraint, frames in raw.get('ik', {}).items():
            add('ik', ikn[constraint], frames, lambda v: [v.get('mix', 1), v.get('softness', 0), 1 if v.get('bendPositive', True) else -1, v.get('compress', False), v.get('stretch', False)])
        for constraint, frames in raw.get('transform', {}).items():
            add('transform', tcn[constraint], frames, lambda v: [v.get(k, 1) for k in ('rotateMix', 'translateMix', 'scaleMix', 'shearMix')])
        for skin_name, slots in raw.get('deform', raw.get('ffd', {})).items():
            skin = next(skin for skin in s['skins'] if skin['name'] == skin_name)
            for slot, entries in slots.items():
                for key, frames in entries.items():
                    a = skin['attachments'][sn[slot]][key]
                    if a['type'] != 2:
                        raise Unsupported('JSON linked/nonmesh deform')
                    length = sum(len(v) for v in a['vertices']) * 2 if a['weighted'] else len(a['vertices'])
                    def deform(v):
                        values, offset = v.get('vertices', []), v.get('offset', 0)
                        if offset < 0 or offset + len(values) > length:
                            raise ValueError('deform outside mesh vertices')
                        return [0] * offset + values + [0] * (length - offset - len(values))
                    add('deform', sn[slot], frames, deform, skin=skin_name, attachment=key)
        add('drawOrder', 0, raw.get('drawOrder', raw.get('draworder', [])), lambda v: [[sn[o['slot']], o['offset']] for o in v.get('offsets', [])])
        add('events', 0, raw.get('events', []), lambda v: [{**j.get('events', {}).get(v['name'], {}), **v}])
        s['animations'][name] = {'timelines': timelines, 'duration': max((f['time'] for t in timelines for f in t['frames']), default=0)}
    return s
