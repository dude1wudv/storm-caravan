"""Independent decoder from public Spine 3.8 format facts, not a Spine runtime.
Format reference: https://esotericsoftware.com/spine-binary-format
Only 3.8.55 is accepted: other exports need separately verified layouts.
All reads are bounded; successful parsing must consume the complete input.
"""
import math
import struct


class Unsupported(ValueError):
    pass


class Reader:
    def __init__(self, data):
        self.data, self.pos, self.strings = data, 0, []

    def fail(self, message):
        raise ValueError(f'{message} at binary byte {self.pos}/{len(self.data)}')

    def take(self, count):
        if count < 0 or self.pos + count > len(self.data):
            self.fail(f'truncated read of {count} bytes')
        result = self.data[self.pos:self.pos + count]
        self.pos += count
        return result

    def byte(self):
        return self.take(1)[0]

    def boolean(self):
        value = self.byte()
        if value not in (0, 1):
            self.fail(f'invalid boolean {value}')
        return bool(value)

    def var(self, positive=True):
        value = 0
        for shift in range(0, 35, 7):
            b = self.byte()
            if shift == 28 and b & 240:
                self.fail('varint overflow')
            value |= (b & 127) << shift
            if not b & 128:
                return value if positive else (value >> 1) ^ -(value & 1)
        self.fail('unterminated varint')

    def count(self):
        n = self.var()
        if n > 1000000 or n > len(self.data) - self.pos:
            self.fail(f'impossible item count {n}')
        return n

    def index(self, size):
        n = self.var()
        if n >= size:
            self.fail(f'index {n} outside {size} entries')
        return n

    def float(self):
        n = struct.unpack('>f', self.take(4))[0]
        if not math.isfinite(n):
            self.fail('nonfinite float')
        return n

    def floats(self, n):
        return [self.float() for _ in range(n)]

    def string(self):
        n = self.var()
        return self.take(n - 1).decode('utf8', errors='strict') if n > 1 else ('' if n else None)

    def ref(self):
        n = self.var()
        if n > len(self.strings):
            self.fail(f'shared string {n} outside table')
        return self.strings[n - 1] if n else None

    def color(self):
        return [v / 255 for v in self.take(4)]

    def curve(self):
        kind = self.byte()
        if kind == 0:
            return 'linear'
        if kind == 1:
            return 'stepped'
        if kind == 2:
            return self.floats(4)
        self.fail(f'unknown curve {kind}')

    def frames(self, n, values, curves=True):
        result = []
        for i in range(n):
            time = self.float()
            if time < 0 or result and time <= result[-1]['time']:
                self.fail('nonincreasing keyframe time')
            f = {'time': time, 'values': values()}
            if curves and i < n - 1:
                f['curve'] = self.curve()
            result.append(f)
        return result


def vertices(r, count, bone_count):
    # The public page's true/false prose is transposed: the byte is the
    # weighted flag, true introduces varint influence counts and bone indices.
    if not r.boolean():
        return {'weighted': False, 'vertices': r.floats(count * 2)}
    result = []
    for _ in range(count):
        n = r.count()
        if not n:
            r.fail('weighted vertex has no influences')
        influences = []
        for _ in range(n):
            influences.append([r.index(bone_count), *r.floats(3)])
        if abs(sum(v[3] for v in influences) - 1) > 0.002:
            r.fail('vertex weights do not sum to one')
        result.append(influences)
    return {'weighted': True, 'vertices': result}


