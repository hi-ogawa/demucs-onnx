// Promise wrapper for a single IndexedDB object store.
export class IdbStore<T> {
  private databasePromise: Promise<IDBDatabase> | undefined;

  constructor(
    private options: {
      databaseName: string;
      storeName: string;
      version: number;
      keyPath: string;
    },
  ) {}

  async getAll(): Promise<T[]> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const request = database
        .transaction(this.options.storeName, "readonly")
        .objectStore(this.options.storeName)
        .getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
  }

  async putAll(values: T[]): Promise<void> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        this.options.storeName,
        "readwrite",
      );
      const store = transaction.objectStore(this.options.storeName);
      for (const value of values) {
        store.put(value);
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) {
      return this.databasePromise;
    }

    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(
        this.options.databaseName,
        this.options.version,
      );
      request.onupgradeneeded = () => {
        request.result.createObjectStore(this.options.storeName, {
          keyPath: this.options.keyPath,
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.databasePromise;
  }
}
