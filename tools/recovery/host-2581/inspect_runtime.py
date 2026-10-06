"""Static-only ELF/JS host inventory. Does not execute APK code, ELF or network calls."""
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools/recovery/client-2581/vendor'))
from elftools.elf.elffile import ELFFile
from capstone import Cs, CS_ARCH_X86, CS_MODE_32
from capstone.x86_const import X86_OP_MEM, X86_REG_EBX

OUT = ROOT / 'reports/private/reconstruction/2581/host-recovery'
CLIENT = ROOT / 'reports/private/reconstruction/2581/client-recovery/decoded'
SOURCE = ROOT / 'reports/private/reconstruction/2581/visual-recovery/source'
APK = ROOT.parents[1] / 'games/合金机兵.apk'
GOT = 0x1ABFEDC


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(name, value):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def open_elf(path):
    data = path.read_bytes()
    elf = ELFFile(io.BytesIO(data))
    symbols = {s.name: (int(s['st_value']), int(s['st_size']))
               for section in elf.iter_sections() if section['sh_type'] in ('SHT_DYNSYM', 'SHT_SYMTAB')
               for s in section.iter_symbols() if s.name}
    return data, elf, symbols


def mapped(elf, address, size):
    for segment in elf.iter_segments():
        if segment['p_type'] == 'PT_LOAD' and segment['p_vaddr'] <= address and address + size <= segment['p_vaddr'] + segment['p_filesz']:
            start = address - segment['p_vaddr']
            return segment.data()[start:start + size]
    raise ValueError(f'Not file-backed: {address:#x}')


