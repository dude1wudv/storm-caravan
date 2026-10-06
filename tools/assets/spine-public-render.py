"""Independent 2D pose sampler and Pillow rasterizer; no external animation runtime.
References: public Spine JSON/binary/atlas format descriptions. Unsupported
transform modes, IK variants, path/clipping, skin activation and blend modes
raise rather than silently substitute a setup pose or an atlas page.
"""
import copy
import math
from PIL import Image, ImageDraw
from spine_public_binary import Unsupported


RAD = math.pi / 180


def angle(a):
    return (a + 180) % 360 - 180


def progress(curve, x):
    if curve == 'linear':
        return x
    if curve == 'stepped':
        return 0
    if not isinstance(curve, list) or len(curve) != 4 or not all(math.isfinite(v) for v in curve):
        raise Unsupported(f'invalid/unsupported curve {curve!r}')
    ax, ay, bx, by = curve
    if not 0 <= ax <= 1 or not 0 <= bx <= 1:
        raise Unsupported('nonmonotonic Bezier time control points')
    def cubic(a, b, t):
        return 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3
    lo, hi = 0.0, 1.0
    for _ in range(28):
        t = (lo + hi) / 2
        if cubic(ax, bx, t) < x:
            lo = t
        else:
            hi = t
    return cubic(ay, by, (lo + hi) / 2)


def sample(timeline, time):
    frames = timeline['frames']
    if not frames or time < frames[0]['time']:
        return None
    i = len(frames) - 1
    for j in range(len(frames) - 1):
        if time < frames[j + 1]['time']:
            i = j
            break
    first = frames[i]
    kind = timeline['kind']
    if i == len(frames) - 1 or kind in ('attachment', 'drawOrder', 'events'):
        return first['values']
    second = frames[i + 1]
    p = progress(first.get('curve', 'linear'), (time - first['time']) / (second['time'] - first['time']))
    if len(first['values']) != len(second['values']):
        raise ValueError('mismatched keyframe dimensions')
    result = []
    for j, (a, b) in enumerate(zip(first['values'], second['values'])):
        if kind == 'ik' and j >= 2:
            result.append(a)
        else:
            difference = angle(b - a) if kind == 'rotate' else b - a
            result.append(a + difference * p)
    return result


def matrix(b):
    rx, ry = (b['rotation'] + b['shearX']) * RAD, (b['rotation'] + 90 + b['shearY']) * RAD
    return [math.cos(rx) * b['scaleX'], math.cos(ry) * b['scaleY'], math.sin(rx) * b['scaleX'], math.sin(ry) * b['scaleY'], b['x'], b['y']]


def point(m, x, y):
    a, b, c, d, tx, ty = m
    return [a * x + b * y + tx, c * x + d * y + ty]


def multiply(p, q):
    a, b, c, d, x, y = p
    e, f, g, h, u, v = q
    return [a * e + b * g, a * f + b * h, c * e + d * g, c * f + d * h, a * u + b * v + x, c * u + d * v + y]


def inverse_point(m, x, y):
    a, b, c, d, tx, ty = m
    determinant = a * d - b * c
    if abs(determinant) < 1e-9:
        raise Unsupported('singular bone transform in constraint')
    x, y = x - tx, y - ty
    return [(d * x - b * y) / determinant, (a * y - c * x) / determinant]


def worlds(bones, overrides):
    result = []
    for i, b in enumerate(bones):
        if i in overrides:
            result.append(overrides[i])
            continue
        local = matrix(b)
        parent = b['parent']
        if parent is None:
            result.append(local)
        elif b['transform'] in (0, 'normal'):
            result.append(multiply(result[parent], local))
        elif b['transform'] in (1, 'onlyTranslation'):
            local[4:] = point(result[parent], b['x'], b['y'])
            result.append(local)
        else:
            raise Unsupported(f'bone transform mode {b["transform"]!r} on {b["name"]}')
    return result


