import { validateRecording } from "./player.js";

const DB_NAME = "orbit-replays";
const STORE_NAME = "recordings";
const DB_VERSION = 1;

const canUseIndexedDb = () => typeof indexedDB !== "undefined";
const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("IndexedDB 操作失败"));
});

/** 内存仓库用于测试和无 IndexedDB 浏览器的当前会话降级。 */
export class MemoryReplayRepository {
  constructor() { this.records = new Map(); }
  async put(recording) { this.records.set(recording.id, recording); return recording; }
  async getAll() { return [...this.records.values()]; }
  async get(id) { return this.records.get(id) ?? null; }
  async delete(id) { this.records.delete(id); }
}

export class ReplayStorage {
  constructor({ indexedDBFactory = globalThis.indexedDB, limit = 10, maxBytes = 64 * 1024 * 1024,
    fallback = new MemoryReplayRepository() } = {}) {
    this.indexedDBFactory = indexedDBFactory;
    this.limit = limit;
    this.maxBytes = maxBytes;
    this.fallback = fallback;
    this.database = null;
    this.mode = indexedDBFactory ? "unopened" : "memory";
    this.lastError = "";
  }

  async open() {
    if (this.database) return this.database;
    if (!this.indexedDBFactory || !canUseIndexedDb()) {
      this.mode = "memory";
      return null;
    }
    try {
      this.database = await new Promise((resolve, reject) => {
        const request = this.indexedDBFactory.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("无法打开录像数据库"));
        request.onblocked = () => reject(new Error("录像数据库被其他标签页占用"));
      });
      this.mode = "indexeddb";
      return this.database;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.mode = "memory";
      return null;
    }
  }

  async save(recording) {
    validateRecording(recording);
    const db = await this.open();
    if (!db) {
      await this.fallback.put(recording);
      this.lastError = this.lastError || "当前浏览器无法持久保存录像，本次页面内仍可播放";
      return recording;
    }
    try {
      await this._trimFor(db, recording.size ?? JSON.stringify(recording).length);
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(recording);
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error ?? new Error("录像写入失败"));
        transaction.onabort = () => reject(transaction.error ?? new Error("录像写入被取消"));
      });
      this.mode = "indexeddb";
      this.lastError = "";
      return recording;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.fallback.put(recording);
      return recording;
    }
  }

  async list() {
    const db = await this.open();
    let records;
    if (!db) records = await this.fallback.getAll();
    else {
      try {
        const transaction = db.transaction(STORE_NAME, "readonly");
        records = await requestResult(transaction.objectStore(STORE_NAME).getAll());
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        records = await this.fallback.getAll();
      }
    }
    return records.filter(record => {
      try { validateRecording(record); return true; } catch { return false; }
    }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async get(id) {
    const db = await this.open();
    if (!db) return this.fallback.get(id);
    try {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const record = await requestResult(transaction.objectStore(STORE_NAME).get(id));
      if (!record) return this.fallback.get(id);
      try { return validateRecording(record); } catch { return this.fallback.get(id); }
    } catch {
      return this.fallback.get(id);
    }
  }

  async delete(id) {
    const db = await this.open();
    if (!db) return this.fallback.delete(id);
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error ?? new Error("录像删除失败"));
    });
    await this.fallback.delete(id);
  }

  async _trimFor(db, incomingBytes = 0) {
    const records = await this.list();
    let total = incomingBytes + records.reduce((sum, record) => sum + Number(record.size ?? 0), 0);
    const remove = [];
    while (records.length && (records.length + 1 > this.limit || total > this.maxBytes)) {
      const oldest = records.pop();
      remove.push(oldest.id);
      total -= Number(oldest.size ?? 0);
    }
    if (!remove.length) return;
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const id of remove) store.delete(id);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error ?? new Error("旧录像清理失败"));
    });
  }
}
