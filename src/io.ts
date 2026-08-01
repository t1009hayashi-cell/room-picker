import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DailySnapshot, IndexFile, SalesFile } from './types.js';
import { nowJstIso } from './util/datetime.js';

const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function readJsonIfExists<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writeJson(file: string, value: unknown, pretty = true): Promise<void> {
  await ensureDir(path.dirname(file));
  const text = pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value);
  await writeFile(file, text, 'utf-8');
}

export function snapshotPath(dataDir: string, date: string): string {
  return path.join(dataDir, `${date}.json`);
}

export function readSnapshot(dataDir: string, date: string): Promise<DailySnapshot | null> {
  return readJsonIfExists<DailySnapshot>(snapshotPath(dataDir, date));
}

/**
 * 日次JSONは毎日新規ファイルとして追加され、既存ファイルを書き換えないため、
 * 差分の読みやすさより転送量を優先して最小化して書き出す（iPhoneの回線で毎日読む前提）。
 */
export function writeSnapshot(dataDir: string, snapshot: DailySnapshot): Promise<void> {
  return writeJson(snapshotPath(dataDir, snapshot.date), snapshot, false);
}

export function readSales(dataDir: string): Promise<SalesFile | null> {
  return readJsonIfExists<SalesFile>(path.join(dataDir, 'sales.json'));
}

export function writeSales(dataDir: string, sales: SalesFile): Promise<void> {
  return writeJson(path.join(dataDir, 'sales.json'), sales);
}

/** data/index.json を実ファイルから作り直す。PWA が利用可能な日付を把握するために使う（仕様書 5.1） */
export async function rebuildIndex(dataDir: string): Promise<IndexFile> {
  await ensureDir(dataDir);
  const entries = await readdir(dataDir);
  const dates = entries
    .map((name) => DATE_FILE.exec(name)?.[1])
    .filter((d): d is string => typeof d === 'string')
    .sort();

  const index: IndexFile = {
    updatedAt: nowJstIso(),
    dates,
    latest: dates.length > 0 ? dates[dates.length - 1]! : null,
  };
  await writeJson(path.join(dataDir, 'index.json'), index);
  return index;
}
