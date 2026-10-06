export interface WorldPoint { x: number; y: number }
export interface NavigationGrid { width: number; height: number; tileWidth: number; tileHeight: number; blocked: readonly number[] }
export interface NavigationResult { points: WorldPoint[]; reached: boolean; destination: WorldPoint | null }
const directions = [[1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10], [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14]] as const;
function checkGrid(grid: NavigationGrid): void {
  if (!Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width < 1 || grid.height < 1 || grid.width * grid.height > 1000000 || !Number.isFinite(grid.tileWidth) || !Number.isFinite(grid.tileHeight) || grid.tileWidth <= 0 || grid.tileHeight <= 0 || grid.blocked.length !== grid.width * grid.height) throw new Error('地图导航格网非法');
}
function cell(grid: NavigationGrid, point: WorldPoint): WorldPoint { return { x: Math.floor(point.x / grid.tileWidth), y: Math.floor(point.y / grid.tileHeight) }; }
function open(grid: NavigationGrid, x: number, y: number): boolean { return x >= 0 && y >= 0 && x < grid.width && y < grid.height && !grid.blocked[y * grid.width + x]; }
function center(grid: NavigationGrid, index: number): WorldPoint { return { x: (index % grid.width + 0.5) * grid.tileWidth, y: (Math.floor(index / grid.width) + 0.5) * grid.tileHeight }; }
function heuristic(x: number, y: number, target: WorldPoint): number { const dx = Math.abs(x - target.x), dy = Math.abs(y - target.y); return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy); }
interface Entry { index: number; distance: number; priority: number }
class Frontier {
  private entries: Entry[] = [];
  get length(): number { return this.entries.length; }
  push(entry: Entry): void {
    let index = this.entries.length; this.entries.push(entry);
    while (index > 0) { const parent = (index - 1) >> 1; if (this.entries[parent].priority <= entry.priority) break; this.entries[index] = this.entries[parent]; index = parent; }
    this.entries[index] = entry;
  }
  pop(): Entry {
    const first = this.entries[0], last = this.entries.pop()!;
    if (this.entries.length) {
      let index = 0;
      while (index * 2 + 1 < this.entries.length) { let child = index * 2 + 1; if (child + 1 < this.entries.length && this.entries[child + 1].priority < this.entries[child].priority) child++; if (last.priority <= this.entries[child].priority) break; this.entries[index] = this.entries[child]; index = child; }
      this.entries[index] = last;
    }
    return first;
  }
}
/** The collision adapter supplies an explicit blocked grid; names such as pz are not silently treated as proven original rules. */
export function findWorldPath(grid: NavigationGrid, origin: WorldPoint, requested: WorldPoint): NavigationResult {
  checkGrid(grid);
  if (![origin.x, origin.y, requested.x, requested.y].every(Number.isFinite)) throw new Error('地图目标坐标非法');
  const start = cell(grid, origin), goal = cell(grid, requested);
  if (!open(grid, start.x, start.y)) return { points: [], reached: false, destination: null };
  const startIndex = start.y * grid.width + start.x, size = grid.width * grid.height;
  const distance = new Float64Array(size); distance.fill(Infinity); distance[startIndex] = 0;
  const parent = new Int32Array(size); parent.fill(-1);
  const frontier = new Frontier(); frontier.push({ index: startIndex, distance: 0, priority: heuristic(start.x, start.y, goal) });
  let nearest = startIndex, nearestDistance = heuristic(start.x, start.y, goal), reached = false;
  while (frontier.length) {
    const entry = frontier.pop(); if (entry.distance !== distance[entry.index]) continue;
    const x = entry.index % grid.width, y = Math.floor(entry.index / grid.width), remaining = heuristic(x, y, goal);
    if (remaining < nearestDistance || remaining === nearestDistance && entry.distance < distance[nearest]) { nearest = entry.index; nearestDistance = remaining; }
    if (x === goal.x && y === goal.y) { nearest = entry.index; reached = true; break; }
    for (const [dx, dy, cost] of directions) {
      const nx = x + dx, ny = y + dy;
      if (!open(grid, nx, ny) || dx && dy && (!open(grid, x + dx, y) || !open(grid, x, y + dy))) continue;
      const next = ny * grid.width + nx, nextDistance = entry.distance + cost;
      if (nextDistance >= distance[next]) continue;
      distance[next] = nextDistance; parent[next] = entry.index;
      frontier.push({ index: next, distance: nextDistance, priority: nextDistance + heuristic(nx, ny, goal) });
    }
  }
  const indices: number[] = [];
  for (let index = nearest; index !== -1; index = parent[index]) indices.push(index);
  indices.reverse();
  const points = [origin, ...indices.map((index) => center(grid, index))];
  if (reached) points.push({ ...requested });
  return { points, reached, destination: points[points.length - 1] };
}
export function canStandAt(grid: NavigationGrid, point: WorldPoint, radius = 0): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(radius) || radius < 0) return false;
  const left = Math.floor((point.x - radius) / grid.tileWidth), right = Math.floor((point.x + radius) / grid.tileWidth), top = Math.floor((point.y - radius) / grid.tileHeight), bottom = Math.floor((point.y + radius) / grid.tileHeight);
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) if (!open(grid, x, y)) return false;
  return true;
}
/** Small swept steps prevent fast driving from tunnelling through a wall. Axis sliding keeps manual controls responsive. */
export function moveWorldActor(grid: NavigationGrid, origin: WorldPoint, displacement: WorldPoint, radius = 0): WorldPoint {
  checkGrid(grid);
  if (![origin.x, origin.y, displacement.x, displacement.y, radius].every(Number.isFinite) || radius < 0) throw new Error('地图移动参数非法');
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(displacement.x) / grid.tileWidth, Math.abs(displacement.y) / grid.tileHeight) * 4));
  if (steps > 100000) throw new Error('地图移动跨度超限');
  const delta = { x: displacement.x / steps, y: displacement.y / steps }; let point = { ...origin };
  for (let step = 0; step < steps; step++) {
    const both = { x: point.x + delta.x, y: point.y + delta.y };
    if (canStandAt(grid, both, radius)) { point = both; continue; }
    const horizontal = { x: point.x + delta.x, y: point.y }, vertical = { x: point.x, y: point.y + delta.y };
    if (canStandAt(grid, horizontal, radius)) point = horizontal;
    if (canStandAt(grid, { x: point.x, y: vertical.y }, radius)) point = { x: point.x, y: vertical.y };
  }
  return point;
}
export function worldCamera(actor: WorldPoint, world: { width: number; height: number }, viewport: { width: number; height: number }): WorldPoint {
  return { x: Math.max(0, Math.min(Math.max(0, world.width - viewport.width), actor.x - viewport.width / 2)), y: Math.max(0, Math.min(Math.max(0, world.height - viewport.height), actor.y - viewport.height / 2)) };
}
