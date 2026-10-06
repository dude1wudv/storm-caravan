"""Pinned 2581 static core recovery. No ELF or original JavaScript execution.
Only reads prior recovery inputs and writes the new core-runtime directory.
"""
from pathlib import Path
import base64
import hashlib
import io
import json
import struct
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools/recovery/client-2581/vendor'))
from elftools.elf.elffile import ELFFile
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM

OUT = ROOT / 'reports/private/reconstruction/2581/core-runtime'
NATIVE = ROOT / 'reports/private/reconstruction/2581/visual-recovery/source/libcocos2djs-arm64.so'
PIN = 'e644052a3b365533bb1bd3d9952a21a99cdf58fe6a98561801146a528393d24a'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(name, data):
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError('Existing recovery output differs: ' + name)
        return
    path.write_bytes(data)


def main():
    data = NATIVE.read_bytes()
    if sha(data) != PIN:
        raise ValueError('Not the pinned original arm64 library')
    elf = ELFFile(io.BytesIO(data))
    symbols = {s.name: (int(s['st_value']), int(s['st_size']))
               for section in elf.iter_sections() if section['sh_type'] in ('SHT_DYNSYM', 'SHT_SYMTAB')
               for s in section.iter_symbols() if s.name}
    cs = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
    cs.detail = True

    def offset(address, size):
        for segment in elf.iter_segments():
            if (segment['p_type'] == 'PT_LOAD' and segment['p_vaddr'] <= address
                    and address + size <= segment['p_vaddr'] + segment['p_filesz']):
                return int(segment['p_offset'] + address - segment['p_vaddr'])
        raise ValueError('Not file-backed: ' + hex(address))

    def raw(address, size):
        start = offset(address, size)
        return data[start:start + size]

    def evidence(address, size, role):
        start = offset(address, size)
        return {'role': role, 'virtualRange': [hex(address), hex(address + size)],
                'fileRange': [start, start + size], 'bytes': size,
                'sha256': sha(raw(address, size))}

    ranges = []
    route_names = ['_Z14ft_c_call_coreRN2se5StateE', '_Z12Base64DecodeRNSt6__ndk112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEES6_',
                   '_Z9ft_c_initRN2se5StateE', 'Java_org_cocos2dx_javascript_AppActivity_initGame',
                   '_Z22ft_c_call_coreRegistryRKN2v820FunctionCallbackInfoINS_5ValueEEE']
    for name in route_names:
        a, size = symbols[name]
        rec = evidence(a, size, name)
        safe = {'_Z14ft_c_call_coreRN2se5StateE': 'call-core',
                '_Z9ft_c_initRN2se5StateE': 'ft-c-init',
                'Java_org_cocos2dx_javascript_AppActivity_initGame': 'init-game',
                '_Z22ft_c_call_coreRegistryRKN2v820FunctionCallbackInfoINS_5ValueEEE': 'call-core-registry'}.get(name, 'base64-decode')
        rec['byteOutput'] = 'evidence/' + safe + '.bin'
        save(rec['byteOutput'], raw(a, size))
        lines = []
        for ins in cs.disasm(raw(a, size), a):
            # Do not publish the literal key argument. It is independently available
            # from the exact native code ranges, not from signing/initGame state.
            operand = '<key argument immediate redacted>' if ins.address in (0x6f9480, 0x6f9494) else ins.op_str
            lines.append(f'{ins.address:08x}: {ins.mnemonic} {operand}')
        rec['disassemblyOutput'] = 'evidence/' + safe + '.asm'
        save(rec['disassemblyOutput'], ('\n'.join(lines) + '\n').encode())
        ranges.append(rec)
    ranges.append(evidence(0x6f554c, 0xa4, 'snprintf wrapper; __vsnprintf_chk target'))

    # Twenty memcpy sources and their explicit permutation table, call_core
    # 0x6f903c..0x6f945c. Each original byte is masked with 0x7f.
    order = list(struct.unpack('<20Q', raw(0x15dfe80, 160)))
    ranges.append(evidence(0x15dfe80, 160, '20-entry source permutation'))
    blocks = [raw(0x15dcf4c + index * 604, 604) for index in range(20)]
    chunk_ranges = []
    encoded = bytearray()
    for index, source_index in enumerate(order):
        size = 596 if index == 19 else 604
        original = blocks[source_index][:size]
        chunk = bytes(c & 127 for c in original)
        rec = evidence(0x15dcf4c + source_index * 604, size, 'core encoded block')
        rec.update({'routeOrder': index, 'nativeSourceIndex': source_index,
                    'encodedRange': [len(encoded), len(encoded) + size], 'maskedSha256': sha(chunk)})
        chunk_ranges.append(rec)
        encoded.extend(chunk)
    ranges.extend(evidence(0x15dcf4c + i * 604, 604, 'memcpy source ' + str(i)) for i in range(20))
    save('call-core.encoded.bin', bytes(encoded))

    # Static lookup initializer from Base64Decode 0x6f0620..0x6f070c.
    table = bytearray([126] * 128)
    off = 45
    stores = [(off + 0x32, bytes([8])), (off + 0x38, struct.pack('<H', 0xe0d)),
              (off + 0x2a, bytes([0x11])), (off + 0x34, struct.pack('<I', 0xc0b0a09)),
              (off + 0x1d, bytes([0x16])), (off + 0x28, struct.pack('<H', 0x100f)),
              (off + 8, bytes([0x1d])), (off + 0x2d, bytes([0x20])),
              (off + 0x19, struct.pack('<I', 0x15141312)), (off + 0x4a, struct.pack('<I', 0x25242322)),
              (off + 0x44, struct.pack('<I', 0x18171a19)), (off + 0x17, struct.pack('<H', 0x2928)),
              (off + 0x2b, struct.pack('<H', 0x1f1e)), (off + 3, bytes([0x21])),
              (off + 0x3c, struct.pack('<Q', 0x333231302f2e2d2c)),
              (off + 4, struct.pack('<I', 0x1c1b2726)), (off + 0x48, struct.pack('<H', 0x2b2a)),
              (off + 0x3a, struct.pack('<H', 0x3534)), (off + 9, struct.pack('<I', 0x39383736)),
              (off, bytes([0x3a])), (off + 0x14, struct.pack('<H', 0x3c3b)),
              (off + 0x16, bytes([0x3d])), (off + 0x26, struct.pack('<H', 0x3f3e)),
              (off + 0x1e, raw(0x15dc4a8, 8))]
    for o, value in stores:
        table[o:o + len(value)] = value
    ranges.append(evidence(0x15dc4a8, 8, 'Base64 lookup initializer literal'))
    ranges.append(evidence(0x6f0620, 0xf0, 'Base64 lookup initializer instructions'))
    ranges.append(evidence(0x6f0710, 0xe4, 'Base64 key-dependent lookup value swaps'))
    ranges.append(evidence(0x6f07f4, 0x1d4, 'Base64 group extraction and sentinel termination'))
    ranges.append(evidence(0x6f947c, 0x24, 'core-only static snprintf argument setup'))
    fmt = raw(0x16ac471, 32).split(b'\0', 1)[0]
    ranges.append(evidence(0x16ac471, len(fmt) + 1, 'snprintf format literal; value deliberately omitted'))
    # Read literal operands, never call/emulate the native function.
    low = next(cs.disasm(raw(0x6f9480, 4), 0x6f9480)).operands[1].imm
    high = next(cs.disasm(raw(0x6f9494, 4), 0x6f9494)).operands[1].imm
    key = (fmt.decode() % (low | (high << 16),)).encode()
    for i, c in enumerate(key):
        j = c - 48 if 48 <= c <= 57 else c - 87 if 97 <= c <= 122 else c - 29 if 65 <= c <= 90 else 0
        p = 63 - i if i % 2 == 0 else i
        jindex, pindex = table.index(j), table.index(p)
        table[jindex], table[pindex] = table[pindex], table[jindex]
    standard = b'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    valid = bytearray()
    for c in encoded:
        if table[c] == 126:
            break
        valid.append(standard[table[c]])
    original = base64.b64decode(valid + b'=' * ((-len(valid)) % 4))
    original.decode('utf-8')
    save('call-core.original.js', original)
    manifest = {
        'schemaVersion': 1, 'versionCode': 2581,
        'source': {'path': NATIVE.relative_to(ROOT).as_posix(), 'apkEntry': 'lib/arm64-v8a/libcocos2djs.so',
                   'sha256': PIN, 'bytes': len(data)},
        'output': {'path': 'call-core.original.js', 'bytes': len(original), 'sha256': sha(original)},
        'encoded': {'path': 'call-core.encoded.bin', 'bytes': len(encoded), 'sha256': sha(encoded),
                    'validBase64Characters': len(valid), 'chunks': chunk_ranges},
        'nativeRanges': ranges,
        'route': [
            'ft_c_init writes init flag at 0x1add8a0 (0x6f4004..0x6f4014), including the no-pay-data branch; no invocation was made.',
            'call_core tests this flag (0x6f9030..0x6f9038); unset branch enters a destructive infinite loop (0x6f9460..0x6f9478), not a decoding dependency.',
            'call_core assembles 20 fixed file-backed 604-byte sources in the permutation table order; last block contributes 596 bytes; masks every byte with 0x7f; terminates buffer at offset 12072.',
            'call_core independently formats a compile-time integer into its local key buffer; no runtime signature state read feeds this key.',
            'Base64Decode initializes the inverse alphabet table; for each key character swaps entries found by decoded numeric value, not by character index; stops at first table value 126.',
            'Recovered original byte count is 9053. This exact route contains neither XXTEA nor gzip; those are the separate prN/script loader routes.',
            'Decoded script is passed to ScriptEngine::addInitHook(const char*, long) at 0x6f94f4. It is not run by this recovery tool.',
            'initGame queries PackageInfo.signatures[0].hashCode and formats platform state buffers 0x1add984/0x1add940/0x1add8a9, then sets 0x1add8a8. These values are not needed for static call_core extraction and are not computed or disclosed.'
        ],
        'safety': {'originalJsExecuted': False, 'originalElfExecuted': False, 'nativeFunctionsCalled': False,
                   'remoteAccess': False, 'keyValuesLogged': False, 'implementationPatched': False},
        'limits': ['Source preservation and static ranges only, not a game/runtime pass.',
                   'Raw private original source necessarily retains all original literals. Indexes must not publish secret/auth/key values.',
                   'This evidence supersedes any blanket complete-client-JS conclusion only for the observed native injected methods; it does not restore authenticated platform behavior.']
    }
    save('native-core-manifest.json', (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode())
    print(json.dumps({'originalCoreBytes': len(original), 'sha256': sha(original), 'nativeCodeExecuted': False}))


if __name__ == '__main__':
    main()
