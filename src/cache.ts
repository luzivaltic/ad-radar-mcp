/** In-process TTL cache so repeated agent calls in one conversation cost one run. */

type Entry = { value: unknown; expires: number };

const MAX_ENTRIES = 300;

export class TtlCache {
  private map = new Map<string, Entry>();

  constructor(private ttlMs: number) {}

  get<T>(key: string): T | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return hit.value as T;
  }

  set(key: string, value: unknown): void {
    if (this.map.size >= MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  /** Returns the cached value or produces, caches and returns a fresh one. */
  async wrap<T>(key: string, produce: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit) return hit;
    const value = await produce();
    this.set(key, value);
    return value;
  }
}

export function cacheKey(parts: Record<string, unknown>): string {
  return Object.keys(parts)
    .sort()
    .map((k) => `${k}=${String(parts[k])}`)
    .join("&");
}
