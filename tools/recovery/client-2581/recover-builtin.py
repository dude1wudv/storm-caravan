"""Recover only the pinned original jsb-adapter/jsb-builtin.js embedded container."""
import argparse
import json
from pathlib import Path
import struct
import zipfile
import subprocess
from recover import Native, NATIVE_ENTRY, digest, decrypt, save


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    options = parser.parse_args()
    with zipfile.ZipFile(options.apk) as apk:
        native_bytes = apk.read(NATIVE_ENTRY)
    if digest(native_bytes) != 'e644052a3b365533bb1bd3d9952a21a99cdf58fe6a98561801146a528393d24a':
        raise ValueError('Wrong native snapshot')
    native = Native(native_bytes)
    pointers = [native.pointer(0x19943a0 + i * 8) for i in range(45)]
    original = pointers.copy()
    pointers[4] = native.pointer(0x1a39ab8)
    pointers[0] = original[4]
    for i in range(5, 40, 5):
        pointers[i], pointers[i + 4] = original[i + 4], original[i]
    sizes = struct.unpack('<45I', native.raw(0x15f2ae8, 180))
    cipher = b''.join(native.raw(pointer, size) for pointer, size in zip(pointers, sizes))
    if len(cipher) != 0xf188:
        raise ValueError('Original _gt4 assembler length differs')
    plain, metadata = decrypt(cipher, native.key())
    save(options.root / 'decoded/jsb-adapter.jsb-builtin.js', plain)
    parse_code = "const fs=require('fs'),acorn=require('acorn');const t=fs.readFileSync(process.argv[1],'utf8');const a=acorn.parse(t,{ecmaVersion:'latest'});console.log(JSON.stringify({parse:'acorn-static-success',topLevelStatements:a.body.length,originalJsExecuted:false}));"
    parsed = subprocess.run(['node', '-e', parse_code, str(options.root / 'decoded/jsb-adapter.jsb-builtin.js')], cwd=Path(__file__).resolve().parents[3], capture_output=True, text=True, check=True)
    parse_check = json.loads(parsed.stdout)
    record = {'schemaVersion': 1, 'versionCode': 2581, 'requestedPath': 'jsb-adapter/jsb-builtin.js', 'sourceEntry': NATIVE_ENTRY, 'sourceHash': digest(native_bytes), 'loaderHash': 32814666, 'loaderHashModulo100': 66, 'loaderBranchAddress': '0x79ca34', 'assembler': {'symbol': '_Z4_gt4Ri', 'address': '0x78ef9c', 'pointerTable': '0x19943a0', 'sizeTable': '0x15f2ae8', 'fragments': 45, 'cipherBytes': len(cipher)}, 'output': 'decoded/jsb-adapter.jsb-builtin.js', 'outputHash': digest(plain), 'outputBytes': len(plain), 'method': 'Original embedded pointer replacement/order -> modified XXTEA mode1 preprocessing -> original length guard -> gzip CRC/length expansion', 'metadataMatches': metadata, 'originalJsExecuted': False, 'keyValuesLogged': False, 'trust': 'Original plaintext recovered; runtime behavior not exercised'}
    record['staticParse'] = parse_check
    save(options.root / 'builtin-supplement.json', (json.dumps(record, indent=2) + '\n').encode())
    print(json.dumps({'recovered': record['requestedPath'], 'bytes': len(plain), 'sha256': digest(plain)}))


if __name__ == '__main__':
    main()
