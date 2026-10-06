import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET
import zipfile

PROJECT = Path(__file__).resolve().parents[2]
WORKSPACE = PROJECT.parents[1]
SDK = WORKSPACE / 'android-sdk'
JDK = Path('C:/Program Files/Eclipse Adoptium/jdk-17.0.19.10-hotspot')
BUILD_TOOLS = SDK / 'build-tools/36.0.0'
HOST_SOURCE = PROJECT / 'reports/private/reconstruction/2581/host-recovery/official-source'
PACKAGE = 'org.stormcaravan.alloy2581.hostprobe'
ANDROID = '{http://schemas.android.com/apk/res/android}'
JARS = {
    'com.android.vending.expansion.zipfile.jar': 'bbdeb8a5ee323b89dd2cf420a348080a5a7761a6',
    'okhttp-3.12.7.jar': '0eb82665dd7a053b3a5466d768022805145abc28',
    'okio-1.15.0.jar': '4e0e47ab18ca82c74b9e8032bc8f8f146095a516',
}
ENGINES = {
    'arm64-v8a': (
        PROJECT / 'reports/private/reconstruction/2581/visual-recovery/source/libcocos2djs-arm64.so',
        'e644052a3b365533bb1bd3d9952a21a99cdf58fe6a98561801146a528393d24a',
        WORKSPACE / '05-builds/storm-caravan/native-host-arm64/liballoy2581.so',
    ),
    'x86': (
        WORKSPACE / '04-assets/storm-caravan/diagnostics/libcocos2djs-public-image.so',
        'e77de4f8d9dfca64d85d5f4438f973cad51162d6aef934afab6728b17bed6a5f',
        WORKSPACE / '05-builds/storm-caravan/native-host-x86/liballoy2581.so',
    ),
}


def runtime_asset_compression(name):
    # Android native audio opens an asset FD; compressed MP3 members cannot provide one.
    return zipfile.ZIP_STORED if Path(name).suffix.lower() == '.mp3' else zipfile.ZIP_DEFLATED


