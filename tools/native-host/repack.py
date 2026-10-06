import argparse
import copy
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import uuid
import zipfile

from probe import PROJECT, WORKSPACE, BUILD_TOOLS, JDK, ENGINES, runtime_asset_compression


def copy_runtime_entry(incoming, raw, outgoing, info):
    if info.flag_bits & 8 or info.file_size >= 0xffffffff or info.compress_size >= 0xffffffff:
        raise RuntimeError('Unsupported raw APK entry encoding')
    raw.seek(info.header_offset)
    header = raw.read(30)
    if header[:4] != b'PK\x03\x04':
        raise RuntimeError('Invalid local ZIP entry header')
    if (info.filename.startswith('assets/') and
            runtime_asset_compression(info.filename) == zipfile.ZIP_STORED and
            info.compress_type != zipfile.ZIP_STORED):
        data = incoming.read(info)
        outgoing.writestr(copy.copy(info), data, compress_type=zipfile.ZIP_STORED)
        return {'previousCompressionMethod': info.compress_type, 'compressionMethod': zipfile.ZIP_STORED,
                'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    name_length, extra_length = struct.unpack_from('<HH', header, 26)
    count = 30 + name_length + extra_length + info.compress_size
    raw.seek(info.header_offset)
    entry = copy.copy(info)
    entry.header_offset = outgoing.fp.tell()
    while count:
        block = raw.read(min(count, 2 * 1024 * 1024))
        if not block:
            raise RuntimeError('Incomplete raw APK entry read')
        outgoing.fp.write(block)
        count -= len(block)
    outgoing.filelist.append(entry)
    outgoing.NameToInfo[entry.filename] = entry
    outgoing.start_dir = outgoing.fp.tell()
    return None


def main():
    parser = argparse.ArgumentParser(description='Repack project JS, normalize native audio FD storage, and optionally its rebuilt host in a verified independent development APK; never an original APK or final release.')
    parser.add_argument('build_report', type=Path)
    parser.add_argument('--update-driver', action='store_true', help='Use only the configured, rebuilt independent host library for the existing ABI')
    args = parser.parse_args()
    original = json.loads(args.build_report.read_text(encoding='utf-8'))
    if (original['kind'] != 'original-scene-integration-development-NOT-FINAL' or
            original['package'] != 'org.stormcaravan.alloy2581' or original['productionSigningCredentialUsed']):
        raise RuntimeError('Only the independently built development package is accepted')
    source = Path(original['apk'])
    with source.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != original['apkSHA256']:
            raise RuntimeError('Development source APK identity mismatch')
    output = WORKSPACE / '05-builds/storm-caravan/native-game-development' / uuid.uuid4().hex[:12]
    output.mkdir(parents=True)
    replacements = {'assets/alloy/' + path.name: path for path in (PROJECT / 'native-host/js').glob('*.js')}
    if args.update_driver:
        driver = ENGINES[original['abi']][2]
        if not driver.is_file():
            raise RuntimeError('Rebuild the independent native host before updating its driver')
        replacements[f'lib/{original["abi"]}/liballoy2581.so'] = driver
    unsigned = output / 'host-unsigned.apk'
    hashes = {}
    audio_repairs = {}
    # Reuse compressed entry bytes except MP3s needing uncompressed Android audio FD access.
    # Reject data-descriptor/ZIP64 input rather than guessing its raw record length.
    with zipfile.ZipFile(source) as incoming, source.open('rb') as raw, zipfile.ZipFile(unsigned, 'w') as outgoing:
        if len(incoming.namelist()) != len(set(incoming.namelist())):
            raise RuntimeError('Duplicate input APK entries are not permitted')
        for info in incoming.infolist():
            if info.filename in replacements or info.filename.startswith('META-INF/'):
                continue
            repair = copy_runtime_entry(incoming, raw, outgoing, info)
            if repair:
                audio_repairs[info.filename] = repair
        for name, path in sorted(replacements.items()):
            data = path.read_bytes()
            outgoing.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=1)
            hashes[name] = hashlib.sha256(data).hexdigest()
    with zipfile.ZipFile(unsigned) as archive:
        if archive.testzip() is not None:
            raise RuntimeError('Repacked ZIP CRC verification failed')
        runtime_count = sum(name.startswith('assets/') and not name.startswith('assets/third-party-licenses/')
                            for name in archive.namelist())
    commands = []

    def run(arguments):
        result = subprocess.run([str(value) for value in arguments], cwd=PROJECT, capture_output=True,
                                text=True, encoding='utf-8', errors='backslashreplace')
        commands.append({'executable': str(arguments[0]), 'exitCode': result.returncode,
                         'stdout': result.stdout, 'stderr': result.stderr})
        (output / 'commands.json').write_text(json.dumps(commands, ensure_ascii=False, indent=2), encoding='utf-8')
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)

    aligned = output / 'host-aligned.apk'
    run([BUILD_TOOLS / 'zipalign.exe', '-f', '-p', '4', unsigned, aligned])
    target = output / f'alloy2581-native-game-development-{original["abi"]}.apk'
    debug_store = WORKSPACE / '05-builds/storm-caravan/native-host-probe/debug-test-only.p12'
    run([JDK / 'bin/java.exe', '-jar', BUILD_TOOLS / 'lib/apksigner.jar', 'sign', '--ks', debug_store,
         '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
         '--out', target, aligned])
    run([JDK / 'bin/java.exe', '-jar', BUILD_TOOLS / 'lib/apksigner.jar', 'verify', '--verbose', target])
    report = dict(original, apk=str(target), apkSHA256=hashlib.sha256(target.read_bytes()).hexdigest(),
                  parentBuildReport=str(args.build_report), parentAPK_SHA256=original['apkSHA256'],
                  replacedProjectScripts={name: value for name, value in hashes.items() if name.startswith('assets/alloy/')},
                  driverSHA256=hashes.get(f'lib/{original["abi"]}/liballoy2581.so', original['driverSHA256']),
                  independentDriverUpdated=args.update_driver, runtimeAssets=runtime_count,
                  deviceRun='not-yet-verified', resourceCompressedBytesReused=not audio_repairs,
                  unchangedNonAudioCompressedBytesReused=True, nativeAudioStorageRepairs=len(audio_repairs))
    report.pop('audioStorageRepairReport', None)
    if audio_repairs:
        audio_report = output / 'audio-storage-repairs.json'
        audio_report.write_text(json.dumps(audio_repairs, ensure_ascii=False, indent=2), encoding='utf-8')
        report['audioStorageRepairReport'] = str(audio_report)
    (output / 'build.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
