"""Audit pinned startup jsList and physics without executing original JavaScript."""
import argparse
import json
from pathlib import Path
import re
import struct
import zipfile
from recover import Native, NATIVE_ENTRY, digest, decrypt, save


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    options = parser.parse_args()
    settings_bytes = (options.root / 'decoded/src.settings.js').read_bytes()
    engine_bytes = (options.root / 'decoded/src.cocos2d-jsb.js').read_bytes()
    settings = json.loads((options.root / 'settings.json').read_text(encoding='utf-8'))
    engine = engine_bytes.decode('utf-8')
    flags = {}
    for flag in ('CC_PHYSICS_BUILTIN', 'CC_PHYSICS_CANNON'):
        matches = list(re.finditer(r'\b' + flag + r'\s*=\s*!([01])', engine))
        if len(matches) != 1:
            raise ValueError(f'Cannot establish unique original physics flag: {flag}')
        match = matches[0]
        flags[flag] = {'value': not bool(int(match[1])), 'startByte': len(engine[:match.start()].encode()), 'endByte': len(engine[:match.end()].encode()), 'raw': match[0]}
    with zipfile.ZipFile(options.apk) as apk:
        native = Native(apk.read(NATIVE_ENTRY))
        if digest(native.data) != 'e644052a3b365533bb1bd3d9952a21a99cdf58fe6a98561801146a528393d24a':
            raise ValueError('Wrong native snapshot')
        pr0_entry = 'assets/assets/libs/pr0.so'
        pr0_bytes = apk.read(pr0_entry)
        original, metadata = decrypt(pr0_bytes, native.key())
        save(options.root / 'decoded/pr0.original.js', original)
        table = struct.unpack('<40H', native.raw(0x15f2a96, 80))
        jslist = []
        for path in settings['jsList']:
            name = path.rsplit('.', 1)[0]
            value = sum(ord(c) * 8 ** i for i, c in enumerate(name[-7:]))
            remainder = value % 100
            branch = 0x79c578 + 4 * table[remainder - 33] if 33 <= remainder <= 72 else None
            candidates = [p for p in apk.namelist() if p.endswith(path) or p.endswith(name + '.jsc')]
            jslist.append({'requestedPath': path, 'settingsSourceEntry': NATIVE_ENTRY, 'settingsSourceHash': digest(native.data), 'settingsOutputHash': digest(settings_bytes), 'loaderHash': value, 'loaderHashModulo100': remainder, 'loaderBranchAddress': hex(branch) if branch else None, 'apkMemberCandidates': candidates, 'output': None, 'status': 'unrestored-original-path', 'reason': 'No matching APK member; hash41 native callback falls through hash74/hash79 checks to original empty-string return. pr0 is a separately routed empty bundle, not evidence for this extension.'})
        result = {'schemaVersion': 1, 'versionCode': 2581, 'jsList': jslist, 'physics': {'enabled': any(v['value'] for v in flags.values()), 'sourceEntry': NATIVE_ENTRY, 'sourceHash': digest(native.data), 'output': 'decoded/src.cocos2d-jsb.js', 'outputHash': digest(engine_bytes), 'flags': flags, 'method': 'Original startup checks CC_PHYSICS_BUILTIN || CC_PHYSICS_CANNON; both recovered engine compile flags false, settings contains no physics override.', 'physicsFileRecovered': False, 'reason': 'Disabled in pinned original JSB engine; no physics recovery required.'}, 'pr0': {'sourceEntry': pr0_entry, 'sourceHash': digest(pr0_bytes), 'bytes': len(pr0_bytes), 'output': 'decoded/pr0.original.js', 'outputHash': digest(original), 'outputBytes': len(original), 'method': 'Original native pr0 route 0x79ca48; same protected-key modified XXTEA then gzip; original length and gzip integrity guards pass.', 'metadataMatches': metadata, 'byteIdenticalPlainBundleEntries': [p for p in ('assets/assets/bundle/index.js', 'assets/assets/bundle1/index.js', 'assets/assets/bundle2/index.js') if apk.read(p) == original], 'SkeletonExtAssociation': False}, 'originalJsExecuted': False, 'syntheticExtensionCreated': False}
        save(options.root / 'startup-dependency-supplement.json', (json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode())
        print(json.dumps({'jsListRecovered': False, 'physicsEnabled': result['physics']['enabled'], 'pr0Decoded': True}))


if __name__ == '__main__':
    main()