def uniform_orthogonal(m):
    a, b, c, d = m[:4]
    lx, ly = math.hypot(a, c), math.hypot(b, d)
    return abs(a * d - b * c) > 1e-9 and abs(lx - ly) < 0.0001 * max(1, lx, ly) and abs(a * b + c * d) < 0.0001 * max(1, lx * ly)


def check_constraint_dependencies(c, bones, overrides):
    def descendant(index, ancestor):
        while index is not None:
            if index == ancestor:
                return True
            index = bones[index]['parent']
        return False
    for index in c['bones']:
        if descendant(c['target'], index):
            raise Unsupported(f'constraint {c["name"]}: target is in affected subtree')
        if any(done != index and descendant(done, index) for done in overrides):
            raise Unsupported(f'constraint {c["name"]}: later ancestor update of world-constrained subtree')


def apply_ik(c, bones, w, overrides):
    check_constraint_dependencies(c, bones, overrides)
    if not 0 <= c['mix'] <= 1:
        raise ValueError(f'IK {c["name"]}: mix outside 0..1')
    if c['skin'] or c['softness'] != 0 or c['compress'] or c['stretch']:
        raise Unsupported(f'IK {c["name"]}: skin/softness/compress/stretch variant')
    ids = c['bones']
    if len(ids) not in (1, 2):
        raise Unsupported(f'IK {c["name"]}: bone count {len(ids)}')
    if any(i in overrides for i in ids):
        raise Unsupported(f'IK {c["name"]} after world transform constraint on same bone')
    for i in ids:
        b = bones[i]
        if b['transform'] not in (0, 'normal') or b['scaleX'] <= 0 or b['scaleY'] <= 0 or abs(b['shearX']) > 1e-6 or abs(b['shearY']) > 1e-6:
            raise Unsupported(f'IK {c["name"]}: nonnormal, reflected or sheared bone {b["name"]}')
    target = w[c['target']][4:]
    bi = ids[0]
    b = bones[bi]
    pm = w[b['parent']] if b['parent'] is not None else [1, 0, 0, 1, 0, 0]
    if not uniform_orthogonal(pm):
        raise Unsupported(f'IK {c["name"]}: nonuniform/sheared ancestor')
    tx, ty = inverse_point(pm, *target)
    tx, ty = tx - b['x'], ty - b['y']
    if len(ids) == 1:
        desired = math.atan2(ty, tx) / RAD
        b['rotation'] += angle(desired - b['rotation']) * c['mix']
    else:
        child = bones[ids[1]]
        if child['parent'] != bi or abs(b['scaleX'] - b['scaleY']) > 1e-6:
            raise Unsupported(f'IK {c["name"]}: needs direct child and uniform parent')
        # Solve in ancestor-local coordinates. This remains exact for a uniform
        # reflected ancestor (direction flips), and for nonzero child Y offsets.
        origin_angle = math.atan2(child['y'], child['x'])
        l1 = math.hypot(child['x'], child['y']) * b['scaleX']
        l2 = child['length'] * child['scaleX'] * b['scaleX']
        if l1 <= 0 or l2 <= 0:
            raise Unsupported(f'IK {c["name"]}: zero segment length')
        cosine = max(-1, min(1, (tx * tx + ty * ty - l1 * l1 - l2 * l2) / (2 * l1 * l2)))
        elbow = math.acos(cosine) * c['bend']
        shoulder = math.atan2(ty, tx) - math.atan2(l2 * math.sin(elbow), l1 + l2 * math.cos(elbow)) - origin_angle
        b['rotation'] += angle(shoulder / RAD - b['rotation']) * c['mix']
        child['rotation'] += angle((elbow + origin_angle) / RAD - child['rotation']) * c['mix']
    return worlds(bones, overrides)


