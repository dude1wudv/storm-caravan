import { OriginalTables } from '../foundation/original-data';
import type { JsonValue } from '../foundation/json';

export interface OriginalNpcPlacement {
  mapnpcId: string;
  npc: number;
  x: number;
  y: number;
  width: number;
  height: number;
  face: number;
}
export interface OriginalMapExit { sourceNpc: number; targetMap: number; targetNpc: number }

/**
 * Original 2581 extnpc: mapNpcIds construction and checkIsDelivery;
 * managermap.crashNpc/searchNpc: a_mitmap[index] + a_mitnpc2[index].
 * Positions retain source units. This class does not assert collision, visibility or trigger eligibility.
 */
export class OriginalMapIndex {
  private readonly placements: Record<string, OriginalNpcPlacement[]> = Object.create(null);

  constructor(private readonly data: OriginalTables) {
    data.requireComplete();
    for (const mapnpcId of data.ids('Mapnpc')) {
      const map = this.number('Mapnpc', mapnpcId, 'Map');
      const placement = {
        mapnpcId,
        npc: this.number('Mapnpc', mapnpcId, 'Npc'),
        x: this.number('Mapnpc', mapnpcId, 'X'),
        y: this.number('Mapnpc', mapnpcId, 'Y'),
        width: this.number('Mapnpc', mapnpcId, 'Width'),
        height: this.number('Mapnpc', mapnpcId, 'Height'),
        face: this.number('Mapnpc', mapnpcId, 'Face'),
      };
      (this.placements[String(map)] ??= []).push(placement);
    }
  }

  npcPlacements(mapId: string): OriginalNpcPlacement[] {
    // Ensure the map exists, even if no fixed NPC placement is present.
    this.data.field('Map', mapId, 'name');
    return (this.placements[mapId] ?? []).map((placement) => ({ ...placement }));
  }

  mapFile(mapId: string): string {
    const field = this.data.field('Map', mapId, 'mapfile');
    if (field.presence === 'absent' || typeof field.value !== 'string' || !field.value) throw new Error(`Original map resource missing: ${mapId}`);
    return field.value;
  }

  exitForNpc(mapId: string, npcId: number): OriginalMapExit | null {
    const value = this.data.field('Map', mapId, 'a_mitnpc1');
    if (value.presence === 'absent' || value.value === null) return null;
    const sources = this.numberArray(value.value, `${mapId}.a_mitnpc1`);
    const index = sources.indexOf(npcId);
    if (index < 0) return null;
    const targets = this.data.field('Map', mapId, 'a_mitmap');
    const targetNpcs = this.data.field('Map', mapId, 'a_mitnpc2');
    if (targets.presence === 'absent' || targetNpcs.presence === 'absent') throw new Error(`Original exit pair missing: ${mapId}/${npcId}`);
    const maps = this.numberArray(targets.value, `${mapId}.a_mitmap`);
    const npcs = this.numberArray(targetNpcs.value, `${mapId}.a_mitnpc2`);
    if (index >= maps.length || index >= npcs.length) throw new Error(`Original exit pair is incomplete: ${mapId}/${npcId}`);
    return { sourceNpc: npcId, targetMap: maps[index], targetNpc: npcs[index] };
  }

  private number(table: string, id: string, key: string): number {
    const field = this.data.field(table, id, key);
    if (field.presence === 'absent' || typeof field.value !== 'number' || !Number.isFinite(field.value)) throw new Error(`Original numeric field missing: ${table}/${id}/${key}`);
    return field.value;
  }

  private numberArray(value: JsonValue, label: string): number[] {
    if (!Array.isArray(value) || !value.every((item): item is number => typeof item === 'number' && Number.isSafeInteger(item))) {
      throw new Error(`Invalid original reference array ${label}`);
    }
    return value;
  }
}
