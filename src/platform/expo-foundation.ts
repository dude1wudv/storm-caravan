import { fetch as nativeFetch } from 'expo/fetch';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { openDatabaseSync } from 'expo-sqlite';
import { OriginalTables, type SourceProof } from '../foundation/original-data';
import { SaveStore, type StateCodec } from '../foundation/save-store';
import { ServiceClient } from '../foundation/service-client';

/** Separate database: never opens, migrates or deletes original-client or old-prototype saves. */
export function openLocalSaveStore<T>(codec: StateCodec<T>): { store: SaveStore<T>; close(): void } {
  const db = openDatabaseSync('alloy-2581-reconstruction.db', { useNewConnection: true });
  try {
    db.execSync('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    const store = new SaveStore(db, codec);
    return { store, close: () => db.closeSync() };
  } catch (error) {
    db.closeSync();
    throw error;
  }
}

export function loadOriginalTables(text: string, proof: SourceProof, root: 'tables' | 'document'): Promise<OriginalTables> {
  return OriginalTables.load(text, proof, (value) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value), root);
}

/** Expo's native request disables both OkHttp redirect flags for redirect:error. */
export function createServiceClient(baseUrl: string | null): ServiceClient {
  return new ServiceClient(baseUrl, nativeFetch);
}
