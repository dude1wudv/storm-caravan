"""Statically decode original 2581 table literals; preserve absent fields and explicit null."""
import argparse
import hashlib
import json
from pathlib import Path


def decode_string(value, seed):
    output = []
    for index, character in enumerate(value[1:]):
        cp = ord(character)
        low, high = (0, 55296) if cp < 55296 else (57344, 65536) if cp < 65536 else (65536, 1114112)
        decoded = cp - seed - index
        if decoded < low:
            decoded += ((low - decoded + high - low - 1) // (high - low)) * (high - low)
        output.append(decoded)
    if ord(value[0]) != (2581 + sum(output)) % 1114111:
        raise ValueError('Original cell checksum failed; no output synthesized')
    return ''.join(chr(cp) for cp in output)


def decode(compact):
    result = {}
    checks = {'cellChecksumsPassed': 0, 'explicitNullCells': 0, 'missingFields': 0}
    for name, table in compact.items():
        keys = table['keys']
        reverse = {v: k for k, v in keys.items()}
        indices, groups = {}, {}
        for column, encoded in keys.items():
            group = column[:-3] if len(column) >= 3 and column[-3] == '_' else column
            if group not in groups:
                groups[group] = len(groups) + 1
            indices[encoded] = groups[group]
        rows = {}
        for rid, row in table['data'].items():
            decoded_row = {}
            for encoded, value in row.items():
                if value is None:
                    checks['explicitNullCells'] += 1
                elif isinstance(value, str) and value:
                    seed = (2017 | 2581) + (int(rid) & 127) + (indices[encoded] << 1)
                    value = decode_string(value, seed)
                    checks['cellChecksumsPassed'] += 1
                    if table['isArray'].get(encoded):
                        value = json.loads(value)
                    elif table['colType'].get(encoded) == 'n':
                        value = float(value)
                        if value.is_integer():
                            value = int(value)
                decoded_row[reverse[encoded]] = value
            checks['missingFields'] += len(keys) - len(decoded_row)
            rows[rid] = decoded_row
        result[name] = {'keys': list(keys), 'defaults': table['default'], 'data': rows}
    return result, checks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--reference', type=Path, required=True)
    options = parser.parse_args()
    compact = json.loads((options.root / 'tables.compact-original.json').read_text(encoding='utf-8'))
    result, checks = decode(compact)
    reference_bytes = options.reference.read_bytes()
    reference = json.loads(reference_bytes.decode('utf-8-sig'))['tables']
    comparisons, differences = 0, []
    for name, table in reference.items():
        for rid, row in table['data'].items():
            for column, value in row.items():
                comparisons += 1
                if column not in result[name]['data'][rid] or result[name]['data'][rid][column] != value:
                    differences.append({'table': name, 'record': rid, 'column': column})
        for column, value in table['defaults'].items():
            comparisons += 1
            if column not in result[name]['defaults'] or result[name]['defaults'][column] != value:
                differences.append({'table': name, 'default': column})
    payload = json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()
    output = options.root / 'tables.decoded.json'
    if output.exists() and output.read_bytes() != payload:
        raise ValueError('Existing full table output differs; refusing overwrite')
    if not output.exists():
        output.write_bytes(payload)
    checks.update({'tables': len(result), 'rows': sum(len(t['data']) for t in result.values()), 'referenceTables': len(reference), 'referenceHash': hashlib.sha256(reference_bytes).hexdigest(), 'referenceComparisons': comparisons, 'referenceDifferences': differences, 'outputHash': hashlib.sha256(payload).hexdigest(), 'defaultsMaterialized': False, 'languageColumnsOverwritten': False})
    (options.root / 'table-checks.json').write_text(json.dumps(checks, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in checks.items() if k not in ['referenceDifferences']}))


if __name__ == '__main__':
    main()
