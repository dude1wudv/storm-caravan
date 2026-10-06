export interface OriginalCollisionLayer { name: string; width: number; height: number; gids: readonly number[] }
export interface OriginalCollisionMap { width: number; height: number; layers: readonly OriginalCollisionLayer[] }

/**
 * Port of recovered 2581 MapModel.loadMapFile0 / isCrashWall.
 * Three floors: pz-1, pz, pz1; original TMX rows are inverted into world-y rows.
 * WJ object collision is delegated to the original-object adapter, not omitted or guessed.
 */
export class OriginalCollision {
  private readonly floors: number[][];

  constructor(private readonly map: OriginalCollisionMap, private readonly crashObject: (x: number, y: number, floor: number) => boolean) {
    if (!Number.isSafeInteger(map.width) || !Number.isSafeInteger(map.height) || map.width < 2 || map.height < 2 || map.width * map.height > 1_000_000) {
      throw new Error('Invalid original collision map dimensions');
    }
    this.floors = [-1, 0, 1].map((floor) => {
      const name = floor === 0 ? 'pz' : `pz${floor}`;
      const matches = map.layers.filter((layer) => layer.name === name);
      if (matches.length > 1) throw new Error(`Duplicate original collision layer: ${name}`);
      const layer = matches[0];
      // Original creates empty per-y arrays when the floor layer is absent; parity
      // comparisons on undefined do not mark interior cells blocked.
      const blocked = new Array<number>(map.width * map.height).fill(0);
      if (!layer) return blocked;
      if (layer.width !== map.width || layer.height !== map.height || layer.gids.length !== blocked.length) {
        throw new Error(`Unsupported original collision layer shape: ${name}`);
      }
      for (let row = 0; row < map.height; row++) {
        for (let column = 0; column < map.width; column++) {
          const gid = layer.gids[row * map.width + column];
          if (!Number.isSafeInteger(gid) || gid < 0 || gid > 0xffffffff) throw new Error('Invalid original tile GID');
          blocked[(map.height - row - 1) * map.width + column] = gid ? 1 : 0;
        }
      }
      return blocked;
    });
  }

  isBlockedTile(x: number, y: number, floor: number): boolean {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(floor)) throw new Error('Original collision requires integer tile coordinates/floor');
    if (x < 0 || y < 0 || x >= this.map.width - 1 || y >= this.map.height - 1) return true;
    const blocked = this.floors[floor + 1];
    if (!blocked) return true;
    const lower = y * this.map.width + x;
    const upper = (y + 1) * this.map.width + x;
    if (blocked[lower] % 2 === 1 || blocked[lower + 1] % 2 === 1 || blocked[upper] % 2 === 1 || blocked[upper + 1] % 2 === 1) return true;
    return this.crashObject(x, y, floor);
  }
}
