"""Preserve only pinned 2581 dragonbones route evidence; never execute original code."""
import argparse
import importlib.util
import json
from pathlib import Path
import struct
import sys
import zipfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    'client_recovery_2581', ROOT / 'tools/recovery/client-2581/recover.py')
RECOVERY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECOVERY)
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM

OUT = ROOT / 'reports/private/reconstruction/2581/dragonbones-recovery'
EXPECTED_NATIVE = 'e644052a3b365533bb1bd3d9952a21a99cdf58fe6a98561801146a528393d24a'
REQUEST = './jsb-dragonbones.js'
RANGES = (
    ('strip-final-extension', 0x79C378, 0x79C3B4),
    ('hash-final-seven-bytes', 0x79C428, 0x79C494),
    ('modulo100-and-jump-table', 0x79C530, 0x79C578),
    ('empty-key-and-special74-79', 0x79C650, 0x79C674),
    ('unmatched-empty-string', 0x79CAFC, 0x79CB10),
    ('cleanup-and-return', 0x79CE3C, 0x79CE8C),
)


def file_offset(native, address):
    for segment in native.elf.iter_segments():
        if (segment['p_type'] == 'PT_LOAD'
                and segment['p_vaddr'] <= address
                < segment['p_vaddr'] + segment['p_filesz']):
            return segment['p_offset'] + address - segment['p_vaddr']
    raise ValueError('Address is not file-backed')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apk', required=True, type=Path)
    parser.add_argument('--runtime-log', required=True, type=Path)
    options = parser.parse_args()
    with zipfile.ZipFile(options.apk) as apk:
        data = apk.read(RECOVERY.NATIVE_ENTRY)
        candidates = [name for name in apk.namelist()
                      if 'dragonbones' in name.lower()]
    if RECOVERY.digest(data) != EXPECTED_NATIVE:
        raise ValueError('Native source is not the pinned 2581 snapshot')
    native = RECOVERY.Native(data)
    decoded = ROOT / 'reports/private/reconstruction/2581/client-recovery/decoded'
    existing = list(decoded.rglob('*dragonbones*.js'))
    if existing or candidates:
        raise ValueError('Source candidates exist: review provenance before reuse')

    basename = REQUEST.rsplit('.', 1)[0]
    value = sum(ord(c) * 8 ** i for i, c in enumerate(basename[-7:]))
    remainder = value % 100
    if (value, remainder) != (33970783, 83):
        raise ValueError('Unexpected route hash')
    jump_raw = native.raw(0x15F2A96, 80)
    table = struct.unpack('<40H', jump_raw)
    if native.raw(0x1636F19, 1) != b'\0':
        raise ValueError('Original empty-string constant differs')
    plt = native.elf.get_section_by_name('.plt')
    relocations = native.elf.get_section_by_name('.rela.plt')
    symbols = native.elf.get_section(relocations['sh_link'])
    constructor = next(
        symbols.get_symbol(rel['r_info_sym']).name
        for index, rel in enumerate(relocations.iter_relocations())
        if plt['sh_addr'] + 32 + index * 16 == 0x6CC440)
    if constructor != '_ZNSt6__ndk112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEC2IDnEEPKc':
        raise ValueError('Empty-string constructor import differs')

    md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
    asm, ranges = [], []
    instructions = {}
    for label, start, end in RANGES:
        raw = native.raw(start, end - start)
        decoded_instructions = list(md.disasm(raw, start))
        if sum(instruction.size for instruction in decoded_instructions) != len(raw):
            raise ValueError('Incomplete bounded disassembly')
        asm.append(f'; {label}; end-exclusive {end:#x}; sha256 {RECOVERY.digest(raw)}')
        for instruction in decoded_instructions:
            instructions[instruction.address] = (instruction.mnemonic, instruction.op_str)
            asm.append(f'{instruction.address:08x}: {instruction.bytes.hex()}  '
                       f'{instruction.mnemonic} {instruction.op_str}'.rstrip())
        ranges.append({'name': label, 'nativeStart': hex(start),
                       'nativeEndExclusive': hex(end),
                       'fileOffset': hex(file_offset(native, start)),
                       'bytes': len(raw), 'sha256': RECOVERY.digest(raw)})
    required = {
        0x79C550: ('sub', 'w8, w20, #0x21'),
        0x79C554: ('cmp', 'w8, #0x27'),
        0x79C55C: ('b.hi', '#0x79c664'),
        0x79C664: ('cmp', 'w20, #0x4f'),
        0x79C668: ('b.eq', '#0x79c674'),
        0x79C66C: ('cmp', 'w20, #0x4a'),
        0x79C670: ('b.ne', '#0x79cafc'),
        0x79CAFC: ('adrp', 'x1, #0x1636000'),
        0x79CB00: ('add', 'x1, x1, #0xf19'),
        0x79CB04: ('mov', 'x0, x25'),
        0x79CB08: ('bl', '#0x6cc440'),
        0x79CB0C: ('b', '#0x79ce3c'),
        0x79CE88: ('ret', ''),
    }
    if any(instructions.get(address) != expected
           for address, expected in required.items()):
        raise ValueError('Pinned route instructions differ')

    adapter_path = decoded / 'jsb-adapter.jsb-engine.js'
    adapter = adapter_path.read_bytes()
    if RECOVERY.digest(adapter) != '9b77fb4784c741c723c3c4512f3c9b606b48e951e5260b1be2a0e3db8a8cafd2':
        raise ValueError('Recovered original adapter hash differs')
    adapter_evidence = []
    for token in (b"require('./jsb-dragonbones.js');",
                  b'"./jsb-dragonbones.js":undefined'):
        if adapter.count(token) != 1:
            raise ValueError('Original adapter request/map is not unique')
        start = adapter.index(token)
        adapter_evidence.append({'byteStart': start,
                                 'byteEndExclusive': start + len(token),
                                 'line': adapter[:start].count(b'\n') + 1,
                                 'text': token.decode('ascii')})
    log = options.runtime_log.read_bytes()
    log_evidence = []
    for number, line in enumerate(log.splitlines(), 1):
        if REQUEST.encode() in line or b'[ALLOY2581_SCENE_LAUNCHED] SceneMain' in line:
            log_evidence.append({'line': number, 'text': line.decode('utf-8')})
    if not any('Required script asset is unavailable: ' + REQUEST in row['text']
               for row in log_evidence):
        raise ValueError('Runtime log lacks the assigned exact request')

    evidence_bytes = ('\n'.join(asm) + '\n').encode('ascii')
    record = {
        'schemaVersion': 1, 'versionCode': 2581,
        'status': 'original-native-route-empty-no-script-recovered',
        'requestedPath': REQUEST,
        'sourceApk': str(options.apk), 'sourceEntry': RECOVERY.NATIVE_ENTRY,
        'sourceNativeBytes': len(data), 'sourceNativeSha256': EXPECTED_NATIVE,
        'scriptOutput': None, 'scriptOutputBytes': None, 'scriptOutputSha256': None,
        'routeReturnedBytes': 0, 'routeReturnedSha256': RECOVERY.digest(b''),
        'emptyFileCreated': False, 'decodedCandidates': [], 'apkMemberCandidates': candidates,
        'loader': {
            'callbackAddress': '0x79c330', 'extensionStripped': True,
            'finalSevenBytes': basename[-7:], 'hash': value, 'modulo100': remainder,
            'formula': 'sum(finalSevenBytes[i] * 8**i for i in range(7))',
            'jumpTableAddress': '0x15f2a96', 'jumpTableBytes': len(jump_raw),
            'jumpTableSha256': RECOVERY.digest(jump_raw),
            'jumpTableRangeInclusive': [33, 72],
            'jumpTableEntries': list(table), 'selectedJumpTableEntry': None,
            'selectedJumpTableTarget': None, 'additionalRecognizedRemainders': [74, 79],
            'route': ['0x79c55c -> 0x79c664 (83 outside 33..72)',
                      '0x79c668 not taken (83 != 79)',
                      '0x79c670 -> 0x79cafc (83 != 74)',
                      '0x79cb08 -> 0x6cc440 (construct std::string from NUL)',
                      '0x79cb0c -> 0x79ce3c -> cleanup -> 0x79ce88 ret'],
            'emptyStringAddress': '0x1636f19',
            'emptyStringFileOffset': hex(file_offset(native, 0x1636F19)),
            'emptyStringTerminatorByte': '00', 'constructorImport': constructor,
            'ordinaryFileFallbackOnSelectedRoute': False,
            'keyEmptyAlternative': '0x79c650 also constructs the same empty string',
        },
        'nativeCodeRanges': ranges,
        'evidence': {'output': 'evidence/native-dragonbones-route.asm',
                     'bytes': len(evidence_bytes), 'sha256': RECOVERY.digest(evidence_bytes)},
        'originalAdapter': {'path': adapter_path.relative_to(ROOT).as_posix(),
                            'bytes': len(adapter), 'sha256': RECOVERY.digest(adapter),
                            'requestAndUnbundledMapping': adapter_evidence},
        'runtimeEvidence': {'path': str(options.runtime_log), 'bytes': len(log),
                            'sha256': RECOVERY.digest(log), 'observations': log_evidence},
        'conclusion': 'Pinned original native read-string route returns zero bytes for this path; '
                      'no matching APK member or already-decoded script exists. '
                      'Do not synthesize an empty file or substitute an official-version script.',
        'limits': 'This is static source-route evidence and an existing host runtime request, '
                  'not a run of the original callback or proof of gameplay/animation success.',
        'originalJsExecuted': False, 'originalElfExecuted': False,
        'keyValuesLogged': False, 'servicesContacted': False,
    }
    RECOVERY.save(OUT / 'evidence/native-dragonbones-route.asm', evidence_bytes)
    RECOVERY.save(OUT / 'manifest.json',
                  (json.dumps(record, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    print(json.dumps({'status': record['status'], 'requestedPath': REQUEST,
                      'routeReturnedBytes': 0, 'sourceNativeSha256': EXPECTED_NATIVE,
                      'scriptOutput': None}))


if __name__ == '__main__':
    main()