def apply_transform(c, bones, w, overrides):
    check_constraint_dependencies(c, bones, overrides)
    if any(not 0 <= c[k] <= 1 for k in ('rotateMix', 'translateMix', 'scaleMix', 'shearMix')):
        raise ValueError(f'transform {c["name"]}: mix outside 0..1')
    if c['skin'] or c['local'] or c['relative']:
        raise Unsupported(f'transform {c["name"]}: skin/local/relative variant')
    target = w[c['target']]
    if target[0] * target[3] - target[1] * target[2] <= 0:
        raise Unsupported(f'transform {c["name"]}: reflected/singular target')
    for i in c['bones']:
        m = list(w[i])
        a, b, cc, d, x, y = m
        if a * d - b * cc <= 0:
            raise Unsupported(f'transform {c["name"]}: reflected/singular constrained bone')
        rotation = math.atan2(cc, a)
        delta = angle((math.atan2(target[2], target[0]) - rotation) / RAD + c['rotation']) * RAD * c['rotateMix']
        co, si = math.cos(delta), math.sin(delta)
        m[:4] = [co * a - si * cc, co * b - si * d, si * a + co * cc, si * b + co * d]
        desired = point(target, c['x'], c['y'])
        m[4:] = [x + (desired[0] - x) * c['translateMix'], y + (desired[1] - y) * c['translateMix']]
        for p, q, tp, tq, offset in ((0, 2, 0, 2, 'scaleX'), (1, 3, 1, 3, 'scaleY')):
            length = math.hypot(m[p], m[q])
            if length > 1e-9:
                desired_length = math.hypot(target[tp], target[tq]) + c[offset]
                ratio = (length + (desired_length - length) * c['scaleMix']) / length
                if ratio <= 0:
                    raise Unsupported(f'transform {c["name"]}: scale crosses reflection')
                m[p], m[q] = m[p] * ratio, m[q] * ratio
        bx = math.atan2(m[2], m[0])
        by = math.atan2(m[3], m[1])
        target_shear = angle((math.atan2(target[3], target[1]) - math.atan2(target[2], target[0])) / RAD)
        desired_shear = target_shear + c['shearY']
        by += angle(desired_shear - (by - bx) / RAD) * RAD * c['shearMix']
        length = math.hypot(m[1], m[3])
        m[1], m[3] = math.cos(by) * length, math.sin(by) * length
        overrides[i] = m
        w = worlds(bones, overrides)
    return w


def draw_order(count, changes):
    result = [None] * count
    unchanged, cursor = [], 0
    for slot, offset in changes:
        if slot < cursor or slot >= count or not 0 <= slot + offset < count:
            raise ValueError('invalid draw order offsets')
        unchanged.extend(range(cursor, slot))
        if result[slot + offset] is not None:
            raise ValueError('colliding draw order offsets')
        result[slot + offset] = slot
        cursor = slot + 1
    unchanged.extend(range(cursor, count))
    source = iter(unchanged)
    return [next(source) if v is None else v for v in result]


