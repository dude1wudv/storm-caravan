"""Preserve the 2581 local Cocos closure; never execute original JavaScript."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import struct
import zipfile

APK_SHA256 = 'd660393138d25d6419bc814e1662a3b693cb0a7cc973e3759b5e840271146e63'
NATIVE_MEMBER = 'lib/arm64-v8a/libcocos2djs.so'
NATIVE_SHA256 = 'e644052a3b365533bb1bd3d9952a21a99cdf58fe6a98561801146a528393d24a'
BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save_new_or_identical(path, data):
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError(f'Existing output differs: {path.name}')
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as output:
        output.write(data)


def save_json(path, value):
    save_new_or_identical(path, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode())


def decode_uuid(value):
    # Same original public UUID format as tools/assets/original-formats.mjs.
    base, *suffix = value.split('@')
    if re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', base):
        return value
    if not re.fullmatch(r'[0-9a-fA-F]{2}[A-Za-z0-9+/]{20}', base):
        raise ValueError('Unsupported original Cocos UUID format')
    hex_value = base[:2] + ''.join(f'{BASE64.index(base[i]) * 64 + BASE64.index(base[i + 1]):03x}' for i in range(2, 22, 2))
    uuid = '-'.join((hex_value[:8], hex_value[8:12], hex_value[12:16], hex_value[16:20], hex_value[20:]))
    return uuid + ('@' + '@'.join(suffix) if suffix else '')


def public_document(raw):
    if not isinstance(raw, list) or len(raw) != 11 or raw[0] != 1:
        raise ValueError('Unsupported original compact import format')
    references = [decode_uuid(value) for value in raw[1]] if isinstance(raw[1], list) else []
    classes, masks, instances = raw[3:6]
    if isinstance(classes[0], str):
        return references, [{'__type__': classes[0], 'value': instances}]
    objects = []
    for instance in instances:
        if not isinstance(instance, list) or not instance or not isinstance(instance[0], int):
            continue
        mask = masks[instance[0]]
        cls = classes[mask[0]]
        if not isinstance(cls, list):
            continue
        objects.append({'__type__': cls[0], **{cls[1][mask[i]]: instance[i] for i in range(1, len(instance))}})
    return references, objects


def native_raw(data, address, size):
    if data[:5] != b'\x7fELF\x02':
        raise ValueError('Expected original ELF64 native source')
    offset = struct.unpack_from('<Q', data, 32)[0]
    entry_size, count = struct.unpack_from('<HH', data, 54)
    for index in range(count):
        kind, _, file_offset, virtual_address, _, file_size, _, _ = struct.unpack_from('<IIQQQQQQ', data, offset + index * entry_size)
        if kind == 1 and virtual_address <= address and address + size <= virtual_address + file_size:
            start = file_offset + address - virtual_address
            return data[start:start + size]
    raise ValueError('Native evidence range is not file-backed')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    root = args.root.resolve()
    private = root / 'reports/private/reconstruction/2581'
    recovery = private / 'client-recovery'
    output = private / 'runtime-assets'
    package = output / 'package-assets'
    with args.apk.open('rb') as source:
        if hashlib.file_digest(source, 'sha256').hexdigest() != APK_SHA256:
            raise ValueError('APK identity does not match authorized snapshot')
    client_manifest = json.loads((recovery / 'manifest.json').read_text(encoding='utf-8'))
    builtin = json.loads((recovery / 'builtin-supplement.json').read_text(encoding='utf-8'))
    supplement = json.loads((recovery / 'startup-dependency-supplement.json').read_text(encoding='utf-8'))
    settings = json.loads((recovery / 'settings.json').read_text(encoding='utf-8'))
    interfaces = json.loads((recovery / 'startup-interfaces.json').read_text(encoding='utf-8'))
    skeleton = json.loads((recovery / 'skeleton-normal-jsb.json').read_text(encoding='utf-8'))
    expected_outputs = {entry['output']: entry['outputHash'] for entry in client_manifest['outputs']}
    expected_outputs[builtin['output']] = builtin['outputHash']
    expected_outputs[supplement['pr0']['output']] = supplement['pr0']['outputHash']
    expected_sources = {entry['sourceEntry']: entry['sourceHash'] for entry in client_manifest['sources']}
    records = []
    source_members = {}
    documents = {}
    native_candidates = defaultdict(list)
    with zipfile.ZipFile(args.apk) as archive:
        members = {entry.filename: entry for entry in archive.infolist() if not entry.is_dir()}
        config_members = sorted(name for name in members if re.fullmatch(r'assets/assets/[^/]+/config(?:\.[^/]+)?\.json', name))
        configs = {}
        for name in config_members:
            cfg = json.loads(archive.read(name))
            bundle = name.split('/')[2]
            if cfg['name'] != bundle or cfg.get('packs') or cfg.get('encrypted') or cfg.get('isZip'):
                raise ValueError('Unsupported original bundle configuration')
            if cfg.get('importBase') != 'import' or cfg.get('nativeBase') != 'native' or cfg.get('versions'):
                raise ValueError('Unexpected original asset bases or versions')
            if name != f'assets/assets/{bundle}/config.json':
                raise ValueError('Unexpected versioned original config path')
            configs[bundle] = cfg
        bundle_versions = settings.get('bundleVers') or {}
        if bundle_versions or settings.get('remoteBundles') or settings.get('subpackages') or settings.get('server'):
            raise ValueError('Snapshot no longer has the evidenced unversioned local bundle requests')
        if interfaces['normalJsbBoot']['requireOrder'] != ['src/settings.js', 'src/cocos2d-jsb.js', 'jsb-adapter/jsb-engine.js']:
            raise ValueError('Normal JSB boot evidence differs')

        def source_record(name, expected=None):
            if name not in source_members:
                raw = archive.read(name)
                info = members[name]
                source_members[name] = {'member': name, 'rawSha256': digest(raw), 'rawBytes': len(raw), 'zipCrc32': f'{info.CRC:08x}', 'zipCompressedBytes': info.compress_size, 'zipCompressionMethod': info.compress_type}
            record = source_members[name]
            if expected and record['rawSha256'] != expected:
                raise ValueError('Pinned original source member hash differs')
            return record

        selected = sorted(name for name in members if name.startswith('assets/assets/') and name.split('/')[2] in configs)
        for name in selected:
            raw = archive.read(name)
            if not raw:
                raise ValueError('Unexpected empty original runtime resource')
            relative = name.removeprefix('assets/')
            if '..' in PurePosixPath(relative).parts:
                raise ValueError('Unsafe original ZIP resource path')
            source = source_record(name)
            save_new_or_identical(package / relative, raw)
            records.append({'runtimePath': relative, 'bytes': len(raw), 'sha256': source['rawSha256'], 'sourceMembers': [name], 'transformation': 'none; byte-identical original ZIP member'})
            if '/import/' in name:
                documents[(name.split('/')[2], PurePosixPath(name).stem)] = (name, public_document(json.loads(raw)))
            if '/native/' in name:
                native_candidates[(name.split('/')[2], PurePosixPath(name).name.split('.')[0])].append(relative)

        native_data = archive.read(NATIVE_MEMBER)
        source_record(NATIVE_MEMBER, NATIVE_SHA256)
        jump_table = native_raw(native_data, 0x15f2a96, 80)
        stem = 'assets/internal/index'
        folded = sum(ord(char) * 8 ** index for index, char in enumerate(stem[-7:]))
        modulo = folded % 100
        branch = 0x79c578 + 4 * struct.unpack('<40H', jump_table)[modulo - 33]
        if modulo != 72 or branch != 0x79ca48:
            raise ValueError('Internal bundle no longer routes to original pr0 source')
        internal_route = {'requestedPath': 'assets/internal/index.js', 'stemLastSeven': stem[-7:], 'foldedHash': folded, 'modulo100': modulo, 'nativeSourceMember': NATIVE_MEMBER, 'nativeSourceSha256': NATIVE_SHA256, 'jumpTableAddress': '0x15f2a96', 'jumpTableBytes': 80, 'jumpTableSha256': digest(jump_table), 'branchAddress': hex(branch), 'branchBytes': 32, 'branchSha256': digest(native_raw(native_data, branch, 32)), 'routeEvidence': 'client-recovery/startup-dependency-supplement.json#/pr0; original route 0x79ca48', 'decodedSource': supplement['pr0']['output'], 'rawSourceMember': supplement['pr0']['sourceEntry'], 'samePlaintextOriginalMembers': supplement['pr0']['byteIdenticalPlainBundleEntries']}
        mappings = [
            ('decoded/src.settings.js', 'src/settings.js', [NATIVE_MEMBER]),
            ('decoded/src.cocos2d-jsb.js', 'src/cocos2d-jsb.js', [NATIVE_MEMBER]),
            ('decoded/jsb-adapter.jsb-engine.js', 'jsb-adapter/jsb-engine.js', [NATIVE_MEMBER]),
            (builtin['output'], builtin['requestedPath'], [NATIVE_MEMBER]),
            (supplement['pr0']['output'], 'assets/internal/index.js', [supplement['pr0']['sourceEntry'], NATIVE_MEMBER]),
        ]
        for bundle in ('main', 'resources'):
            restored = next(item for item in client_manifest['restored'] if item.get('output') == f'decoded/{bundle}.index.js')
            mappings.append((restored['output'], f'assets/{bundle}/index.js', restored['sourceEntry'] + [NATIVE_MEMBER]))
        for decoded, relative, origins in mappings:
            raw = (recovery / decoded).read_bytes()
            if digest(raw) != expected_outputs[decoded] or not raw:
                raise ValueError('Pinned decoded script hash differs')
            for origin in origins:
                source_record(origin, expected_sources[origin])
            if relative.startswith('assets/'):
                bundle = relative.split('/')[1]
                if bundle not in configs or bundle_versions.get(bundle):
                    raise ValueError('Derived script path does not match actual bundle config')
            save_new_or_identical(package / relative, raw)
            records.append({'runtimePath': relative, 'bytes': len(raw), 'sha256': digest(raw), 'sourceMembers': origins, 'decodedSourcePath': f'client-recovery/{decoded}', 'decodedSourceSha256': digest(raw), 'transformation': 'path mapping only; byte-identical already-verified original decoded plaintext', 'requestEvidence': 'client-recovery/startup-interfaces.json#/normalJsbBoot; client-recovery/builtin-supplement.json; actual local config without versions', **({'nativeRouteEvidence': internal_route} if relative == 'assets/internal/index.js' else {})})

    assets = []
    asset_index = {}
    import_gaps = []
    native_gaps = []
    reference_gaps = []
    bundle_results = []
    for bundle, cfg in configs.items():
        redirect = dict(zip(cfg['redirect'][::2], cfg['redirect'][1::2]))
        for index, encoded in enumerate(cfg['uuids']):
            uuid = decode_uuid(encoded)
            target_bundle = cfg['deps'][redirect[index]] if index in redirect else bundle
            entry = {'bundle': bundle, 'configUuidIndex': index, 'uuid': uuid, 'targetBundle': target_bundle}
            asset_index[(bundle, uuid)] = entry
            if index in redirect:
                entry['status'] = 'original-config-redirect'
                entry['target'] = f'{target_bundle}:{uuid}'
            else:
                document = documents.get((bundle, uuid))
                if document is None:
                    entry['status'] = 'missing-original-import'
                    entry['expectedImportPath'] = f'assets/{bundle}/{cfg["importBase"]}/{uuid[:2]}/{uuid}.json'
                    entry['namedInPaths'] = str(index) in cfg['paths']
                    import_gaps.append(entry)
                else:
                    name, (references, objects) = document
                    entry.update(status='preserved', importPath=name.removeprefix('assets/'), references=references, nativePaths=native_candidates.get((bundle, uuid), []))
                    declared = []
                    for obj in objects:
                        extension = obj.get('_native') or obj.get('__native__')
                        if extension:
                            if not isinstance(extension, str) or not re.fullmatch(r'\.[A-Za-z0-9]+', extension):
                                raise ValueError('Unsupported native filename declaration; no literal emitted')
                            expected = f'assets/{bundle}/{cfg["nativeBase"]}/{uuid[:2]}/{uuid}{extension}'
                            declared.append(expected)
                            if expected not in entry['nativePaths']:
                                native_gaps.append({'asset': f'{bundle}:{uuid}', 'expectedPath': expected})
                        if obj.get('__type__') == 'cc.Texture2D' and not entry['nativePaths']:
                            native_gaps.append({'asset': f'{bundle}:{uuid}', 'reason': 'Texture2D has no original native image candidate'})
                    entry['declaredNativePaths'] = declared
            assets.append(entry)
        local = [entry for entry in assets if entry['bundle'] == bundle]
        bundle_results.append({'name': bundle, 'configPath': f'assets/{bundle}/config.json', 'configSha256': next(entry['sha256'] for entry in records if entry['runtimePath'] == f'assets/{bundle}/config.json'), 'configVersion': None, 'bundleVersion': bundle_versions.get(bundle), 'importBase': cfg['importBase'], 'nativeBase': cfg['nativeBase'], 'dependencyBundles': cfg['deps'], 'uuidCount': len(cfg['uuids']), 'pathCount': len(cfg['paths']), 'packs': cfg.get('packs'), 'scenes': cfg['scenes'], 'statusCounts': dict(Counter(entry['status'] for entry in local)), 'localConfigAndIndexRequestsPresent': all(any(entry['runtimePath'] == f'assets/{bundle}/{filename}' for entry in records) for filename in ('config.json', 'index.js'))})
    inbound = Counter()
    for entry in assets:
        if entry['status'] == 'original-config-redirect':
            target = asset_index.get((entry['targetBundle'], entry['uuid']))
            if target is None or target['status'] != 'preserved':
                reference_gaps.append({'asset': f'{entry["bundle"]}:{entry["uuid"]}', 'target': entry['target'], 'reason': 'Unresolved original config redirect'})
        for reference in entry.get('references', []):
            target = asset_index.get((entry['bundle'], reference))
            inbound[(entry['bundle'], reference)] += 1
            if target is None or target['status'] == 'missing-original-import':
                reference_gaps.append({'asset': f'{entry["bundle"]}:{entry["uuid"]}', 'referenceUuid': reference, 'reason': 'Serialized dependency does not resolve through local config'})
    for entry in import_gaps:
        entry['serializedInboundReferenceCount'] = inbound[(entry['bundle'], entry['uuid'])]
        entry['reason'] = 'Config UUID is present; no ZIP import/native member. Not replaced. No incoming reference in any preserved import and no public path/scene maps this UUID.' if not entry['namedInPaths'] and not entry['serializedInboundReferenceCount'] else 'Original config dependency is missing from ZIP; not replaced.'
    script_missing = [{'requestedPath': skeleton['actualBootRequest'], 'status': 'missing-original-native-empty-return', 'apkMemberCandidates': [], 'originalNativeReturnedBytes': skeleton['originalRoute']['returnedBytes'], 'nativeSourceMember': skeleton['originalRoute']['sourceEntry'], 'nativeSourceSha256': skeleton['originalRoute']['sourceSha256'], 'nativeBranchAddress': skeleton['originalRoute']['branchVirtualAddress'], 'evidence': 'client-recovery/skeleton-normal-jsb.json', 'evidenceSha256': digest((recovery / 'skeleton-normal-jsb.json').read_bytes()), 'physicalFileWritten': False}]
    if skeleton['actualBootRequest'] != 'src/assets/develop/tool/SkeletonExt.js' or skeleton['originalRoute']['returnedBytes'] != 0:
        raise ValueError('Original missing extension evidence differs')
    reused = []
    for relative in ('runtime-analysis/recovered-texture-catalog.json', 'visual-recovery/manifest.json', 'client-recovery/tables.compact-original.json'):
        source = private / relative
        if source.exists():
            reused.append({'path': relative, 'sha256': digest(source.read_bytes()), 'action': 'read-only existing recovery evidence; no decoding, conversion or table recovery rerun'})
    counts = {'rawZipFiles': len(selected), 'mappedDecodedScripts': len(mappings), 'runtimeFiles': len(records), 'runtimeBytes': sum(entry['bytes'] for entry in records), 'bundleConfigs': len(configs), 'configUuidEntries': len(assets), 'preservedImports': len(documents), 'serializedReferenceEdges': sum(len(entry.get('references', [])) for entry in assets), 'configRedirects': sum(entry['status'] == 'original-config-redirect' for entry in assets), 'missingConfigImports': len(import_gaps), 'missingReferencedAssets': len(reference_gaps), 'missingDeclaredNativeFiles': len(native_gaps), 'missingNormalJsbScripts': len(script_missing)}
    closure = {'schemaVersion': 1, 'kind': 'original-local-cocos-config-dependency-closure', 'apkSha256': APK_SHA256, 'actualBundleRoots': sorted(configs), 'counts': counts, 'bundles': bundle_results, 'assets': assets, 'missing': {'configImports': import_gaps, 'serializedDependencies': reference_gaps, 'declaredNativeFiles': native_gaps, 'normalJsbScripts': script_missing}, 'scope': 'All actual APK Cocos bundle members; no old selective allowlist. Audit each UUID, redirect, serialized UUID reference and declared native extension. Preserve every raw native member, including textures, audio and embedded TMX/TSX import data.', 'completenessBoundary': 'Resource preservation and static dependency closure only; not UI/gameplay acceptance. Missing SkeletonExt and three orphan config UUIDs remain explicit. Runtime branch cocos2d-runtime.js and physics.js are not active normalJSB requests. Unreferenced example bundle names are not missing dependencies.'}
    closure_bytes = (json.dumps(closure, ensure_ascii=False, indent=2) + '\n').encode()
    save_new_or_identical(output / 'closure.json', closure_bytes)
    evidence_paths = ['client-recovery/manifest.json', 'client-recovery/builtin-supplement.json', 'client-recovery/startup-dependency-supplement.json', 'client-recovery/startup-interfaces.json', 'client-recovery/skeleton-normal-jsb.json', 'client-recovery/settings.json']
    manifest = {'schemaVersion': 1, 'kind': 'private-original-cocos-runtime-resource-source-manifest', 'versionCode': 2581, 'apk': {'path': str(args.apk), 'sha256': APK_SHA256, 'hashComputedDuringPreservation': True, 'readOnly': True}, 'packageAssetsDirectory': 'reports/private/reconstruction/2581/runtime-assets/package-assets', 'androidPackaging': 'Copy contents, not enclosing directory, into independent host APK assets/. Cocos runtimePath assets/... corresponds to APK member assets/assets/...; src/... and jsb-adapter/... correspond to APK members assets/src/... and assets/jsb-adapter/....', 'counts': counts, 'sourceMembers': list(source_members.values()), 'files': records, 'evidenceInputs': [{'path': relative, 'sha256': digest((private / relative).read_bytes())} for relative in evidence_paths], 'closure': {'path': 'closure.json', 'sha256': digest(closure_bytes)}, 'existingRecoveryReusedReadOnly': reused, 'generator': {'path': 'tools/recovery/runtime-assets-2581/preserve.py', 'sha256': digest(Path(__file__).read_bytes())}, 'exclusions': {'policy': 'Only actual configured Cocos bundle directories and evidenced original decoded normalJSB scripts. Do not copy original ELF, Jiagu, Java protection containers, SDK binary/plugin roots or original periodic remote startup entry.', 'excludedOriginalCocosProtectionContainers': [name for name in members if name.startswith('assets/assets/libs/')], 'originalStartupMainCopied': False, 'sdkBinariesCopied': False, 'originalNativeLibraryCopied': False, 'emptySkeletonExtWritten': False}, 'privacy': 'Private original scripts/data can contain sensitive literals. No script source/literal values emitted to logs. No public publication authorized.', 'transformationBoundary': 'Raw bytes and already-recovered JS plaintext only. No image conversion, replacement texture, color repair, regenerated table, business patch or old rejected-visual index change. Existing recovered textures remain untouched; original PKM is not replaced by a derived PNG.', 'acceptanceBoundary': 'Static resource artifact, not complete-game validation; main agent owns host packaging/runtime verification.'}
    manifest['actualBundleRoots'] = sorted(configs)
    save_json(output / 'source-manifest.json', manifest)
    print(json.dumps({'outputDirectory': str(output), 'packageAssetsDirectory': str(package), 'counts': counts, 'originalJsExecuted': False, 'imageConversionsPerformed': 0, 'tablesRecoveredAgain': 0, 'sdkBinariesCopied': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
