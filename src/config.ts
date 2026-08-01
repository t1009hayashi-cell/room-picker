import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { GenreConfig, NgWordsConfig, ScoringConfig } from './types.js';

/** dist/src/config.js から見たリポジトリルート */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
export const CONFIG_DIR = path.join(REPO_ROOT, 'config');
/** GitHub Pages は main ブランチの /docs を公開ルートにする想定 */
export const DOCS_DIR = path.join(REPO_ROOT, 'docs');
export const DATA_DIR = path.join(DOCS_DIR, 'data');

async function readJson<T>(file: string): Promise<T> {
  const text = await readFile(file, 'utf-8');
  return JSON.parse(text) as T;
}

export interface AppConfig {
  genres: GenreConfig[];
  ngWords: NgWordsConfig;
  scoring: ScoringConfig;
}

export async function loadConfig(configDir: string = CONFIG_DIR): Promise<AppConfig> {
  const [genresFile, ngWords, scoring] = await Promise.all([
    readJson<{ genres: GenreConfig[] }>(path.join(configDir, 'genres.json')),
    readJson<NgWordsConfig>(path.join(configDir, 'ng-words.json')),
    readJson<ScoringConfig>(path.join(configDir, 'scoring.json')),
  ]);

  const genres = genresFile.genres.filter((g) => g.enabled !== false);
  if (genres.length === 0) {
    throw new Error('config/genres.json に有効なジャンルが1件もありません');
  }
  return { genres, ngWords, scoring };
}