def pose(skeleton, animation, time):
    bones, slots = copy.deepcopy(skeleton['bones']), copy.deepcopy(skeleton['slots'])
    ik, transform = copy.deepcopy(skeleton['ik']), copy.deepcopy(skeleton['transform'])
    order, deform = list(range(len(slots))), {}
    for timeline in animation['timelines']:
        values = sample(timeline, time)
        if values is None:
            continue
        k, i = timeline['kind'], timeline['index']
        if k == 'rotate':
            bones[i]['rotation'] += values[0]
        elif k in ('translate', 'scale', 'shear'):
            keys = {'translate': ('x', 'y'), 'scale': ('scaleX', 'scaleY'), 'shear': ('shearX', 'shearY')}[k]
            for key, v in zip(keys, values):
                bones[i][key] = bones[i][key] * v if k == 'scale' else bones[i][key] + v
        elif k == 'attachment':
            slots[i]['attachment'] = values[0]
        elif k == 'color':
            slots[i]['color'] = values
        elif k == 'twoColor':
            slots[i]['color'], slots[i]['dark'] = values[:4], values[4:7]
        elif k == 'ik':
            for key, v in zip(('mix', 'softness', 'bend', 'compress', 'stretch'), values):
                ik[i][key] = v
        elif k == 'transform':
            for key, v in zip(('rotateMix', 'translateMix', 'scaleMix', 'shearMix'), values):
                transform[i][key] = v
        elif k == 'deform':
            deform[(timeline['skin'], i, timeline['attachment'])] = values
        elif k == 'drawOrder':
            order = draw_order(len(slots), values)
        elif k != 'events':
            raise Unsupported(f'unknown timeline {k}')
    overrides = {}
    for b in bones:
        if b['skin']:
            raise Unsupported(f'skin-required bone {b["name"]}')
    w = worlds(bones, overrides)
    constraints = [(c['order'], 'ik', c) for c in ik] + [(c['order'], 'transform', c) for c in transform]
    orders = [c[0] for c in constraints]
    if len(set(orders)) != len(orders):
        raise Unsupported('duplicate constraint orders')
    for _, kind, c in sorted(constraints, key=lambda entry: entry[0]):
        # Structural variants are checked even for mix=0: no silent skipping.
        w = apply_ik(c, bones, w, overrides) if kind == 'ik' else apply_transform(c, bones, w, overrides)
    return slots, w, order, deform


def atlas_regions(pages, textures):
    regions = {}
    for page in pages:
        image = textures[page['name']].convert('RGBA')
        attributes = page['attributes']
        if attributes.get('pma', 'false') == 'true':
            pixels = []
            for r, g, b, a in image.getdata():
                pixels.append((min(255, round(r * 255 / a)), min(255, round(g * 255 / a)), min(255, round(b * 255 / a)), a) if a else (0, 0, 0, 0))
            image.putdata(pixels)
        if attributes.get('repeat', 'none') != 'none':
            raise Unsupported('repeating atlas textures')
        for raw in page['regions']:
            name, attr = raw['name'], raw['attributes']
            if name in regions:
                raise Unsupported(f'duplicate/indexed atlas region {name!r}')
            def nums(key, default=None):
                return [int(v.strip()) for v in attr[key].split(',')] if key in attr else default
            rotation = attr.get('rotate', 'false')
            rotation = 90 if rotation == 'true' else 0 if rotation == 'false' else int(rotation)
            if rotation not in (0, 90, 180, 270):
                raise Unsupported(f'atlas rotation {rotation}')
            if 'bounds' in attr:
                x, y, width, height = nums('bounds')
            else:
                x, y = nums('xy')
                width, height = nums('size')
            packed_width, packed_height = (height, width) if rotation in (90, 270) else (width, height)
            if width <= 0 or height <= 0 or min(x, y) < 0 or x + packed_width > image.width or y + packed_height > image.height:
                raise ValueError(f'atlas region {name!r} outside texture dimensions')
            patch = image.crop((x, y, x + packed_width, y + packed_height))
            if rotation:
                patch = patch.transpose({90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}[rotation])
            if 'offsets' in attr:
                left, bottom, ow, oh = nums('offsets')
            else:
                left, bottom = nums('offset', [0, 0])
                ow, oh = nums('orig', [width, height])
            if min(ow, oh) <= 0 or min(left, bottom) < 0 or left + width > ow or bottom + height > oh:
                raise ValueError(f'invalid trim offsets in {name!r}')
            full = Image.new('RGBA', (ow, oh))
            full.paste(patch, (left, oh - bottom - height))
            regions[name] = full
    return regions


def attachment_for(s, skin_name, slot, key):
    for name in (skin_name, 'default'):
        skin = next((v for v in s['skins'] if v['name'] == name), None)
        a = skin['attachments'].get(slot, {}).get(key) if skin else None
        if a is not None:
            return name, a
    raise ValueError(f'attachment {key!r} absent from slot {slot} skin {skin_name!r}')


