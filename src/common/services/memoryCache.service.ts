import type { CacheService } from "./cache.service.js";

interface CacheEntry {
  readonly value: string;
  readonly expiresAt: number | null;
}

export const createMemoryCacheService = (): CacheService => {
  const store = new Map<string, CacheEntry>();

  // Periodic cleanup of expired entries
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        store.delete(key);
      }
    }
  }, 30_000);

  // Prevent the interval from keeping the process alive
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  const isExpired = (entry: CacheEntry): boolean =>
    entry.expiresAt !== null && Date.now() > entry.expiresAt;

  return Object.freeze({
    get: async <T>(key: string): Promise<T | null> => {
      const entry = store.get(key);
      if (!entry || isExpired(entry)) {
        if (entry) store.delete(key);
        return null;
      }
      return JSON.parse(entry.value) as T;
    },

    set: async (key: string, value: unknown, ttlSeconds?: number): Promise<void> => {
      const entry: CacheEntry = {
        value: JSON.stringify(value),
        expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
      };
      store.set(key, entry);
    },

    del: async (key: string): Promise<void> => {
      store.delete(key);
    },

    delByPattern: async (pattern: string): Promise<void> => {
      const regex = new RegExp(`^${pattern.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
      for (const key of store.keys()) {
        if (regex.test(key)) {
          store.delete(key);
        }
      }
    },

    increment: async (key: string, ttlSeconds?: number): Promise<number> => {
      const existing = store.get(key);
      if (!existing || isExpired(existing)) {
        store.set(key, {
          value: "1",
          expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
        });
        return 1;
      }
      const newVal = Number.parseInt(existing.value, 10) + 1;
      store.set(key, {
        value: String(newVal),
        expiresAt: existing.expiresAt,
      });
      return newVal;
    },

    isAvailable: () => true,
  });
};
