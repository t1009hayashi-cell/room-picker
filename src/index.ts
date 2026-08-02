import { DATA_DIR, loadConfig } from './config.js';
import { rebuildIndex, readSales, readSnapshot, writeSales, writeSnapshot } from './io.js';
import { buildDailySnapshot, makeLiveFetcher, type GenreFetcher } from './pipeline.js';
import { RakutenClient } from './rakuten/client.js';
import { buildMockRanking, buildMockSearch, mockFetchResult } from './rakuten/mock.js';
import { collectSaleInputs, detectSales, mergeSales } from './sales.js';
import type { NormalizedItem } from './types.js';
import { addDays, nowJstIso, toJstDateKey } from './util/datetime.js';

/**
 * 楽天ウェブサービスのアプリ設定「許可されたウェブサイト」に登録した公開URL。
 * リポジトリを移した場合は環境変数 RAKUTEN_SITE_URL で上書きする。
 */
const DEFAULT_SITE_URL = 'https://t1009hayashi-cell.github.io/room-picker/';

interface Args {
  mock: boolean;
  date: string | null;
  dataDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mock: false, date: null, dataDir: DATA_DIR };
  for (const arg of argv) {
    if (arg === '--mock') args.mock = true;
    else if (arg.startsWith('--date=')) args.date = arg.slice('--date='.length);
    else if (arg.startsWith('--data-dir=')) args.dataDir = arg.slice('--data-dir='.length);
  }
  return args;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();

  const now = args.date ? new Date(`${args.date}T06:00:00+09:00`) : new Date();
  const date = toJstDateKey(now);
  // Secrets への貼り付けで前後に空白や改行が混入することがあるため防御的に trim する
  const applicationId = process.env.RAKUTEN_APPLICATION_ID?.trim() || null;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY?.trim() || null;

  log(`room-assist: ${date} の抽出を開始します（${args.mock ? 'モック' : '実API'}）`);

  let fetcher: GenreFetcher;
  if (args.mock) {
    fetcher = {
      ranking: async (genre) => mockFetchResult(buildMockRanking(genre, { now })),
      search: async (genre) => mockFetchResult(buildMockSearch(genre, { now })),
    };
  } else {
    // 2026年の新APIでは applicationId と accessKey の両方が必須
    const missing = [
      applicationId ? null : 'RAKUTEN_APPLICATION_ID（アプリケーションID）',
      accessKey ? null : 'RAKUTEN_ACCESS_KEY（アクセスキー）',
    ].filter((x): x is string => x !== null);
    if (missing.length > 0) {
      throw new Error(
        `環境変数 ${missing.join(' と ')} が未設定です。` +
          '楽天アプリ管理画面の値を設定してください。実APIを叩かずに試す場合は --mock を付けてください',
      );
    }

    const siteUrl = process.env.RAKUTEN_SITE_URL?.trim() || DEFAULT_SITE_URL;

    const client = new RakutenClient({
      applicationId: applicationId!,
      accessKey: accessKey!,
      affiliateId: process.env.RAKUTEN_AFFILIATE_ID?.trim() || null,
      intervalMs: Number(process.env.RAKUTEN_REQUEST_INTERVAL_MS ?? 1100),
      siteUrl,
      onLog: log,
    });
    fetcher = makeLiveFetcher(client, config);
  }

  const prev = await readSnapshot(args.dataDir, addDays(date, -1));
  if (!prev) log('前日のスナップショットがありません。順位変動なしとして処理します（仕様書 6.4）');

  const snapshot = await buildDailySnapshot({
    config,
    fetcher,
    prev,
    now,
    applicationId,
    generatedBy: args.mock ? 'mock' : 'live',
    onLog: log,
  });

  await writeSnapshot(args.dataDir, snapshot);

  const allItems: NormalizedItem[] = snapshot.genres.flatMap((g) => g.items);
  const detected = detectSales(collectSaleInputs(allItems), config.scoring, now);
  const previousSales = await readSales(args.dataDir);
  await writeSales(args.dataDir, {
    updatedAt: nowJstIso(now),
    sales: mergeSales(previousSales?.sales ?? [], detected),
  });

  const index = await rebuildIndex(args.dataDir);

  const kept = allItems.filter((i) => !i.excluded).length;
  const warnings = snapshot.genres.flatMap((g) => g.warnings);
  log(`完了: ${allItems.length}件取得 / ${kept}件が条件通過 / セール${detected.length}件を自動検出`);
  log(`data/index.json: ${index.dates.length}日分`);
  if (warnings.length > 0) log(`警告 ${warnings.length}件:\n  - ${warnings.join('\n  - ')}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
});
