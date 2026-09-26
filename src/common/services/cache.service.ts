import { createMemoryCacheService } from "./memoryCache.service.js";

export interface CacheService {
  readonly get: <T>(key: string) => Promise<T | null>;
  readonly set: (key: string, value: unknown, ttlSeconds?: number) => Promise<void>;
  readonly del: (key: string) => Promise<void>;
  readonly delByPattern: (pattern: string) => Promise<void>;
  readonly increment: (key: string, ttlSeconds?: number) => Promise<number>;
  readonly isAvailable: () => boolean;
}

export const createCacheService = (): CacheService => createMemoryCacheService();
