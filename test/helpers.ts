import { loadConfig, type AppConfig } from '../src/config.js';

let cached: AppConfig | null = null;

/** 実際の config/*.json を使ってテストする。設定値を変えたら壊れることを検知したいため */
export async function config(): Promise<AppConfig> {
  if (!cached) cached = await loadConfig();
  return cached;
}

export const FIXED_NOW = new Date('2026-08-01T06:00:00+09:00');