def attachment(r, placeholder, nonessential, bone_count, slot_count):
    name, kind = r.ref() or placeholder, r.byte()
    a = {'name': name, 'type': kind}
    if kind == 0:
        a['path'] = r.ref() or name
        for key in ('rotation', 'x', 'y', 'scaleX', 'scaleY', 'width', 'height'):
            a[key] = r.float()
        a['color'] = r.color()
    elif kind == 2:
        a['path'], a['color'] = r.ref() or name, r.color()
        count = r.count()
        a['uvs'] = r.floats(count * 2)
        a['triangles'] = [struct.unpack('>H', r.take(2))[0] for _ in range(r.count())]
        if len(a['triangles']) % 3 or any(i >= count for i in a['triangles']):
            r.fail('invalid mesh triangles')
        a.update(vertices(r, count, bone_count))
        a['hull'] = r.var()
        if nonessential:
            a['edges'] = [struct.unpack('>H', r.take(2))[0] for _ in range(r.count())]
            a['width'], a['height'] = r.float(), r.float()
    elif kind == 3:
        a['path'], a['color'] = r.ref() or name, r.color()
        a['skin'], a['parent'], a['deform'] = r.ref() or 'default', r.ref(), r.boolean()
        if nonessential:
            a['width'], a['height'] = r.float(), r.float()
    elif kind == 1:
        a.update(vertices(r, r.count(), bone_count))
        if nonessential:
            r.color()
    elif kind == 5:
        a['rotation'], a['x'], a['y'] = r.floats(3)
        if nonessential:
            r.color()
    elif kind in (4, 6):
        raise Unsupported(f'attachment type {kind} (path/clipping) at byte {r.pos}')
    else:
        raise Unsupported(f'unknown attachment type {kind} at byte {r.pos}')
    return a


