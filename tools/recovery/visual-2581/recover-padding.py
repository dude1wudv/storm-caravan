"""Recover only previously unsupported standard ETC1 padding, using original dimension getters."""
import argparse
import json
from pathlib import Path
import zipfile

import recover


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk', required=True, type=Path)
    args = parser.parse_args()
    root = recover.ROOT
    previous_path = root / 'reports/private/reconstruction/2581/visual-recovery/all-1026/manifest.json'
    previous = json.loads(previous_path.read_text(encoding='utf-8'))
    manifest = json.loads((root / 'assets/manifests/original-assets.json').read_text(encoding='utf-8'))
    assets = {row['uuid']: row for row in manifest['assets']}
    recover.OUT = root / 'reports/private/reconstruction/2581/visual-recovery/padded-1026'
    if (recover.OUT / 'manifest.json').exists():
        raise ValueError('Padding recovery already recorded; verify existing result instead of re-decoding')
    records = []
    failures = []
    total_bytes = 0
    with zipfile.ZipFile(args.apk) as archive:
        x86 = archive.read('lib/x86/libcocos2djs.so')
        arm64 = archive.read('lib/arm64-v8a/libcocos2djs.so')
        if recover.digest(x86) != recover.X86_SHA256 or recover.digest(arm64) != recover.ARM64_SHA256:
            raise ValueError('Original engine baseline mismatch')
        state, branch = recover.validated_native_state(x86, arm64)
        shader = previous['textures'][0]['alphaEvidence']
        if recover.digest(archive.read(shader['apkMember'])) != shader['sha256']:
            raise ValueError('Original alpha shader baseline mismatch')
        for failed in previous['failures']:
            asset = assets[failed['uuid']]
            descriptor = json.loads((root / asset['descriptor']['path']).read_text(encoding='utf-8'))
            if descriptor['serialized'] != json.loads(archive.read(asset['importEntry'])):
                raise ValueError('Original texture descriptor does not match preserved source')
            try:
                _, record = recover.decode_texture(archive, asset, shader, state, 100_000_000 - total_bytes)
                records.append(record)
                total_bytes += record['output']['bytes']
            except ValueError as error:
                failures.append({'uuid': failed['uuid'], 'reason': str(error)})
    result = {
        'schemaVersion': 1, 'baseline': 2581, 'sourceApkSha256': recover.APK_SHA256,
        'selection': 'Only failed geometry entries of previous all-1026 manifest',
        'previousManifestSha256': recover.digest(previous_path.read_bytes()),
        'dimensionEvidence': {
            'source': 'lib/x86/libcocos2djs.so', 'sha256': recover.X86_SHA256,
            'validator': 'etc1_pkm_is_valid at 0x7135e0 accepts encoded-logical difference 0..3',
            'widthGetter': 'etc1_pkm_get_width at 0x713670 reads big-endian bytes 12..13',
            'heightGetter': 'etc1_pkm_get_height at 0x713690 reads big-endian bytes 14..15',
            'consumer': 'Image::initWithETCData calls both logical dimension getters',
            'disassembly': [
                'reports/private/reconstruction/2581/runtime-analysis/etc-dimensions.asm',
                'reports/private/reconstruction/2581/runtime-analysis/image-etc-dimensions.asm'
            ],
            'operation': 'Decode complete padded blocks, crop RGB and alpha planes to original logical dimensions; no guessed padding'
        },
        'nativeBranch': branch, 'textures': records, 'failures': failures,
        'outputBytes': total_bytes,
        'limits': ['No original screenshot or native gameplay comparison', 'No animation frames or original rejected files restored']
    }
    recover.save('manifest.json', (json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    print(json.dumps({'recovered': len(records), 'failed': len(failures), 'bytes': total_bytes}))


if __name__ == '__main__':
    main()
