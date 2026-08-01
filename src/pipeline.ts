import type { AppConfig } from './config.js';
import { buildDraftComments } from './comment.js';
import { buildPrevRankIndex, calcRankDiff, type PrevRankIndex } from './diff.js';
import { evaluateExclusion } from './filter.js';
import { mergeByItemCode, normalizeItem, sortByRank, type NormalizedBase } from './normalize.js';
import type { FetchResult, RakutenClient } from './rakuten/client.js';
import { calcEstimatedReward } from './reward.js';
import { calcHotScore } from './score.js';
import type { DailySnapshot, GenreConfig, GenreSnapshot, NormalizedItem } from './types.js';
import { addDays, jstDayStart, nowJstIso, toJstDateKey } from './util/datetime.js';

export interface GenreFetcher {
  ranking(genre: GenreConfig): Promise<FetchResult>;
  search(genre: GenreConfig): Promise<FetchResult>;
}

export function makeLiveFetcher(client: RakutenClient, config: AppConfig): GenreFetcher {
  return {
    ranking: (genre) => client.fetchRanking(genre.genreId),
    search: (genre) =>
      client.fetchSearch({
        genreId: genre.genreId,
        // 除外処理は可能な限りAPI側に寄せる（仕様書 4.2）。
        // ただし minPrice は送らない。検索APIの minPrice は itemPrice に対して効くため、
        // 仕様書6.1が「取り逃すな」と名指しした価格帯商品（itemPrice 2788 / itemPriceMax 8888）が
        // API側で落ちてしまう。価格の足切りは itemPriceMax を見る filter.ts に任せる。
        ngKeyword: config.ngWords.searchNgKeyword,
        sort: '-reviewCount',
      }),
  };
}

/**
 * 仕様書 4.1.1。レスポンスの title にジャンル名が含まれるかを検査する。
 * 指定漏れで総合ランキングを取り込むと、まったく無関係な商品が混入する。
 */
export function checkGenreTitle(title: string, genre: GenreConfig): string | null {
  if (title === '') return `ジャンル「${genre.genreName}」: レスポンスに title がありません。ジャンル指定を確認してください`;
  if (!title.includes(genre.genreName)) {
    return `ジャンル「${genre.genreName}」: レスポンスの title が「${title}」でした。総合ランキングを取り込んでいる可能性があります`;
  }
  return null;
}

export interface BuildOptions {
  config: AppConfig;
  fetcher: GenreFetcher;
  prev: DailySnapshot | null;
  now: Date;
  applicationId?: string | null;
  generatedBy: 'live' | 'mock';
  onLog?: (message: string) => void;
}

function enrich(
  base: NormalizedBase,
  genre: GenreConfig,
  options: BuildOptions,
  prevIndex: PrevRankIndex,
  earliestPostingDate: Date,
  month: number,
): NormalizedItem {
  const { scoring, ngWords } = options.config;

  const diff = calcRankDiff(base.itemCode, base.rank, base.source, prevIndex);
  const reward = calcEstimatedReward(base, scoring);
  const hotScore = calcHotScore(
    {
      source: base.source,
      rank: base.rank,
      prevRank: diff.prevRank,
      isNew: diff.isNew,
      hasPrevSnapshot: prevIndex.hasPrevSnapshot,
      reviewCount: base.reviewCount,
      itemPrice: base.itemPrice,
      isRateBoosted: base.isRateBoosted,
      pointRate: base.pointRate,
    },
    scoring,
  );
  const exclusion = evaluateExclusion(base, scoring, ngWords, earliestPostingDate);

  return {
    ...base,
    ...diff,
    estimatedReward: reward.estimatedReward,
    rewardCapApplied: reward.rewardCapApplied,
    hotScore,
    ...exclusion,
    draftComments: buildDraftComments(
      {
        itemName: base.itemName,
        genreName: genre.genreName,
        itemPrice: base.itemPrice,
        reviewCount: base.reviewCount,
        reviewAverage: base.reviewAverage,
        postageFlag: base.postageFlag,
        pointRate: base.pointRate,
        month,
      },
      scoring,
      ngWords,
    ),
  };
}

/** 1ジャンル分を取得して正規化・採点する */
export async function buildGenreSnapshot(
  genre: GenreConfig,
  options: BuildOptions,
  prevIndex: PrevRankIndex,
): Promise<GenreSnapshot> {
  const log = options.onLog ?? (() => {});
  const warnings: string[] = [];
  const dateKey = toJstDateKey(options.now);
  // 最短の投稿予定日は抽出日の翌日（仕様書 7）
  const earliestPostingDate = jstDayStart(addDays(dateKey, 1));
  const month = Number(dateKey.slice(5, 7));

  const normalizeCtx = { genre, scoring: options.config.scoring, applicationId: options.applicationId ?? null };

  const ranking = await options.fetcher.ranking(genre);
  const titleWarning = checkGenreTitle(ranking.title, genre);
  if (titleWarning) {
    warnings.push(titleWarning);
    log(`WARN ${titleWarning}`);
  }
  const rankingItems = sortByRank(
    ranking.items
      .map((raw) => normalizeItem(raw, { ...normalizeCtx, source: 'ranking' }))
      .filter((item): item is NormalizedBase => item !== null),
  );

  let searchItems: NormalizedBase[] = [];
  try {
    const search = await options.fetcher.search(genre);
    searchItems = search.items
      .map((raw) => normalizeItem(raw, { ...normalizeCtx, source: 'search' }))
      .filter((item): item is NormalizedBase => item !== null);
  } catch (err) {
    // 検索APIは母集団を広げるための補助。落ちてもランキング分は出す
    const message = `ジャンル「${genre.genreName}」: 検索APIの取得に失敗しました（${(err as Error).message}）`;
    warnings.push(message);
    log(`WARN ${message}`);
  }

  const merged = mergeByItemCode(rankingItems, searchItems);
  const items = merged.map((base) => enrich(base, genre, options, prevIndex, earliestPostingDate, month));

  log(
    `  ${genre.genreName}: ranking=${rankingItems.length} search=${searchItems.length} merged=${items.length} 除外=${items.filter((i) => i.excluded).length}`,
  );

  return {
    genreId: genre.genreId,
    genreName: genre.genreName,
    commissionRate: genre.commissionRate,
    warnings,
    items,
  };
}

/** 全ジャンルを直列で処理する（仕様書 4.3: ジャンル数が増えても直列実行とする） */
export async function buildDailySnapshot(options: BuildOptions): Promise<DailySnapshot> {
  const prevIndex = buildPrevRankIndex(options.prev);
  const genres: GenreSnapshot[] = [];

  for (const genre of options.config.genres) {
    genres.push(await buildGenreSnapshot(genre, options, prevIndex));
  }

  return {
    fetchedAt: nowJstIso(options.now),
    date: toJstDateKey(options.now),
    generatedBy: options.generatedBy,
    genres,
  };
}