def build(abi, *, package, label, output_group, artifact_kind, assets):
    if abi not in ENGINES:
        raise ValueError(f'Unsupported host ABI: {abi}')
    engine, expected_engine_hash, driver = ENGINES[abi]
    if hashlib.sha256(engine.read_bytes()).hexdigest() != expected_engine_hash:
        raise RuntimeError('Original engine source identity mismatch')
    if not driver.is_file():
        raise RuntimeError('Build the independent native host before running this probe')
    builtin = PROJECT / 'reports/private/reconstruction/2581/client-recovery/decoded/jsb-adapter.jsb-builtin.js'
    if hashlib.sha256(builtin.read_bytes()).hexdigest() != 'f845c6c9f6c2e1bfdd0820f92e84d916cc246699d0421091842a7ea701309f67':
        raise RuntimeError('Original JSB builtin identity mismatch')
    jar_paths = []
    for name, expected_blob in JARS.items():
        path = PROJECT / 'native-host/java-libs' / name
        data = path.read_bytes()
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if blob != expected_blob:
            raise RuntimeError(f'Original official dependency identity mismatch: {name}')
        with zipfile.ZipFile(path) as jar:
            if jar.testzip() is not None:
                raise RuntimeError(f'Invalid dependency archive: {name}')
        jar_paths.append(path)
    output = WORKSPACE / '05-builds/storm-caravan' / output_group / uuid.uuid4().hex[:12]
    output.mkdir(parents=True)
    commands = []
    environment = os.environ.copy()
    environment['JAVA_HOME'] = str(JDK)
    environment['PATH'] = str(JDK / 'bin') + os.pathsep + environment['PATH']

    def run(arguments):
        result = subprocess.run([str(value) for value in arguments], cwd=PROJECT,
                                env=environment, capture_output=True, text=True,
                                encoding='utf-8', errors='backslashreplace')
        commands.append({'executable': str(arguments[0]), 'exitCode': result.returncode,
                         'stdout': result.stdout, 'stderr': result.stderr})
        (output / 'commands.json').write_text(json.dumps(commands, ensure_ascii=False, indent=2), encoding='utf-8')
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout or 'Native host build command failed')
        return result.stdout

    manifest = ET.parse(PROJECT / 'native-host/AndroidManifest.xml')
    manifest.getroot().set('package', package)
    manifest.getroot().find('application').set(ANDROID + 'label', label)
    manifest_path = output / 'AndroidManifest.xml'
    ET.register_namespace('android', ANDROID[1:-1])
    manifest.write(manifest_path, encoding='utf-8', xml_declaration=True)
    generated, classes, dex = (output / name for name in ('generated', 'classes', 'dex'))
    for directory in (generated, classes, dex):
        directory.mkdir()
    unsigned = output / 'host-unsigned.apk'
    platform = SDK / 'platforms/android-36/android.jar'
    run([BUILD_TOOLS / 'aapt.exe', 'package', '-f', '-M', manifest_path,
         '-S', PROJECT / 'native-host/res', '-I', platform, '-F', unsigned,
         '-J', generated, '--custom-package', 'org.cocos2dx.lib'])
    java_sources = sorted((HOST_SOURCE / 'cocos/platform/android/java/src/org/cocos2dx/lib').glob('*.java'))
    java_sources += sorted((PROJECT / 'native-host/java').rglob('*.java'))
    java_sources += sorted(generated.rglob('*.java'))
    run([JDK / 'bin/javac.exe', '-encoding', 'UTF-8', '--release', '8',
         '-classpath', os.pathsep.join(str(path) for path in [platform] + jar_paths),
         '-d', classes] + java_sources)
    classes_jar = output / 'classes.jar'
    with zipfile.ZipFile(classes_jar, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(classes.rglob('*.class')):
            archive.write(path, path.relative_to(classes).as_posix())
    run([JDK / 'bin/java.exe', '-cp', BUILD_TOOLS / 'lib/d8.jar', 'com.android.tools.r8.D8',
         '--lib', platform, '--min-api', '21', '--output', dex, classes_jar] + jar_paths)
    with zipfile.ZipFile(unsigned, 'a', zipfile.ZIP_DEFLATED) as archive:
        archive.write(engine, f'lib/{abi}/libcocos2djs.so')
        archive.write(driver, f'lib/{abi}/liballoy2581.so')
        if 'jsb-adapter/jsb-builtin.js' not in assets:
            assets = dict(assets, **{'jsb-adapter/jsb-builtin.js': builtin})
        if 'alloy/bootstrap.js' not in assets:
            raise RuntimeError('The independent host requires a real bootstrap entry')
        for name, path in sorted(assets.items()):
            if name.startswith('/') or '\\' in name or any(part in ('', '.', '..') for part in name.split('/')):
                raise RuntimeError(f'Unsafe runtime asset path: {name}')
            archive.write(path, 'assets/' + name, compress_type=runtime_asset_compression(name))
        for path in sorted(dex.glob('*.dex')):
            archive.write(path, path.name)
        members = set(archive.namelist())
        for jar_path in jar_paths:
            with zipfile.ZipFile(jar_path) as jar:
                for name in jar.namelist():
                    if name.endswith('/') or name.endswith('.class') or name == 'META-INF/MANIFEST.MF':
                        continue
                    if name in members:
                        raise RuntimeError(f'Duplicate dependency resource: {name}')
                    archive.writestr(name, jar.read(name))
                    members.add(name)
        for path in sorted((PROJECT / 'native-host/java-libs/licenses').glob('*')):
            if path.is_file():
                archive.write(path, 'assets/third-party-licenses/' + path.name)
    aligned = output / 'host-aligned.apk'
    run([BUILD_TOOLS / 'zipalign.exe', '-f', '-p', '4', unsigned, aligned])
    debug_store = WORKSPACE / '05-builds/storm-caravan/native-host-probe/debug-test-only.p12'
    if not debug_store.exists():
        run([JDK / 'bin/keytool.exe', '-genkeypair', '-keystore', debug_store,
             '-storetype', 'PKCS12', '-alias', 'androiddebugkey', '-storepass', 'android',
             '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650',
             '-dname', 'CN=Android Debug,O=Android,C=US'])
    target = output / f'alloy2581-{output_group}-{abi}.apk'
    run([JDK / 'bin/java.exe', '-jar', BUILD_TOOLS / 'lib/apksigner.jar', 'sign',
         '--ks', debug_store, '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android',
         '--key-pass', 'pass:android', '--out', target, aligned])
    run([JDK / 'bin/java.exe', '-jar', BUILD_TOOLS / 'lib/apksigner.jar', 'verify', '--verbose', target])
    report = {'kind': artifact_kind, 'package': package,
              'abi': abi, 'apk': str(target), 'apkSHA256': hashlib.sha256(target.read_bytes()).hexdigest(),
              'engineSHA256': expected_engine_hash, 'driverSHA256': hashlib.sha256(driver.read_bytes()).hexdigest(),
              'javaSources': len(java_sources), 'runtimeAssets': len(assets), 'deviceRun': 'not-yet-verified',
              'productionSigningCredentialUsed': False, 'sourceAPKModified': False}
    (output / 'build.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def main():
    parser = argparse.ArgumentParser(description='Build an isolated real-JNI/GL probe. Not a game or final artifact.')
    parser.add_argument('--abi', choices=tuple(ENGINES), default='arm64-v8a')
    args = parser.parse_args()
    build(args.abi, package=PACKAGE, label='Alloy2581宿主诊断（非游戏）',
          output_group='native-host-probe', artifact_kind='independent-native-host-probe-NOT-A-GAME',
          assets={'alloy/bootstrap.js': PROJECT / 'tests/fixtures/native-host/probe.js'})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