def geometry(s, animation, time, skin_name, regions):
    slots, w, order, deform = pose(s, animation, time)
    result = []
    for si in order:
        slot = slots[si]
        key = slot['attachment']
        if key is None:
            continue
        blend = {0: 'normal', 1: 'additive', 2: 'multiply', 3: 'screen', 'normal': 'normal', 'additive': 'additive', 'multiply': 'multiply', 'screen': 'screen'}.get(slot['blend'])
        if blend is None:
            raise Unsupported(f'unknown slot blend mode {slot["blend"]!r} in {slot["name"]}')
        attachment_skin, a = attachment_for(s, skin_name, si, key)
        if a['type'] in (1, 5):
            continue  # Bounding boxes and points have no visible pixels.
        deform_key = (attachment_skin, si, key)
        if a['type'] == 3:
            parent_skin, parent = attachment_for(s, a['skin'], si, a['parent'])
            if parent['type'] != 2:
                raise Unsupported('linked mesh parent must be a concrete mesh')
            child = a
            a = {**parent, **{k: child[k] for k in ('name', 'path', 'color')}}
            if child['deform']:
                deform_key = (parent_skin, si, child['parent'])
        image = regions.get(a['path'])
        if image is None:
            raise ValueError(f'atlas region absent: {a["path"]!r}')
        if a['type'] == 0:
            halfw, halfh = a['width'] / 2, a['height'] / 2
            am = matrix({**a, 'shearX': 0, 'shearY': 0})
            world = multiply(w[slot['bone']], am)
            verts = [point(world, -halfw, halfh), point(world, halfw, halfh), point(world, halfw, -halfh), point(world, -halfw, -halfh)]
            uv, triangles = [[0, 0], [image.width, 0], [image.width, image.height], [0, image.height]], [0, 1, 2, 2, 3, 0]
        elif a['type'] == 2:
            delta = deform.get(deform_key)
            verts = []
            if a['weighted']:
                cursor = 0
                for vertex in a['vertices']:
                    x, y = 0, 0
                    for bi, vx, vy, weight in vertex:
                        dx, dy = delta[cursor:cursor + 2] if delta else (0, 0)
                        cursor += 2
                        px, py = point(w[bi], vx + dx, vy + dy)
                        x, y = x + px * weight, y + py * weight
                    verts.append([x, y])
            else:
                for i in range(0, len(a['vertices']), 2):
                    vx, vy = a['vertices'][i:i + 2]
                    dx, dy = delta[i:i + 2] if delta else (0, 0)
                    verts.append(point(w[slot['bone']], vx + dx, vy + dy))
            uv = [[a['uvs'][i] * image.width, a['uvs'][i + 1] * image.height] for i in range(0, len(a['uvs']), 2)]
            if any(x < -1e-5 or x > image.width + 1e-5 or y < -1e-5 or y > image.height + 1e-5 for x, y in uv):
                raise Unsupported('mesh UV outside region')
            triangles = a['triangles']
        else:
            raise Unsupported(f'visible attachment type {a["type"]}')
        tint = [x * y for x, y in zip(slot['color'], a['color'])]
        result.append({'image': image, 'vertices': verts, 'uv': uv, 'triangles': triangles, 'tint': tint, 'dark': slot['dark'], 'blend': blend})
    return result


def tinted(image, light, dark):
    if light == [1, 1, 1, 1] and not dark:
        return image
    dark = dark or [0, 0, 0]
    channels = image.split()
    rgb = [channels[i].point([max(0, min(255, round(v * light[i] + (255 - v) * dark[i]))) for v in range(256)]) for i in range(3)]
    alpha = channels[3].point([max(0, min(255, round(v * light[3]))) for v in range(256)])
    return Image.merge('RGBA', (*rgb, alpha))


