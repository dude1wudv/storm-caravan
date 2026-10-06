import test from 'node:test';
import assert from 'node:assert/strict';
import { canStandAt, findWorldPath, moveWorldActor, worldCamera, type NavigationGrid } from '../tools/navigation';
function grid(width: number, height: number, blocks: [number, number][] = []): NavigationGrid { const blocked = Array<number>(width * height).fill(0); for (const [x, y] of blocks) blocked[y * width + x] = 1; return { width, height, tileWidth: 32, tileHeight: 32, blocked }; }
test('点地面路径绕开实际障碍，不用直线穿墙，目标保持精确坐标', () => {
  const map = grid(8, 7, [[3, 0], [3, 1], [3, 2], [3, 3], [3, 4]]), origin = { x: 48, y: 48 }, requested = { x: 211, y: 55 };
  const result = findWorldPath(map, origin, requested);
  assert.equal(result.reached, true); assert.deepEqual(result.destination, requested);
  assert.ok(result.points.some((point) => point.y >= 176));
  let position = origin;
  for (const point of result.points.slice(1)) { position = moveWorldActor(map, position, { x: point.x - position.x, y: point.y - position.y }); assert.ok(Math.hypot(position.x - point.x, position.y - point.y) < 0.000001); assert.ok(canStandAt(map, position)); }
  assert.deepEqual(position, requested);
});
test('斜向自动寻路不会从两堵墙的夹角穿过，不可达目标返回可达停点', () => {
  const map = grid(2, 2, [[1, 0], [0, 1]]);
  const result = findWorldPath(map, { x: 16, y: 16 }, { x: 48, y: 48 });
  assert.equal(result.reached, false); assert.deepEqual(result.destination, { x: 16, y: 16 });
});
test('地图外、障碍内目标不伪造可达；非法格网与坐标拒绝', () => {
  const map = grid(4, 3, [[2, 1]]);
  assert.equal(findWorldPath(map, { x: 16, y: 16 }, { x: 80, y: 48 }).reached, false);
  assert.equal(findWorldPath(map, { x: 16, y: 16 }, { x: 300, y: 48 }).reached, false);
  assert.deepEqual(findWorldPath(map, { x: 80, y: 48 }, { x: 16, y: 16 }), { points: [], reached: false, destination: null });
  assert.throws(() => findWorldPath({ ...map, blocked: [] }, { x: 1, y: 1 }, { x: 2, y: 2 }), /格网非法/);
  assert.throws(() => findWorldPath(map, { x: 1, y: 1 }, { x: Infinity, y: 2 }), /坐标非法/);
});
test('摇杆移动大步长不能穿透墙体，碰撞时保留沿墙滑动', () => {
  const map = grid(8, 7, Array.from({ length: 7 }, (_, y) => [3, y] as [number, number]));
  const stopped = moveWorldActor(map, { x: 48, y: 48 }, { x: 160, y: 0 }, 4);
  assert.ok(stopped.x <= 92); assert.ok(stopped.x > 80); assert.equal(stopped.y, 48);
  const slide = moveWorldActor(map, { x: 88, y: 48 }, { x: 80, y: 100 }, 4);
  assert.ok(slide.x <= 92); assert.ok(Math.abs(slide.y - 148) < 0.000001); assert.ok(canStandAt(map, slide, 4));
});
test('镜头跟随角色但不越地图边界，小地图不制造负偏移', () => {
  assert.deepEqual(worldCamera({ x: 650, y: 410 }, { width: 1500, height: 1200 }, { width: 800, height: 400 }), { x: 250, y: 210 });
  assert.deepEqual(worldCamera({ x: 1490, y: 1190 }, { width: 1500, height: 1200 }, { width: 800, height: 400 }), { x: 700, y: 800 });
  assert.deepEqual(worldCamera({ x: 200, y: 100 }, { width: 300, height: 200 }, { width: 800, height: 400 }), { x: 0, y: 0 });
});
