/**
 * ジャンルマスタ（docs/data/genre-master.json）を作るエントリポイント。
 *
 * 日次の抽出とは別に動かす。ジャンルツリーはめったに変わらないうえ、
 * 毎日 40 リクエストを足すと日次バッチの所要時間と楽天への負荷が無駄に増えるため。
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { buildGenreMaster, type GenreMasterFile } from './genreMaster.js';
import { ensureDir } from './io.js';
import { RakutenClient } from './rakuten/client.js';
import { nowJstIso } from './util/datetime.js';

const DEFAULT_SITE_URL = 'https://t1009hayashi-cell.github.io/room-picker/';

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function parseArgs(argv: string[]): { dataDir: string; maxLevel: number } {
  let dataDir = DATA_DIR;
  let maxLevel = 2;
  for (const arg of argv) {
    if (arg.startsWith('--data-dir=')) dataDir = arg.slice('--data-dir='.length);
    else if (arg.startsWith('--max-level=')) maxLevel = Number(arg.slice('--max-level='.length)) || 2;
  }
  return { dataDir, maxLevel };
}

async function main(): Promise<void> {
  const { dataDir, maxLevel } = parseArgs(process.argv.slice(2));

  const applicationId = process.env.RAKUTEN_APPLICATION_ID?.trim() || null;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY?.trim() || null;
  const missing = [
    applicationId ? null : 'RAKUTEN_APPLICATION_ID（アプリケーションID）',
    accessKey ? null : 'RAKUTEN_ACCESS_KEY（アクセスキー）',
  ].filter((x): x is string => x !== null);
  if (missing.length > 0) {
    throw new Error(`環境変数 ${missing.join(' と ')} が未設定です`);
  }

  const client = new RakutenClient({
    applicationId: applicationId!,
    accessKey: accessKey!,
    affiliateId: process.env.RAKUTEN_AFFILIATE_ID?.trim() || null,
    intervalMs: Number(process.env.RAKUTEN_REQUEST_INTERVAL_MS ?? 1100),
    siteUrl: process.env.RAKUTEN_SITE_URL?.trim() || DEFAULT_SITE_URL,
    onLog: log,
  });

  const warnings: string[] = [];
  log(`ジャンルマスタを取得します（第${maxLevel}階層まで）`);
  const genres = await buildGenreMaster((genreId) => client.fetchGenre(genreId), {
    maxLevel,
    onLog: log,
    onWarn: (m) => {
      warnings.push(m);
      log(`警告: ${m}`);
    },
  });

  if (genres.length === 0) {
    // 空で上書きすると設定画面のジャンル検索が黙って使えなくなるため、既存ファイルを残す
    throw new Error('ジャンルを1件も取得できませんでした。既存の genre-master.json は残します');
  }

  const file: GenreMasterFile = { updatedAt: nowJstIso(), maxLevel, genres };
  const out = path.join(dataDir, 'genre-master.json');
  await ensureDir(dataDir);
  await writeFile(out, JSON.stringify(file), 'utf-8');

  log(`完了: ${genres.length}件を ${out} に書き出しました`);
  if (warnings.length > 0) log(`取得できなかったジャンル ${warnings.length}件（上記の警告を参照）`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
});
