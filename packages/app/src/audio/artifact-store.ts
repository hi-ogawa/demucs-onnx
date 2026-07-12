import type { ModelArtifact, ModelFilename } from "./models";

const DATABASE_NAME = "demucs-artifacts-v1";
const STORE_NAME = "artifacts";

export type StoredModelArtifact = ModelArtifact & {
  size: number;
  importedAt: number;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "name" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadStoredModels(): Promise<StoredModelArtifact[]> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .getAll();
      request.onsuccess = () =>
        resolve(request.result as StoredModelArtifact[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

export async function storeModels(files: File[]): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const importedAt = Date.now();
      for (const file of files) {
        store.put({
          name: file.name as ModelFilename,
          blob: file,
          size: file.size,
          importedAt,
        } satisfies StoredModelArtifact);
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
