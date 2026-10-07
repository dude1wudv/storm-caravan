"""Explicit offline QA fixture; never a normal-save migration or a server response."""
import json
from pathlib import Path


def create_full_seed(project):
    tables = json.loads((project / 'reports/private/reconstruction/2581/client-recovery/tables.decoded.json').read_text(encoding='utf-8'))
    def row(table, key):
        return dict(tables[table].get('defaults', {}), **tables[table]['data'][str(key)])
    # Original SaveKeys from player/world/map/item/equip/core/role and ManagerOrderKeys.
    data = {'00': {'9': 300, 'f': 0, 'a': '离线全量测试', '3': 1},
            '0b': {'0': 100}, '04': {'0': 51}, '05': {'9': 0}, '0k': {'4': 50}}
    def entity(prefix, index, fields):
        chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
        suffix = ''
        while True:
            suffix = chars[index % 62] + suffix
            index //= 62
            if not index:
                break
        data[prefix + suffix] = fields
    item_ids, equip_ids, role_ids = [], [], []
    for key in tables['Item']['data']:
        k = int(key)
        if k <= 0:
            continue
        kind = row('Item', key)['itemType']
        if kind == 31 and key in tables['Role']['data']:
            role_ids.append(k)
        elif kind == 33 and key in tables['Equip']['data']:
            equip_ids.append(k)
        elif kind != 15:
            item_ids.append(k)
    for i, k in enumerate(item_ids):
        entity('7', i, {'0': k, '1': 99999})
    for i, k in enumerate(equip_ids):
        entity('6', i, {'0': k, '2': 60})
    for i, k in enumerate(role_ids):
        entity('8', i, {'0': k})
    core_ids = [int(k) for k in tables['Equipcore']['data'] if int(k) > 0]
    for i, k in enumerate(core_ids):
        entity('k', i, {'0': k, '1': 5})
    # Local chapters and biographies: one completed cycle satisfies original World unlock checks.
    # Timed worlds still require original activity entities; never fabricate them.
    world_ids = []
    excluded_worlds = []
    for key in tables['World']['data']:
        k = int(key)
        if not (1 <= k <= 6 or 31 <= k <= 35 or k == 100):
            excluded_worlds.append(k)
            continue
        safe = row('World', key)['safeMap']
        entity('b', k, {'0': k, '1': 1, '2': safe, '5': safe, '6': 1,
                        'g': json.dumps([safe, safe, safe]), 'm': '[1,1,1]'})
        world_ids.append(k)
    entity('4', 0, {'0': 51, '4': 10})
    return {'syn': 1, 'data': data, 'd1': {}, 'd2': {}, 'dt1': {}}, {
        'items': len(item_ids), 'itemQuantity': 99999, 'equipmentTypes': len(equip_ids),
        'equipmentQuantity': 60, 'roles': len(role_ids), 'coreTypes': len(core_ids),
        'coreLevel': 5, 'teamCoreLevel': 50, 'localWorlds': world_ids,
        'excludedActivityWorlds': excluded_worlds,
        'scope': 'Explicit test fixture, not earned progression; no paid eligibility. Dynamic activities not fabricated.'}
