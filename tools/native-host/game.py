import argparse
import hashlib
import json
from pathlib import PurePosixPath
import sys
import zipfile

from probe import PROJECT, build

BASE = PROJECT / 'reports/private/reconstruction/2581'


def runtime_assets():
    manifest = json.loads((BASE / 'runtime-assets/source-manifest.json').read_text(encoding='utf-8'))
    source_apk = PROJECT.parents[1] / 'games/合金机兵.apk'
    with source_apk.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != manifest['apk']['sha256']:
            raise RuntimeError('Pinned source APK identity mismatch')
    directory = PROJECT / manifest['packageAssetsDirectory']
    result = {}
    with zipfile.ZipFile(source_apk) as archive:
        for member in manifest['sourceMembers']:
            info = archive.getinfo(member['member'])
            data = archive.read(info)
            if (info.file_size != member['rawBytes'] or f'{info.CRC:08x}' != member['zipCrc32'] or
                    hashlib.sha256(data).hexdigest() != member['rawSha256']):
                raise RuntimeError(f'Original ZIP member mismatch: {member["member"]}')
        for entry in manifest['files']:
            name = entry['runtimePath']
            path = PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts or name in result:
                raise RuntimeError(f'Invalid or duplicate runtime path: {name}')
            source = directory / path
            if source.stat().st_size != entry['bytes']:
                raise RuntimeError(f'Runtime asset length mismatch: {name}')
            with source.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != entry['sha256']:
                    raise RuntimeError(f'Runtime asset identity mismatch: {name}')
            if entry['transformation'].startswith('none;'):
                if archive.read(entry['sourceMembers'][0]) != source.read_bytes():
                    raise RuntimeError(f'Untransformed runtime asset differs from original: {name}')
            result[name] = source
    for path in sorted((PROJECT / 'native-host/js').glob('*.js')):
        name = 'alloy/' + path.name
        if name in result:
            raise RuntimeError(f'Project entry collides with original asset: {name}')
        result[name] = path
    if 'alloy/bootstrap.js' not in result or 'alloy/local-mode.js' not in result:
        raise RuntimeError('The real game entry and local-mode integration are required')
    return result


def main():
    parser = argparse.ArgumentParser(description='Build the source-verified original-scene development package; not a final release.')
    parser.add_argument('--abi', choices=['arm64-v8a', 'x86'], default='arm64-v8a')
    args = parser.parse_args()
    build(args.abi, package='org.stormcaravan.alloy2581', label='合金机兵2581独立复刻（开发中）',
          output_group='native-game-development', artifact_kind='original-scene-integration-development-NOT-FINAL',
          assets=runtime_assets())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
