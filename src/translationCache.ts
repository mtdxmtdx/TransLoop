import { load, type Store } from "@tauri-apps/plugin-store";

export interface TranslationCacheRecord {
  cacheKey: string;
  sourceHash: string;
  fromLang: string;
  toLang: string;
  translation: string;
  createdAt: string;
  lastHitAt: string;
  hitCount: number;
}

const CACHE_FILE = "translation-cache.json";
const CACHE_KEY = "records";
const MAX_CACHE = 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

let cacheStorePromise: Promise<Store> | null = null;

async function getCacheStore(): Promise<Store> {
  if (!cacheStorePromise) {
    cacheStorePromise = load(CACHE_FILE, { autoSave: true, defaults: {} });
  }
  return cacheStorePromise;
}

export async function getCachedTranslation(
  text: string,
  fromLang: string,
  toLang: string,
): Promise<TranslationCacheRecord | null> {
  const store = await getCacheStore();
  const records = trimCache((await store.get<TranslationCacheRecord[]>(CACHE_KEY)) ?? []);
  const cacheKey = createCacheKey(text, fromLang, toLang);
  const hit = records.find((record) => record.cacheKey === cacheKey);
  if (!hit) {
    await persistIfTrimmed(store, records);
    return null;
  }

  const nextHit: TranslationCacheRecord = {
    ...hit,
    hitCount: hit.hitCount + 1,
    lastHitAt: new Date().toISOString(),
  };
  await store.set(
    CACHE_KEY,
    [nextHit, ...records.filter((record) => record.cacheKey !== cacheKey)],
  );
  await store.save();
  return nextHit;
}

export async function setCachedTranslation(input: {
  text: string;
  fromLang: string;
  toLang: string;
  translation: string;
}): Promise<void> {
  if (!input.text.trim() || !input.translation.trim()) return;

  const store = await getCacheStore();
  const records = trimCache((await store.get<TranslationCacheRecord[]>(CACHE_KEY)) ?? []);
  const sourceHash = hashText(normalizeSource(input.text));
  const cacheKey = createCacheKey(input.text, input.fromLang, input.toLang);
  const now = new Date().toISOString();
  const record: TranslationCacheRecord = {
    cacheKey,
    sourceHash,
    fromLang: input.fromLang,
    toLang: input.toLang,
    translation: input.translation,
    createdAt: now,
    lastHitAt: now,
    hitCount: 0,
  };
  await store.set(
    CACHE_KEY,
    [record, ...records.filter((item) => item.cacheKey !== cacheKey)].slice(0, MAX_CACHE),
  );
  await store.save();
}

export async function clearTranslationCache(): Promise<void> {
  const store = await getCacheStore();
  await store.set(CACHE_KEY, []);
  await store.save();
}

function createCacheKey(text: string, fromLang: string, toLang: string): string {
  return `${hashText(normalizeSource(text))}:${fromLang}:${toLang}`;
}

function normalizeSource(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function trimCache(records: TranslationCacheRecord[]): TranslationCacheRecord[] {
  const minTime = Date.now() - MAX_AGE_MS;
  return records
    .filter((record) => Date.parse(record.createdAt) >= minTime)
    .sort((a, b) => b.lastHitAt.localeCompare(a.lastHitAt))
    .slice(0, MAX_CACHE);
}

async function persistIfTrimmed(
  store: Store,
  records: TranslationCacheRecord[],
): Promise<void> {
  const current = (await store.get<TranslationCacheRecord[]>(CACHE_KEY)) ?? [];
  if (current.length !== records.length) {
    await store.set(CACHE_KEY, records);
    await store.save();
  }
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
