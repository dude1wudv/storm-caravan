"""2581-only offline source recovery. Never executes original JS or contacts a service."""
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).parent / 'vendor'))
from elftools.elf.elffile import ELFFile

NATIVE_ENTRY = 'lib/arm64-v8a/libcocos2djs.so'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError(f'Existing output differs: {path.name}')
        return
    path.write_bytes(data)


class Native:
    def __init__(self, data):
        self.data = data
        self.elf = ELFFile(io.BytesIO(data))
        self.relocations = {}
        for section in self.elf.iter_sections():
            if section['sh_type'] == 'SHT_RELA':
                symbols = self.elf.get_section(section['sh_link'])
                for r in section.iter_relocations():
                    self.relocations[r['r_offset']] = symbols.get_symbol(r['r_info_sym'])['st_value'] + r['r_addend']

    def raw(self, address, size):
        for segment in self.elf.iter_segments():
            if segment['p_type'] == 'PT_LOAD' and segment['p_vaddr'] <= address < segment['p_vaddr'] + segment['p_filesz']:
                offset = segment['p_offset'] + address - segment['p_vaddr']
                return self.data[offset:offset + size]
        raise ValueError(f'Non-file-backed address {address:x}')

    def string(self, address):
        return self.raw(address, 4096).split(b'\0', 1)[0]

    def pointer(self, address):
        return self.relocations.get(address, struct.unpack('<Q', self.raw(address, 8))[0])

    def key(self):
        # Exact AppDelegate 0x6ee98c and setter4 0x78f680 operations.
        # Inputs remain in memory; no key literals, values or hashes are emitted.
        first = (self.string(0x15dc0ad).decode() % (3, 64, 4, 4)).encode()
        original_seed = self.string(0x15dc0bf)
        second = str(sum(original_seed)).encode()
        third_source = self.string(0x15dc0dd)
        third = third_source[third_source.count(b';'):third_source.count(b';') + 1]
        words = struct.unpack('<10I', self.raw(0x15dc13c, 40))
        fourth = ''.join(str(v) for v in words[8:0:-1] if v % 2 == 0).encode()
        suffix = b''.join(self.string(a)[:1] for a in (0x1618ba9, 0x1634127, 0x175b9f6, 0x175ba02, 0x170d43a))
        fifth = hashlib.md5(fourth + suffix).hexdigest().encode()
        alphabet = bytearray(self.string(0x15dc4b0))
        for i, c in enumerate(second):
            j = c - 48 if 48 <= c <= 57 else c - 87 if 97 <= c <= 122 else c - 29 if 65 <= c <= 90 else 0
            p = 63 - i if i % 2 == 0 else i
            alphabet[p], alphabet[j] = alphabet[j], alphabet[p]
        sixth = base64.b64encode(original_seed).translate(bytes.maketrans(b'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=', bytes(alphabet) + b'*'))
        seventh_array = bytearray(self.raw(0x15dc164, 32) + b'F')
        for i, v in ((0, 44), (3, 47), (5, 48), (24, 92)):
            seventh_array[i] = v
        seventh_array[8:10] = struct.pack('<H', 0x2b32)
        seventh_array[20:22] = struct.pack('<H', 0x582a)
        repeated = bytes(seventh_array) * 31
        start = repeated.index(b'/')
        seventh = repeated[start:repeated.index(b'/', start + 1)]
        summed = str(sum(map(int, str(int(fourth) & 0xffffffff)))).encode()
        previous = first[6:10] + summed + second + third
        number = int((fourth + suffix)[3:6])
        steps = (number // 100 % 10, number // 10 % 10, number % 10)
        backwards = struct.unpack('<4i', self.raw(0x15f42cc, 16))
        combined = fifth + seventh + self.string(0x15e1fee)[:4] + previous + sixth
        sampled = bytearray()
        position = steps[0]
        count = 0
        while position < len(combined):
            sampled.append(combined[position])
            position += steps[(count + 1) % 3]
            count += 1
        position = len(combined) - backwards[count % 4] - 1
        while position >= 0:
            sampled.append(combined[position])
            count += 1
            position -= backwards[count % 4]
        return sampled[5:21]

    def order(self):
        result = list(struct.unpack('<12i', self.raw(0x15f4cbc, 48)))
        state = 0x2355f if int(self.string(0x15f30e4)) == 0x1b7c5 else 0x7d99
        for i in range(12):
            state = (state * 0x1d7 + 0xc091) % 0x174ef
            j = state % 10
            result[i], result[j] = result[j], result[i]
        return result

    def embedded(self, pointer_table, size_table, count, transform):
        pointers = [self.pointer(pointer_table + 8 * i) for i in range(count)]
        pointers = transform(pointers)
        sizes = struct.unpack(f'<{count}I', self.raw(size_table, count * 4))
        return b''.join(self.raw(p, size) for p, size in zip(pointers, sizes))


def preprocess(data):
    # Native to_uint32_array 0x7b7844, mode=1. Remove dispersed 64B metadata.
    result = bytearray(data)
    if len(result) <= 16384:
        return result, None
    size = len(result) - 64
    stride = size // 33
    locations = []
    position, compact_position = 36, 32
    for _ in range(32):
        locations.append(compact_position)
        d = result[position - 3]
        a, b = position - d - 5, position + d - 1
        if a >= 0 and b < len(result):
            result[a], result[b] = result[b], result[a]
        d = result[position - 4]
        a, b = position - d - 6, position + d
        if a >= 0 and b < len(result):
            result[a], result[b] = result[b], result[a]
        position += stride + 1
        compact_position += stride - 1
    markers, restore = [], []
    j = 0
    for i in range(size):
        if j < 32 and i == locations[j]:
            markers.append((result[i + 2 * j] - 64) & 255)
            restore.append(result[i + 2 * j + 1])
            j += 1
        result[i] = result[i + 2 * j]
    result = result[:size]
    checksum = hashlib.md5(result).hexdigest().encode()
    matches = sum(x == y for x, y in zip(checksum, markers))
    for i in range(32):
        if checksum[i] != markers[i]:
            result[i] = restore[i]
    return result, matches


def decrypt(data, key):
    data, matches = preprocess(data)
    data.extend(b'\0' * (-len(data) % 4))
    words = list(struct.unpack(f'<{len(data) // 4}I', data))
    keybytes = bytearray(key[:16])
    keybytes.extend(b'\0' * (16 - len(keybytes)))
    adjusted = [v + i for i, v in enumerate(keybytes)]
    keywords = [sum(adjusted[j + i] << (8 * i) for i in range(4)) & 0xffffffff for j in range(0, 16, 4)]
    count, delta = len(words), 0x9e3779b9
    total, y = ((6 + 52 // count) * delta) & 0xffffffff, words[0]
    while total:
        e = (total >> 2) & 3
        for p in range(count - 1, -1, -1):
            z = words[p - 1] if p else words[-1]
            mx = (((z >> 5 ^ y << 2) + (y >> 3 ^ z << 4)) ^ ((total ^ y) + (keywords[(p & 3) ^ e] ^ z))) & 0xffffffff
            words[p] = (words[p] - mx) & 0xffffffff
            y = words[p]
        total = (total - delta) & 0xffffffff
    result = struct.pack(f'<{count}I', *words)
    length = words[-1]
    if not len(result) - 7 <= length <= len(result) - 4:
        raise ValueError('Original XXTEA length check failed; no synthetic output')
    result = result[:length]
    return (gzip.decompress(result) if result[:2] == b'\x1f\x8b' else result), matches


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    options = parser.parse_args()
    with zipfile.ZipFile(options.apk) as apk:
        native = Native(apk.read(NATIVE_ENTRY))
        expected = 'e644052a3b365533bb1bd3d9952a21a99cdf58fe6a98561801146a528393d24a'
        if digest(native.data) != expected:
            raise ValueError('Native source is not the pinned 2581 snapshot')
        key, order = native.key(), native.order()
        outputs = {}
        for name, fragments in (('main.index.js', order[:10]), ('resources.index.js', order[10:])):
            entries = [f'assets/assets/libs/pr{i}.so' for i in fragments]
            plain, checks = decrypt(b''.join(apk.read(n) for n in entries), key)
            save(options.output / 'decoded' / name, plain)
            outputs[name] = {'sourceEntry': entries, 'outputHash': digest(plain), 'metadataMatches': checks}
        adapter_pointers = [native.pointer(0x1994888 + 8 * i) for i in range(21)]
        original = adapter_pointers.copy()
        adapter_pointers[3] = native.pointer(0x1a3b000)
        for destination, source in ((0, 3), (4, 7), (11, 8), (7, 4), (8, 11), (15, 12), (16, 19), (12, 15), (19, 16)):
            adapter_pointers[destination] = original[source]
        def settings_order(p):
            for i in range(0, 109, 3):
                p[i], p[i + 2] = p[i + 2], p[i]
            return p
        def engine_order(p):
            for i in range(0, 204, 2):
                p[i], p[i + 1] = p[i + 1], p[i]
            return p
        for name, pointer_table, size_table, count, transform in (
            ('jsb-adapter.jsb-engine.js', 0x1994888, 0x15f2d5c, 21, lambda p: adapter_pointers),
            ('src.settings.js', 0x1994508, 0x15f2b9c, 112, settings_order),
            ('src.cocos2d-jsb.js', 0x1994930, 0x15f2db0, 205, engine_order),
        ):
            plain, checks = decrypt(native.embedded(pointer_table, size_table, count, transform), key)
            save(options.output / 'decoded' / name, plain)
            outputs[name] = {'sourceEntry': NATIVE_ENTRY, 'outputHash': digest(plain), 'metadataMatches': checks}
        packed = native.raw(native.pointer(0x1a38b20), 0x18db)
        startup = bytearray()
        for i in range(0, len(packed), 7):
            group = packed[i:i + 7]
            startup.extend([group[0] >> 1, *[(group[k] >> (k + 1)) | ((group[k - 1] & ((1 << k) - 1)) << (7 - k)) for k in range(1, 7)], group[6] & 127])
        save(options.output / 'decoded' / 'startup.main.js', startup)
        outputs['startup.main.js'] = {'sourceEntry': NATIVE_ENTRY, 'outputHash': digest(startup)}
        save(options.output / 'native-extraction.json', (json.dumps(outputs, indent=2) + '\n').encode())
        print(json.dumps({'recovered': list(outputs), 'originalJsExecuted': False, 'keyValuesLogged': False}))


if __name__ == '__main__':
    main()
