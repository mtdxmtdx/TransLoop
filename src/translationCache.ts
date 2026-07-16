import { invoke } from "@tauri-apps/api/core";

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

const MAX_CACHE = 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function readCache(): Promise<TranslationCacheRecord[]> {
  return invoke<TranslationCacheRecord[]>("secure_cache_get");
}

async function writeCache(records: TranslationCacheRecord[]): Promise<void> {
  await invoke("secure_cache_put", { records });
}

export async function getCachedTranslation(
  text: string,
  fromLang: string,
  toLang: string,
): Promise<TranslationCacheRecord | null> {
  const records = trimCache(await readCache());
  const cacheKey = await createCacheKey(text, fromLang, toLang);
  const hit = records.find((record) => record.cacheKey === cacheKey);
  if (!hit) {
    if (records.length !== (await readCache()).length) await writeCache(records);
    return null;
  }
  const nextHit: TranslationCacheRecord = {
    ...hit,
    hitCount: hit.hitCount + 1,
    lastHitAt: new Date().toISOString(),
  };
  await writeCache([nextHit, ...records.filter((record) => record.cacheKey !== cacheKey)]);
  return nextHit;
}

export async function setCachedTranslation(input: {
  text: string;
  fromLang: string;
  toLang: string;
  translation: string;
}): Promise<void> {
  if (!input.text.trim() || !input.translation.trim()) return;
  const records = trimCache(await readCache());
  const sourceHash = await hashText(normalizeSource(input.text));
  const cacheKey = await createCacheKey(input.text, input.fromLang, input.toLang);
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
  await writeCache([record, ...records.filter((item) => item.cacheKey !== cacheKey)].slice(0, MAX_CACHE));
}

export async function clearTranslationCache(): Promise<void> {
  await invoke("secure_cache_clear");
}

async function createCacheKey(text: string, fromLang: string, toLang: string): Promise<string> {
  return `${await hashText(normalizeSource(text))}:${fromLang}:${toLang}`;
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

async function hashText(text: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) throw new Error("当前环境不支持安全哈希。");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
