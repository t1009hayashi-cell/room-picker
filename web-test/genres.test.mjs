import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_COMMISSION_RATE, searchGenres } from '../docs/js/lib/genres.js';

const ENTRIES = [
  { genreId: '100227', genreName: '食品', level: 1, parentId: null, parentName: null, path: '食品' },
  { genreId: '100356', genreName: 'コーヒー', level: 2, parentId: '100227', parentName: '食品', path: '食品 > コーヒー' },
  {
    genreId: '564500',
    genreName: 'コーヒー豆',
    level: 2,
    parentId: '100227',
    parentName: '食品',
    path: '食品 > コーヒー豆',
  },
  {
    genreId: '215783',
    genreName: '日用品雑貨',
    level: 1,
    parentId: null,
    parentName: null,
    path: '日用品雑貨',
  },
];

describe('ジャンルの名前検索（設定画面）', () => {
  it('名前の一部で引ける', () => {
    assert.equal(searchGenres(ENTRIES, 'コーヒー').length, 2);
  });

  it('完全一致を前方一致より先に出す', () => {
    const hits = searchGenres(ENTRIES, 'コーヒー');
    assert.equal(hits[0].genreId, '100356');
    assert.equal(hits[1].genreId, '564500');
  });

  it('親の名前でも子ごと引ける', () => {
    const hits = searchGenres(ENTRIES, '食品');
    assert.equal(hits.length, 3);
    assert.equal(hits[0].genreId, '100227');
  });

  it('genreId でも引ける（番号がわかっている場合の逃げ道）', () => {
    const hits = searchGenres(ENTRIES, '564500');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].genreName, 'コーヒー豆');
  });

  it('空文字・空白では何も返さない（数百件の描画を避けるため）', () => {
    assert.deepEqual(searchGenres(ENTRIES, ''), []);
    assert.deepEqual(searchGenres(ENTRIES, '   '), []);
  });

  it('該当なしは空配列', () => {
    assert.deepEqual(searchGenres(ENTRIES, 'そんなジャンルはない'), []);
  });

  it('マスタが空・未定義でも落ちない（ワークフロー未実行の状態）', () => {
    assert.deepEqual(searchGenres([], 'コーヒー'), []);
    assert.deepEqual(searchGenres(undefined, 'コーヒー'), []);
  });

  it('件数の上限が効く', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      genreId: String(i),
      genreName: `テスト${i}`,
      level: 2,
      parentId: null,
      parentName: null,
      path: `テスト${i}`,
    }));
    assert.equal(searchGenres(many, 'テスト').length, 20);
    assert.equal(searchGenres(many, 'テスト', 5).length, 5);
  });

  it('既定の料率はフォールバック用の値である（API値が優先。仕様書4.4）', () => {
    assert.equal(DEFAULT_COMMISSION_RATE, 0.04);
  });
});
