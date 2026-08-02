import { createHash } from 'node:crypto';
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
  // GitHub Secrets への貼り付け時に末尾改行や前後の空白が混入することがある。
  // 混入したままURLのクエリパラメータに使うと、楽天APIが「specify valid applicationId」
  // として拒否する（実際にCIで発生した）。防御的にtrimし、空文字はnull扱いにする。
  const rawApplicationId = process.env.RAKUTEN_APPLICATION_ID ?? '';
  const applicationId = rawApplicationId.trim() || null;

  log(`room-assist: ${date} の抽出を開始します（${args.mock ? 'モック' : '実API'}）`);
  if (!args.mock) {
    // 値そのものは一切ログに出さない（Publicリポジトリのため）。
    // 長さ・空白混入・引用符混入の有無だけを安全に確認する。
    // 指紋はハッシュの先頭8桁で、ここから元の値は復元できない。
    // Secret を差し替えたときに実際に値が変わったかを判定するために出す。
    const fingerprint = applicationId
      ? createHash('sha256').update(applicationId).digest('hex').slice(0, 8)
      : '(なし)';
    log(
      `RAKUTEN_APPLICATION_ID診断: 生の長さ=${rawApplicationId.length}文字 / trim後=${applicationId?.length ?? 0}文字 / ` +
        `前後に空白または改行あり=${rawApplicationId !== rawApplicationId.trim()} / ` +
        `引用符を含む=${/^["']|["']$/.test(rawApplicationId)} / ` +
        `UUID形式=${applicationId ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(applicationId) : false} / ` +
        `指紋=${fingerprint}`,
    );
  }

  let fetcher: GenreFetcher;
  if (args.mock) {
    fetcher = {
      ranking: async (genre) => mockFetchResult(buildMockRanking(genre, { now })),
      search: async (genre) => mockFetchResult(buildMockSearch(genre, { now })),
    };
  } else {
    if (!applicationId) {
      throw new Error(
        '環境変数 RAKUTEN_APPLICATION_ID が未設定です。実APIを叩かずに試す場合は --mock を付けてください',
      );
    }
    const siteUrl = process.env.RAKUTEN_SITE_URL?.trim() || DEFAULT_SITE_URL;
    log(`許可されたウェブサイトとして ${siteUrl} を名乗ります`);

    const client = new RakutenClient({
      applicationId,
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
