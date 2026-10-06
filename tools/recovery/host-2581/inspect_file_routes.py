"""Bounded static callback/entry evidence, with no original ELF or JS execution."""
import struct
from inspect_runtime import SOURCE, OUT, ROOT, GOT, open_elf, mapped, digest, save
from capstone import Cs, CS_ARCH_X86, CS_MODE_32
from capstone.x86_const import X86_OP_MEM, X86_REG_EBX


def main():
    data, elf, symbols = open_elf(SOURCE / 'libcocos2djs-x86.so')
    plt = elf.get_section_by_name('.plt')
    relocations = elf.get_section_by_name('.rel.plt')
    dynsym = elf.get_section(relocations['sh_link'])
    plt_names = {plt['sh_addr'] + 16 * (index + 1): dynsym.get_symbol(rel['r_info_sym']).name
                 for index, rel in enumerate(relocations.iter_relocations())}
    dynrels = elf.get_section_by_name('.rel.dyn')
    ds = elf.get_section(dynrels['sh_link'])
    relnames = {rel['r_offset']: ds.get_symbol(rel['r_info_sym']).name
                for rel in dynrels.iter_relocations() if rel['r_info_sym']}
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = True
    ranges = [('AppDelegate constructor', 0x58FDD0, 4416),
              ('FileOperationDelegate initialization', 0x652F60, 524),
              ('read binary closure', 0x660B80, 0x6610B0 - 0x660B80),
              ('read string closure', 0x661330, 0x6629B0 - 0x661330),
              ('resolve full path closure', 0x662C20, 0x662EC0 - 0x662C20),
              ('is file exists closure', 0x662FF0, 0x663020 - 0x662FF0),
              ('ScriptEngine runScript', 0x67DC80, 282)]
    records = []
    for name, address, size in ranges:
        code = mapped(elf, address, size)
        ins = list(md.disasm(code, address))
        calls = [{'address': hex(i.address), 'target': i.op_str, 'symbol': plt_names.get(int(i.op_str, 16))}
                 for i in ins if i.mnemonic == 'call' and i.op_str.startswith('0x')]
        state = [{'address': hex(i.address), 'operation': i.mnemonic, 'stateAddress': hex(GOT + op.mem.disp)}
                 for i in ins for op in i.operands if op.type == X86_OP_MEM and op.mem.base == X86_REG_EBX
                 and 0xAEE64 <= op.mem.disp <= 0xAEF34]
        records.append({'name': name, 'address': hex(address), 'bytes': size, 'codeSha256': digest(code),
                        'directCalls': calls, 'directSignStateReferences': state})
    callbacks = []
    for function in ['_ZN11AppDelegate29applicationDidFinishLaunchingEv', '_Z24jsb_register_all_modulesv']:
        address, size = symbols[function]
        ins = list(md.disasm(mapped(elf, address, size), address))
        for index, i in enumerate(ins):
            if i.mnemonic == 'call' and i.op_str == '0x517f20':
                for previous in ins[max(0, index - 4):index]:
                    for op in previous.operands:
                        if op.type == X86_OP_MEM and op.mem.base == X86_REG_EBX:
                            callbacks.append({'owner': function, 'callAddress': hex(i.address),
                                              'callbackSymbol': relnames.get(GOT + op.mem.disp)})
    save('file-operation-evidence.json', {'source': (SOURCE / 'libcocos2djs-x86.so').relative_to(ROOT).as_posix(),
         'sha256': digest(data), 'functions': records, 'registerCallbacks': callbacks,
         'delegateClosureVtables': [{'address': hex(GOT + offset),
             'invokeAddress': hex(struct.unpack('<I', mapped(elf, GOT + offset + 0x18, 4))[0])}
             for offset in [-0x43C28, -0x43BE0, -0x43B98, -0x43B58]],
         'fileUtilsVirtualSlots': [{'slot': hex(slot), 'symbol': relnames.get(symbols['_ZTVN7cocos2d9FileUtilsE'][0] + 8 + slot)}
                                   for slot in [0x10, 0x14, 0x7C]],
         'scriptStringDefault': {'routeSelection': 'basename excluding extension; fold final seven bytes by x8; remainder modulo100; table range33..72 and additional74/79',
              'selectionAddresses': ['0x661490', '0x6614c0', '0x661574', '0x661594', '0x6616ca'],
              'unrecognized': '0x6616d4 jumps0x662526, constructs empty std::string; no ordinary getStringFromFile fallback on this edge',
              'recognized': 'Protected embedded blobs/pr assets/XXTEA/gzip routes; recovering plaintext files does not replace these callback routes',
              'routeClassLimit': 'Detailed per-key special route behavior remains owned by client recovery; no dynamic callback result observed'},
         'binaryPlainFallback': {'address': '0x660d97', 'call': 'FileUtils::getDataFromFile via vtable+0x10 at0x660db3; output copied via callback at0x660e14',
              'limit': 'Real ordinary-file binary fallback exists, but public ScriptEngine::runScript uses read-string delegate(this+0x90), not this binary fallback'},
         'signBoundary': 'Constructor/nativeInit/launch have no direct references to observed initGame signing state region; this is not proof of absence of indirect signing effects',
         'redaction': 'Only public symbols, addresses, function hashes and branch descriptions; no original keys or signature values'})


if __name__ == '__main__':
    main()