def parse(data):
    r = Reader(data)
    s = {'hash': r.string(), 'version': r.string()}
    if s['version'] != '3.8.55':
        raise Unsupported(f'binary version {s["version"]!r}; supported: 3.8.55')
    s['bounds'] = r.floats(4)
    ne = r.boolean()
    if ne:
        s['fps'], s['images'], s['audio'] = r.float(), r.string(), r.string()
    r.strings = [r.string() for _ in range(r.count())]
    s['bones'] = []
    for i in range(r.count()):
        b = {'name': r.string(), 'parent': r.index(i) if i else None}
        for key in ('rotation', 'x', 'y', 'scaleX', 'scaleY', 'shearX', 'shearY', 'length'):
            b[key] = r.float()
        b['transform'], b['skin'] = r.var(), r.boolean()
        if ne:
            r.color()
        s['bones'].append(b)
    bc = len(s['bones'])
    s['slots'] = []
    for _ in range(r.count()):
        slot = {'name': r.string(), 'bone': r.index(bc), 'color': r.color()}
        dark = r.take(4)
        slot['dark'] = None if dark == b'\xff\xff\xff\xff' else [v / 255 for v in dark[1:]]
        slot['attachment'], slot['blend'] = r.ref(), r.var()
        s['slots'].append(slot)
    sc = len(s['slots'])
    s['ik'] = []
    for _ in range(r.count()):
        c = {'name': r.string(), 'order': r.var(), 'skin': r.boolean()}
        c['bones'] = [r.index(bc) for _ in range(r.count())]
        c['target'], c['mix'], c['softness'] = r.index(bc), r.float(), r.float()
        bend = r.byte()
        if bend not in (1, 255):
            r.fail('invalid IK bend direction')
        c['bend'] = 1 if bend == 1 else -1
        c['compress'], c['stretch'], c['uniform'] = r.boolean(), r.boolean(), r.boolean()
        s['ik'].append(c)
    s['transform'] = []
    for _ in range(r.count()):
        c = {'name': r.string(), 'order': r.var(), 'skin': r.boolean()}
        c['bones'] = [r.index(bc) for _ in range(r.count())]
        c['target'], c['local'], c['relative'] = r.index(bc), r.boolean(), r.boolean()
        for key in ('rotation', 'x', 'y', 'scaleX', 'scaleY', 'shearY', 'rotateMix', 'translateMix', 'scaleMix', 'shearMix'):
            c[key] = r.float()
        s['transform'].append(c)
    if r.count():
        raise Unsupported(f'path constraints at byte {r.pos}')
    s['skins'] = []

    def skin(name, slots):
        out = {'name': name, 'attachments': {}}
        for _ in range(slots):
            slot_index = r.index(sc)
            entries = {}
            for _ in range(r.count()):
                key = r.ref()
                if not key or key in entries:
                    r.fail('empty/duplicate attachment key')
                entries[key] = attachment(r, key, ne, bc, sc)
            out['attachments'][slot_index] = entries
        return out

    # Empty default skin is not inserted into the binary skin-index table.
    default_count = r.count()
    if default_count:
        s['skins'].append(skin('default', default_count))
    for _ in range(r.count()):
        name = r.ref()
        for size in (bc, len(s['ik']), len(s['transform']), 0):
            n = r.count()
            if n:
                raise Unsupported(f'skin-specific bones/constraints in {name!r} at byte {r.pos}')
        s['skins'].append(skin(name, r.count()))
    events = []
    for _ in range(r.count()):
        e = {'name': r.ref(), 'int': r.var(False), 'float': r.float(), 'string': r.string(), 'audio': r.string()}
        if e['audio']:
            e['volume'], e['balance'] = r.float(), r.float()
        events.append(e)
    s['events'], s['animations'] = events, {}
    for _ in range(r.count()):
        name = r.string()
        if not name or name in s['animations']:
            r.fail('empty/duplicate animation name')
        timelines = []

        def add(kind, index, frames, **extra):
            timelines.append({'kind': kind, 'index': index, 'frames': frames, **extra})

        for _ in range(r.count()):
            si = r.index(sc)
            for _ in range(r.count()):
                kind, n = r.byte(), r.count()
                if kind == 0:
                    add('attachment', si, r.frames(n, lambda: [r.ref()], False))
                elif kind == 1:
                    add('color', si, r.frames(n, r.color))
                elif kind == 2:
                    add('twoColor', si, r.frames(n, lambda: r.color() + [v / 255 for v in r.take(4)[1:]]))
                else:
                    raise Unsupported(f'slot timeline {kind} at byte {r.pos}')
        for _ in range(r.count()):
            bi = r.index(bc)
            for _ in range(r.count()):
                kind, n = r.byte(), r.count()
                if kind > 3:
                    raise Unsupported(f'bone timeline {kind} at byte {r.pos}')
                add(('rotate', 'translate', 'scale', 'shear')[kind], bi, r.frames(n, lambda: r.floats(1 if kind == 0 else 2)))
        for _ in range(r.count()):
            ci, n = r.index(len(s['ik'])), r.count()
            def ik_values():
                mix, softness, bend = r.float(), r.float(), r.byte()
                if bend not in (1, 255):
                    r.fail('invalid animated IK bend')
                return [mix, softness, 1 if bend == 1 else -1, r.boolean(), r.boolean()]
            add('ik', ci, r.frames(n, ik_values))
        for _ in range(r.count()):
            ci, n = r.index(len(s['transform'])), r.count()
            add('transform', ci, r.frames(n, lambda: r.floats(4)))
        if r.count():
            raise Unsupported(f'path timelines at byte {r.pos}')
        for _ in range(r.count()):
            skin_index = r.index(len(s['skins']))
            for _ in range(r.count()):
                si = r.index(sc)
                for _ in range(r.count()):
                    key, n = r.ref(), r.count()
                    a = s['skins'][skin_index]['attachments'].get(si, {}).get(key)
                    if not a or a['type'] != 2:
                        raise Unsupported(f'deform for absent/nonmesh/linked mesh {key!r} at byte {r.pos}')
                    length = sum(len(v) for v in a['vertices']) * 2 if a['weighted'] else len(a['vertices'])
                    def deform_values():
                        values = [0.0] * length
                        count = r.var()
                        if count:
                            start = r.var()
                            if start + count > length:
                                r.fail('deform span outside vertices')
                            values[start:start + count] = r.floats(count)
                        return values
                    add('deform', si, r.frames(n, deform_values), skin=s['skins'][skin_index]['name'], attachment=key)
        n = r.count()
        order_frames = []
        for _ in range(n):
            time, count = r.float(), r.count()
            changes = []
            for _ in range(count):
                si, offset = r.index(sc), r.var()
                if offset >= 2 ** 31:
                    offset -= 2 ** 32
                changes.append([si, offset])
            order_frames.append({'time': time, 'values': changes})
        if n:
            add('drawOrder', 0, order_frames)
        n = r.count()
        event_frames = []
        for _ in range(n):
            time, ei = r.float(), r.index(len(events))
            value = {'event': events[ei]['name'], 'int': r.var(False), 'float': r.float()}
            value['string'] = r.string() if r.boolean() else events[ei]['string']
            if events[ei]['audio']:
                value['volume'], value['balance'] = r.float(), r.float()
            event_frames.append({'time': time, 'values': [value]})
        if n:
            add('events', 0, event_frames)
        s['animations'][name] = {'timelines': timelines, 'duration': max((f['time'] for t in timelines for f in t['frames']), default=0)}
    if r.pos != len(data):
        r.fail(f'unconsumed trailing bytes: {len(data) - r.pos}')
    s['binaryBytesConsumed'] = r.pos
    return s
