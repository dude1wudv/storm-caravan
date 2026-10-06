"""Static 2581 SkeletonExt/normal-JSB audit; no original JS/native execution."""
import argparse
import json
from pathlib import Path
import struct
import zipfile
from recover import Native, NATIVE_ENTRY, digest, save
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM, CS_ARCH_X86, CS_MODE_32


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apk', required=True, type=Path)
    parser.add_argument('--root', required=True, type=Path)
    args = parser.parse_args()
    root = args.root
    requested = 'assets/develop/tool/SkeletonExt.js'
    settings = json.loads((root / 'settings.json').read_text(encoding='utf-8'))
    if settings['jsList'] != [requested]:
        raise ValueError('Wrong pinned jsList')
    interfaces = json.loads((root / 'startup-interfaces.json').read_text(encoding='utf-8'))
    with zipfile.ZipFile(args.apk) as apk:
        native = Native(apk.read(NATIVE_ENTRY))
        x86_entry = 'lib/x86/libcocos2djs.so'
        x86 = Native(apk.read(x86_entry))
        if digest(native.data) != 'e644052a3b365533bb1bd3d9952a21a99cdf58fe6a98561801146a528393d24a':
            raise ValueError('Wrong original arm64 source')
        members = apk.namelist()
        probes = [requested, 'src/' + requested, 'assets/' + requested, 'assets/src/' + requested]
        exact = [p for p in probes if p in members]
        skeleton = [p for p in members if 'skeleton' in p.lower()]
        suffix = [p for p in members if p.lower().replace('\\', '/').endswith(('skeletonext.js', 'skeletonext.jsc'))]
        folded = sum(ord(c) * 8 ** i for i, c in enumerate('SkeletonExt'[-7:]))
        table_bytes = native.raw(0x15f2a96, 80)
        table = struct.unpack('<40H', table_bytes)
        modulo = folded % 100
        branch = 0x79c578 + 4 * table[modulo - 33]
        if (folded, modulo, branch) != (34687941, 41, 0x79c664):
            raise ValueError('Unexpected original route')
        if native.string(0x1636f19) != b'':
            raise ValueError('Default string pointer not empty')
        arm = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
        x86_dis = Cs(CS_ARCH_X86, CS_MODE_32)
        code_ranges = [(NATIVE_ENTRY, native, arm, 0x79c664, 16), (NATIVE_ENTRY, native, arm, 0x79cafc, 20), (x86_entry, x86, x86_dis, 0x67dc80, 226)]
        assembly, blocks = [], []
        for entry, image, decoder, address, length in code_ranges:
            data = image.raw(address, length)
            assembly.append(f'; {entry} VA {address:#x}; sha256 {digest(data)}')
            assembly.extend(f'{ins.address:08x}: {ins.mnemonic} {ins.op_str}' for ins in decoder.disasm(data, address))
            blocks.append({'sourceEntry': entry, 'sourceSha256': digest(image.data), 'virtualAddress': hex(address), 'byteLength': length, 'rangeSha256': digest(data)})
        assembly_path = 'evidence/skeleton-normal-jsb-route.asm'
        save(root / assembly_path, ('\n'.join(assembly) + '\n').encode())
        index = json.loads((root / 'module-index.json').read_text(encoding='utf-8'))
        scans = []
        for name in ['decoded/main.expanded.js', 'decoded/resources.expanded.js', 'decoded/src.cocos2d-jsb.js', 'decoded/jsb-adapter.jsb-engine.js', 'decoded/jsb-adapter.jsb-builtin.js']:
            data = (root / name).read_bytes()
            scans.append({'source': name, 'sha256': digest(data), 'bytes': len(data), 'caseInsensitiveSkeletonExtOccurrences': data.lower().count(b'skeletonext')})
        associations = []
        for bundle in index['bundles']:
            text = (root / bundle['expanded']).read_text(encoding='utf-8')
            for module in bundle['modules']:
                if module['name'] == 'SpineWatch':
                    raw = text.encode('utf-16-le')[module['start'] * 2:module['end'] * 2].decode('utf-16-le').encode()
                    if digest(raw) != module['sha256']:
                        raise ValueError('SpineWatch range hash mismatch')
                    start = len(text.encode('utf-16-le')[:module['start'] * 2].decode('utf-16-le').encode())
                    associations.append({'module': bundle['bundle'] + ':' + module['name'], 'source': bundle['expanded'], 'sourceSha256': bundle['outputHash'], 'byteRange': [start, start + len(raw)], 'rangeSha256': digest(raw), 'dependencies': module['dependencies'], 'association': 'Editor:false component uses stock sp.Skeleton; no require/reference to SkeletonExt. This is a consumer of the normal engine class, not the missing extension source.'})
        output = {
            'schemaVersion': 1, 'versionCode': 2581, 'requestedPath': requested,
            'actualBootRequest': 'src/' + requested,
            'settingsSource': 'decoded/src.settings.js', 'settingsSourceSha256': digest((root / 'decoded/src.settings.js').read_bytes()),
            'apkSource': str(args.apk), 'apkDirectoryMemberCount': len(members),
            'apkDirectorySha256': digest(('\n'.join(members) + '\n').encode()),
            'apkSearch': {'exactProbes': probes, 'exactMatches': exact, 'caseInsensitiveSkeletonNameMatches': skeleton, 'slashNormalizedJsOrJscSuffixMatches': suffix},
            'originalRoute': {'sourceEntry': NATIVE_ENTRY, 'sourceSha256': digest(native.data), 'stemSuffix': 'etonExt', 'foldedHash': folded, 'modulo100': modulo, 'jumpTable': {'virtualAddress': '0x15f2a96', 'byteLength': 80, 'sha256': digest(table_bytes)}, 'branchVirtualAddress': hex(branch), 'branchFlow': '0x79c664 cmp modulo79; 0x79c66c cmp modulo74; modulo41 reaches 0x79cafc; construct std::string from 0x1636f19 (verified zero-length); return via 0x79ce3c. No ordinary read-string fallback on this branch.', 'returnedBytes': 0, 'emptyLiteralSourceVirtualAddress': '0x1636f19', 'evidenceBlocks': blocks},
            'nativeExecutionBoundary': 'Original x86 ScriptEngine::runScript checks the returned string length before evalString. Zero-length follows log-error/return-false, not evaluation of an empty script. Thus an invented empty physical SkeletonExt.js is not a recovered source or proof of equivalent behavior.',
            'jsbDispatch': {'evidenceOutput': 'startup-interfaces.json', 'evidenceOutputSha256': digest((root / 'startup-interfaces.json').read_bytes()), 'functions': interfaces['loaderFunctions'], 'flow': 'Native adapter downloadScript -> download -> transformUrl: non-HTTP local path directly calls window.require(src); loadedScripts[url]=true and callback(null) follow if require returns normally. No file existence check or return-value check here.', 'unknown': 'Native global require binding return/exception behavior is not established by these ScriptEngine/adapter slices. Main agent must observe its actual behavior; no assertion that zero-length runScript alone is a successful load.'},
            'bundleAssociation': {'scannedSources': scans, 'moduleNameMatches': [bundle['bundle'] + ':' + module['name'] for bundle in index['bundles'] for module in bundle['modules'] if 'skeletonext' in module['name'].lower()], 'spineConsumer': associations, 'pr0Association': False, 'pr0Evidence': 'startup-dependency-supplement.json proves pr0 matches three independent empty bundle/index.js members, not SkeletonExt.'},
            'normalJsbStatus': 'Original settings path retained. This snapshot has no recoverable extension file/module; its normal-JSB native string route is explicitly zero-length. Do not delete the jsList completion leg or synthesize an extension.',
            'otherBranches': 'The boot jsList call is shared by browser/runtime branches, not guarded as browser-only. The existing native jsb adapter path is normal-JSB-specific. Source absence in this APK says nothing definitive about a separate web export or runtime binary; those alternative exports are not needed for this host and were not supplied.',
            'sourceFileRecovered': False, 'syntheticExtensionCreated': False,
            'originalJsExecuted': False, 'nativeOriginalExecuted': False,
            'evidenceOutput': assembly_path, 'evidenceOutputSha256': digest((root / assembly_path).read_bytes()),
        }
        save(root / 'skeleton-normal-jsb.json', (json.dumps(output, ensure_ascii=False, indent=2) + '\n').encode())
        print(json.dumps({'output': 'skeleton-normal-jsb.json', 'apkMatchingMembers': len(skeleton), 'nativeModulo': modulo, 'originalRouteBytes': 0, 'sourceFileRecovered': False, 'originalJsExecuted': False}))


if __name__ == '__main__':
    main()