def main():
    data, elf, symbols = open_elf(SOURCE / 'libcocos2djs-x86.so')
    arm_data, arm_elf, arm_symbols = open_elf(SOURCE / 'libcocos2djs-arm64.so')
    plt = elf.get_section_by_name('.plt')
    relocations = elf.get_section_by_name('.rel.plt')
    dynsym = elf.get_section(relocations['sh_link'])
    plt_names = {plt['sh_addr'] + 16 * (index + 1): dynsym.get_symbol(rel['r_info_sym']).name
                 for index, rel in enumerate(relocations.iter_relocations())}
    disassembler = Cs(CS_ARCH_X86, CS_MODE_32)
    disassembler.detail = True

    def instructions(name):
        address, size = symbols[name]
        return list(disassembler.disasm(mapped(elf, address, size), address))

    def public_literal(address):
        raw = mapped(elf, address, 256).split(b'\0', 1)[0]
        value = raw.decode('ascii', errors='replace')
        if re.fullmatch(r'[A-Za-z0-9_/$();\[.]+', value):
            return value
        return {'redacted': True, 'bytes': len(raw), 'sha256': digest(raw)}

    exports = []
    for name in sorted(n for n in symbols if n.startswith('Java_')):
        java = name[len('Java_'):].split('_')
        exports.append({'symbol': name, 'class': '.'.join(java[:-1]), 'method': java[-1],
                        'x86': {'address': hex(symbols[name][0]), 'bytes': symbols[name][1]},
                        'arm64': {'address': hex(arm_symbols[name][0]), 'bytes': arm_symbols[name][1]} if name in arm_symbols else None,
                        'descriptorStatus': 'Original Java declaration not recovered; JNI symbol alone does not encode argument descriptor'})
    save('jni-matrix.json', {'nativeSha256': {'x86': digest(data), 'arm64': digest(arm_data)},
                            'exports': exports, 'jniOnLoadReturn': 'JNI_VERSION_1_4',
                            'nativeToJavaCustomMethods': [
                                {'class': 'com.ftaro.adapter.Manager', 'method': 'readPayData', 'descriptor': '()Ljava/lang/String;', 'x86Lookup': '0x597583'},
                                {'class': 'com.ftaro.adapter.Manager', 'method': 'pay', 'descriptor': '(' + 'Ljava/lang/String;' * 7 + ')Ljava/lang/String;', 'x86Lookup': '0x598d58'},
                                {'class': 'com.ftaro.adapter.Manager', 'method': 'cleanPayData', 'descriptor': '(Ljava/lang/String;)Ljava/lang/String;', 'x86Lookup': '0x5997ca'},
                                {'class': 'com.ftaro.adapter.Manager', 'method': 'showShare', 'descriptor': '(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', 'x86Lookup': '0x59a7b9'},
                                {'class': 'com.ftaro.adapter.Manager', 'method': 'runtime argument, not a fixed method', 'descriptor': '()Ljava/lang/String;', 'x86Lookup': '0x599f55'},
                                {'class': 'com.ftaro.adapter.Manager', 'method': 'runtime argument, not a fixed method', 'descriptor': '(Ljava/lang/String;)Ljava/lang/String;', 'x86Lookup': '0x59a2e8'}],
                            'nativeToJavaEngineClassLiterals': sorted(set(m.group().decode() for m in re.finditer(rb'(?:org/cocos2dx|com/ftaro)/[A-Za-z0-9_/$]+(?=\x00)', data)))})

    functions = ['JNI_OnLoad', 'Java_org_cocos2dx_javascript_AppActivity_initGame',
                 'Java_org_cocos2dx_lib_Cocos2dxRenderer_nativeInit', '_Z22cocos_android_app_initP7_JNIEnvii',
                 '_ZN11AppDelegate29applicationDidFinishLaunchingEv', '_Z24jsb_register_all_modulesv',
                 '_ZN2se12ScriptEngine11addInitHookEPKci', '_Z31register_javascript_adapter_allPN2se6ObjectE',
                 '_Z19ft_android_get_signRN2se5StateE', '_Z12ft_c_getCodeRN2se5StateE',
                 '_Z13ft_c_getIvKeyRN2se5StateE', '_Z14ft_c_call_coreRN2se5StateE', '_Z9ft_c_initRN2se5StateE']
    records = []
    for name in functions:
        address, size = symbols[name]
        ins = instructions(name)
        calls = [{'address': hex(i.address), 'target': i.op_str, 'symbol': plt_names.get(int(i.op_str, 16))}
                 for i in ins if i.mnemonic == 'call' and i.op_str.startswith('0x')]
        state = [{'address': hex(i.address), 'operation': i.mnemonic,
                  'stateAddress': hex(GOT + operand.mem.disp)} for i in ins for operand in i.operands
                 if operand.type == X86_OP_MEM and operand.mem.base == X86_REG_EBX and 0x1B6ED00 <= GOT + operand.mem.disp < 0x1B6F000]
        records.append({'symbol': name, 'address': hex(address), 'bytes': size,
                        'codeSha256': digest(mapped(elf, address, size)), 'directCalls': calls,
                        'customStateReferences': state})
    adapter = instructions('_Z31register_javascript_adapter_allPN2se6ObjectE')
    adapter_names = [{'address': hex(i.address), 'name': public_literal(GOT - int(i.op_str.split('ebx - 0x')[1].split(']')[0], 16))}
                     for i in adapter if i.mnemonic == 'lea' and 'ebx - 0x' in i.op_str]
    save('native-startup-evidence.json', {'source': (SOURCE / 'libcocos2djs-x86.so').relative_to(ROOT).as_posix(),
         'sha256': digest(data), 'analysis': 'Static symbol, relocation, PT_LOAD and instruction decoding only',
         'functions': records, 'adapterGlobals': adapter_names,
         'builtinScriptPath': (mapped(elf, GOT - 0x3465DC, 16) + b'builtin.js').decode(),
         'signatureJavaLookups': [{'address': hex(GOT + offset), 'literal': public_literal(GOT + offset)}
             for offset in [-0x45D40D, -0x45D3FB, -0x45D3D5, -0x45D3C6, -0x45D390, -0x45D381, -0x45D376, -0x45D356, -0x45D34D]],
         'redaction': 'No raw signing values, hardcoded credentials, URLs or key material emitted'})

    scripts = []
    for logical, file in [('main.js', 'startup.main.js'), ('src/settings.js', 'src.settings.js'),
                          ('src/cocos2d-jsb.js', 'src.cocos2d-jsb.js'), ('jsb-adapter/jsb-engine.js', 'jsb-adapter.jsb-engine.js'),
                          ('assets/main/index.js', 'main.index.js'), ('assets/resources/index.js', 'resources.index.js')]:
        path = CLIENT / file
        content = path.read_bytes()
        scripts.append({'logicalPath': logical, 'sourcePath': path.relative_to(ROOT).as_posix(),
                        'bytes': len(content), 'sha256': digest(content)})
    engine = (CLIENT / 'src.cocos2d-jsb.js').read_bytes()
    match = re.search(rb'cc\.ENGINE_VERSION\s*=\s*"([0-9.]+)"', engine)
    startup = (CLIENT / 'startup.main.js').read_bytes()
    selector = startup.index(b"var isRuntime=typeof loadRuntime==='function'")
    save('script-runtime.json', {'engineVersion': match.group(1).decode(), 'engineVersionByteOffset': match.start(),
          'creatorVersion': '[推断] Creator 2.4.3 generation, from original cc.ENGINE_VERSION; editor build/patch and native commit not proven',
          'rejectedVersionEvidence': {'literal': '2.4.2 cocos@cocoss-MacBook-Pro.local-v3.4-182-g408ba56',
             'reason': 'Not a Creator identity; original engine assignment is 2.4.3. Library-specific provenance not independently identified.'},
          'scripts': scripts, 'selector': {'byteOffset': selector, 'expression': "typeof loadRuntime === 'function'"},
          'branches': {'normalJSB': ['src/settings.js', 'src/cocos2d-jsb.js', 'src/physics.js (only CC_PHYSICS_BUILTIN || CC_PHYSICS_CANNON)', 'jsb-adapter/jsb-engine.js', 'window.boot()'],
                       'loadRuntime': ['src/settings.js', 'src/cocos2d-runtime.js', 'src/physics.js (same condition)', 'jsb-adapter/engine/index.js', 'window.boot()']},
          'branchLimit': 'Actual runtime execution/selected branch not observed; ordinary JNI+V8 path and recovered JSB script provide normal-JSB evidence, not execution proof',
          'bootPublicCalls': ['cc.assetManager.init', 'cc.assetManager.loadScript(settings.jsList)', 'cc.assetManager.loadBundle(internal/resources/main)', 'cc.game.run', 'loadScene(settings.launchScene)', 'cc.director.runSceneImmediate'],
          'bootLimit': 'Names from original source, not completion evidence; endpoints and hardcoded literals deliberately omitted'})

    dependencies = []
    with zipfile.ZipFile(APK) as apk:
        for member in apk.namelist():
            if member.startswith('lib/') and member.endswith('.so'):
                original = apk.read(member)
                item = ELFFile(io.BytesIO(original))
                dynamic = item.get_section_by_name('.dynamic')
                needed = [tag.needed for tag in dynamic.iter_tags() if tag.entry.d_tag == 'DT_NEEDED'] if dynamic else []
                dependencies.append({'apkMember': member, 'bytes': len(original), 'sha256': digest(original), 'dtNeeded': needed,
                     'requiredByCocosDTNeeded': False if not member.endswith('/libcocos2djs.so') else None,
                     'status': 'Game engine/custom extensions' if member.endswith('/libcocos2djs.so') else 'SDK-associated package member; no inference of required game role from filename'})
    save('native-dependency-matrix.json', {'libraries': dependencies,
         'scope': 'DT_NEEDED and APK packaging only; Java reflection/dlopen/SDK calls are not excluded by absence from DT_NEEDED',
         'exclusions': 'Jiagu protection and payment/ad SDKs are not copied into a product by this task'})
    print(json.dumps({'jniExports': len(exports), 'scripts': len(scripts), 'packagedNativeLibraries': len(dependencies), 'engineVersion': match.group(1).decode()}))


if __name__ == '__main__':
    main()