def composite_layer(canvas, layer, mode):
    if mode == 'normal':
        canvas.alpha_composite(layer)
        return
    bounds = layer.getbbox()
    if bounds is None:
        return
    source = layer.crop(bounds)
    backdrop = canvas.crop(bounds)
    pixels = []
    for src, dst in zip(source.getdata(), backdrop.getdata()):
        if src[3] == 0:
            pixels.append(dst)
            continue
        if dst[3] == 0:
            pixels.append(src)
            continue
        sa, da = src[3] / 255, dst[3] / 255
        if mode == 'additive':
            # Standard additive RGB (SRC_ALPHA, ONE), represented in a
            # transparent PNG as Porter-Duff plus-lighter: add premultiplied
            # colors AND coverage, clamp, then unpremultiply. Using alpha-over
            # coverage here would change a second translucent glow's opacity.
            alpha = min(1, sa + da)
            rgb = [min(1, src[i] / 255 * sa + dst[i] / 255 * da) / alpha for i in range(3)]
        elif mode in ('multiply', 'screen'):
            # Separable blend within source-over coverage. The uncovered
            # portions retain their original source/backdrop shade RGB.
            alpha = sa + da * (1 - sa)
            rgb = []
            for i in range(3):
                sc, dc = src[i] / 255, dst[i] / 255
                blended = sc * dc if mode == 'multiply' else sc + dc - sc * dc
                premultiplied = sa * (1 - da) * sc + da * (1 - sa) * dc + sa * da * blended
                rgb.append(premultiplied / alpha)
        else:
            raise Unsupported(f'unknown compositor blend mode {mode!r}')
        pixels.append(tuple(max(0, min(255, round(c * 255))) for c in (*rgb, alpha)))
    backdrop.putdata(pixels)
    canvas.paste(backdrop, bounds[:2])


def rasterize(items, bounds, scale):
    left, bottom, right, top = bounds
    width, height = math.ceil((right - left) * scale), math.ceil((top - bottom) * scale)
    if min(width, height) < 1 or max(width, height) > 8192 or width * height > 16777216:
        raise Unsupported(f'frame canvas size {width}x{height}')
    canvas = Image.new('RGBA', (width, height))
    for item in items:
        vertices = [[(x - left) * scale, (top - y) * scale] for x, y in item['vertices']]
        source = tinted(item['image'], item['tint'], item['dark'])
        layer = Image.new('RGBA', canvas.size)
        tri = item['triangles']
        for i in range(0, len(tri), 3):
            indices = tri[i:i + 3]
            dst = [vertices[j] for j in indices]
            src = [item['uv'][j] for j in indices]
            x0, y0 = dst[0]
            x1, y1 = dst[1]
            x2, y2 = dst[2]
            determinant = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
            if abs(determinant) < 1e-9:
                continue  # Collapsed/edge-on triangles have zero covered area.
            bx = max(0, math.floor(min(p[0] for p in dst)))
            by = max(0, math.floor(min(p[1] for p in dst)))
            ex = min(width, math.ceil(max(p[0] for p in dst)))
            ey = min(height, math.ceil(max(p[1] for p in dst)))
            if ex <= bx or ey <= by:
                continue
            coefficients = []
            for axis in (0, 1):
                du, dv = src[1][axis] - src[0][axis], src[2][axis] - src[0][axis]
                a = (du * (y2 - y0) - dv * (y1 - y0)) / determinant
                b = (dv * (x1 - x0) - du * (x2 - x0)) / determinant
                c = src[0][axis] - a * x0 - b * y0 + a * bx + b * by
                coefficients.extend((a, b, c))
            patch = source.transform((ex - bx, ey - by), Image.Transform.AFFINE, coefficients, Image.Resampling.BICUBIC)
            mask = Image.new('L', patch.size)
            ImageDraw.Draw(mask).polygon([(x - bx, y - by) for x, y in dst], fill=255)
            # Paste each triangle into ONE attachment layer, not alpha-over each
            # other: shared triangle edges must not double the texture opacity.
            layer.paste(patch, (bx, by), mask)
        composite_layer(canvas, layer, item['blend'])
    return canvas
