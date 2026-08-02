import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGenreMaster } from '../src/genreMaster.js';
import { parseGenreResponse, type GenreSearchResult } from '../src/rakuten/client.js';

describe('ジャンル検索レスポンスの解釈', () => {
  it('現行版(20260701)の genre / nameJa / level を読む', () => {
    const result = parseGenreResponse({
      genre: { genreId: '100227', nameJa: '食品', level: 1 },
      children: [
        { genreId: '100316', nameJa: '水・ソフトドリンク', level: 2 },
        { genreId: '100356', nameJa: 'コーヒー', level: 2 },
      ],
    });

    assert.deepEqual(result.current, { genreId: '100227', genreName: '食品', level: 1 });
    assert.equal(result.children.length, 2);
    assert.deepEqual(result.children[0], { genreId: '100316', genreName: '水・ソフトドリンク', level: 2 });
  });

  it('旧版の current / child / genreName でも読める（版が戻っても壊れない）', () => {
    const result = parseGenreResponse({
      current: { genreId: '100227', genreName: '食品', genreLevel: 1 },
      children: [{ child: { genreId: '100356', genreName: 'コーヒー', genreLevel: 2 } }],
    });

    assert.deepEqual(result.current, { genreId: '100227', genreName: '食品', level: 1 });
    assert.deepEqual(result.children[0], { genreId: '100356', genreName: 'コーヒー', level: 2 });
  });

  it('genreId は数値で返ってきても文字列に揃える（config/genres.json と突き合わせるため）', () => {
    const result = parseGenreResponse({ children: [{ genreId: 100227, nameJa: '食品', level: 1 }] });
    assert.equal(result.children[0]?.genreId, '100227');
    assert.equal(typeof result.children[0]?.genreId, 'string');
  });

  it('壊れた要素は捨てて、読める分だけ返す', () => {
    const result = parseGenreResponse({
      children: [{ genreId: '1', nameJa: 'あ', level: 1 }, { nameJa: '名前だけ' }, null, 'ゴミ'],
    });
    assert.equal(result.children.length, 1);
  });

  it('空やnullでも例外を投げない', () => {
    assert.deepEqual(parseGenreResponse(null), { current: null, children: [] });
    assert.deepEqual(parseGenreResponse({}), { current: null, children: [] });
  });
});

/** ルート → 第1階層 → 第2階層 を返す偽のAPI */
function fakeApi(): { fetch: (id: string) => Promise<GenreSearchResult>; calls: string[] } {
  const calls: string[] = [];
  const tree: Record<string, GenreSearchResult> = {
    '0': {
      current: null,
      children: [
        { genreId: '100227', genreName: '食品', level: 1 },
        { genreId: '215783', genreName: '日用品雑貨', level: 1 },
      ],
    },
    '100227': {
      current: { genreId: '100227', genreName: '食品', level: 1 },
      children: [
        { genreId: '100356', genreName: 'コーヒー', level: 2 },
        { genreId: '551167', genreName: 'スイーツ・お菓子', level: 2 },
      ],
    },
    '215783': {
      current: { genreId: '215783', genreName: '日用品雑貨', level: 1 },
      children: [{ genreId: '215784', genreName: '洗剤', level: 2 }],
    },
  };
  return {
    calls,
    fetch: async (id) => {
      calls.push(id);
      return tree[id] ?? { current: null, children: [] };
    },
  };
}

describe('ジャンルマスタの組み立て', () => {
  it('第2階層まで辿り、親の名前を付けたパスを持たせる', async () => {
    const api = fakeApi();
    const entries = await buildGenreMaster(api.fetch);

    assert.equal(entries.length, 5);
    const coffee = entries.find((e) => e.genreId === '100356');
    assert.deepEqual(coffee, {
      genreId: '100356',
      genreName: 'コーヒー',
      level: 2,
      parentId: '100227',
      parentName: '食品',
      path: '食品 > コーヒー',
    });

    const food = entries.find((e) => e.genreId === '100227');
    assert.equal(food?.parentId, null);
    assert.equal(food?.path, '食品');
  });

  it('リクエスト数は 1 + 第1階層の件数に収まる（1秒sleepがあるため増やせない）', async () => {
    const api = fakeApi();
    await buildGenreMaster(api.fetch);
    assert.deepEqual(api.calls, ['0', '100227', '215783']);
  });

  it('maxLevel=1 なら子を取りに行かない', async () => {
    const api = fakeApi();
    const entries = await buildGenreMaster(api.fetch, { maxLevel: 1 });
    assert.deepEqual(api.calls, ['0']);
    assert.equal(entries.length, 2);
  });

  it('一部のジャンルで失敗しても、取れた分は残す', async () => {
    const api = fakeApi();
    const warnings: string[] = [];
    const entries = await buildGenreMaster(
      async (id) => {
        if (id === '100227') throw new Error('429 Too Many Requests');
        return api.fetch(id);
      },
      { onWarn: (m) => warnings.push(m) },
    );

    // 食品の子2件だけが欠ける
    assert.equal(entries.length, 3);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]?.includes('食品'));
    assert.ok(entries.some((e) => e.genreId === '215784'));
  });

  it('同じジャンルが複数の親にぶら下がっても重複させない', async () => {
    const entries = await buildGenreMaster(async (id) => {
      if (id === '0') {
        return {
          current: null,
          children: [
            { genreId: 'a', genreName: 'A', level: 1 },
            { genreId: 'b', genreName: 'B', level: 1 },
          ],
        };
      }
      return { current: null, children: [{ genreId: 'dup', genreName: '共有', level: 2 }] };
    });

    assert.equal(entries.filter((e) => e.genreId === 'dup').length, 1);
  });
});
