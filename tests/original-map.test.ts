import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ORIGINAL_APK_SHA256, OriginalTables } from '../src/foundation/original-data';
import { OriginalMapIndex } from '../src/world/original-map';
import { OriginalCollision } from '../src/world/original-collision';

const sourcePath = 'reports/private/reconstruction/2581/client-recovery/tables.decoded.json';
const dataPromise = OriginalTables.load(readFileSync(sourcePath, 'utf8'), {
  sourceApkSha256: ORIGINAL_APK_SHA256,
  sourceEntry: 'Recovered original main.index.js data modules; source manifest in client-recovery',
  contentSha256: 'a3f721d196b9f7b8e10fd0e08c03538c1544fb5f2a34d0c0e020d2635bf417d9',
  completeness: 'complete-table',
}, async (text) => createHash('sha256').update(text).digest('hex'), 'document');

test('complete original configuration has 76 tables/54791 records without losing explicit null', async () => {
  const data = await dataPromise;
  assert.equal(data.names().length, 76);
  assert.equal(data.names().reduce((sum, name) => sum + data.ids(name).length, 0), 54791);
  assert.equal(data.ids('Mapnpc').length, 9670);
  assert.deepEqual(data.field('Task', '100', 'award'), { presence: 'explicit', value: null });
  assert.deepEqual(data.field('Mapnpc', '91053', 'Width'), { presence: 'default', value: 2 });
});

test('map identity/NPC default placement/exit pairs follow original fields, not numeric ID ordering', async () => {
  const index = new OriginalMapIndex(await dataPromise);
  assert.equal(index.mapFile('2102'), 'map_2102');
  const first = index.npcPlacements('2102').find((placement) => placement.mapnpcId === '91053');
  assert.deepEqual(first, { mapnpcId: '91053', npc: 11, x: 27, y: 38, width: 2, height: 2, face: 0 });
  assert.deepEqual(index.exitForNpc('2102', 11), { sourceNpc: 11, targetMap: 2103, targetNpc: 31 });
  assert.deepEqual(index.exitForNpc('2102', 12), { sourceNpc: 12, targetMap: 2104, targetNpc: 32 });
  assert.equal(index.exitForNpc('2102', 987654321), null);
  const placements = index.npcPlacements('2102');
  placements[0].x = -999;
  assert.equal(index.npcPlacements('2102')[0].x, 27);
  assert.throws(() => index.mapFile('missing'));
});

test('original collision floors use named layers, reverse world y and inspect four cells', () => {
  const gids = new Array<number>(16).fill(0);
  gids[1] = 7; // source top row x1 becomes world y3.
  const objects: [number, number, number][] = [];
  const collision = new OriginalCollision({
    width: 4, height: 4,
    layers: [{ name: 'pz', width: 4, height: 4, gids }],
  }, (x, y, floor) => { objects.push([x, y, floor]); return x === 2 && y === 1; });
  assert.equal(collision.isBlockedTile(0, 2, 0), true); // upper-right cell.
  assert.equal(collision.isBlockedTile(1, 2, 0), true); // upper-left cell.
  assert.equal(collision.isBlockedTile(0, 0, 0), false);
  assert.equal(collision.isBlockedTile(2, 1, 0), true); // WJ callback.
  assert.equal(collision.isBlockedTile(0, 2, -1), false); // no pz-1 layer.
  assert.equal(collision.isBlockedTile(3, 0, 0), true); // 2x2 footprint cannot cross edge.
  assert.equal(collision.isBlockedTile(0, 0, 9), true);
  assert.deepEqual(objects, [[0, 0, 0], [2, 1, 0], [0, 2, -1]]);
});
