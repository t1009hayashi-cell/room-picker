import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

// store.js は localStorage を使う。Node には無いので最小限の代役を用意する
class MemoryStorage {
  #map = new Map();
  getItem(k) {
    return this.#map.has(k) ? this.#map.get(k) : null;
  }
  setItem(k, v) {
    this.#map.set(k, String(v));
  }
  removeItem(k) {
    this.#map.delete(k);
  }
  clear() {
    this.#map.clear();
  }
}
globalThis.localStorage = new MemoryStorage();

let store;
let summarizeDay;

before(async () => {
  store = await import('../docs/js/lib/store.js');
  ({ summarizeDay } = await import('../docs/js/lib/catalog.js'));
  store.load();
});

function reset() {
  store.update((s) => {
    s.reserved = {};
    s.posted = {};
    s.comments = {};
    s.posts = [];
  });
}

describe('予約投稿（投稿文を先に書いて当日コピペする）', () => {
  it('予約すると投稿文も一緒に保存される', () => {
    reset();
    store.setReserved('shop:1', true, { scheduledDate: '2026-08-10', text: '本文です\n#タグ', angle: 'ストック切れ回避' });

    assert.equal(store.isReserved('shop:1'), true);
    assert.equal(store.getComment('shop:1'), '本文です\n#タグ');
    assert.equal(store.getState().postedAngle['shop:1'], 'ストック切れ回避');
    assert.equal(store.getState().reserved['shop:1'].scheduledDate, '2026-08-10');
  });

  it('予約した日時が残る（いつ準備したか分かるようにする）', () => {
    reset();
    store.setReserved('shop:1', true, { scheduledDate: '2026-08-10', text: '本文' });
    assert.ok(Date.parse(store.getState().reserved['shop:1'].reservedAt) > 0);
  });

  it('予約を取り消しても投稿文は消さない（書き直す手間を戻さない）', () => {
    reset();
    store.setReserved('shop:1', true, { scheduledDate: '2026-08-10', text: '書いた本文' });
    store.setReserved('shop:1', false);

    assert.equal(store.isReserved('shop:1'), false);
    assert.equal(store.getComment('shop:1'), '書いた本文');
  });

  it('投稿済みにすると予約は自動で外れる（「予約のみ」に投稿済みが残らない）', () => {
    reset();
    store.setReserved('shop:1', true, { scheduledDate: '2026-08-10', text: '本文' });
    store.addPost({ postId: 'p1', itemCode: 'shop:1', postedAt: '2026-08-10T20:00:00+09:00', itemNameRaw: 'x' });

    assert.equal(store.isReserved('shop:1'), false);
    assert.equal(store.isPosted('shop:1'), true);
    // 投稿ログと投稿文は残る
    assert.equal(store.getState().posts.length, 1);
    assert.equal(store.getComment('shop:1'), '本文');
  });

  it('予約していない商品の投稿でも落ちない', () => {
    reset();
    store.addPost({ postId: 'p1', itemCode: 'shop:9', postedAt: '2026-08-10T20:00:00+09:00', itemNameRaw: 'x' });
    assert.equal(store.isPosted('shop:9'), true);
  });

  it('予約を持たない古い保存データを読み込んでも壊れない', () => {
    const old = JSON.stringify({ version: 1, posted: { 'shop:1': true }, comments: {}, posts: [] });
    store.importJson(old);
    assert.deepEqual(store.getState().reserved, {});
    assert.equal(store.isReserved('shop:1'), false);

    // 読み込み直後でも予約できる
    store.setReserved('shop:1', true, { scheduledDate: '2026-08-10', text: '本文' });
    assert.equal(store.isReserved('shop:1'), true);
  });

  it('エクスポートに予約が含まれる（端末を替えても引き継げる）', () => {
    reset();
    store.setReserved('shop:1', true, { scheduledDate: '2026-08-10', text: '本文' });
    const dumped = JSON.parse(store.exportJson());
    assert.equal(dumped.data.reserved['shop:1'].scheduledDate, '2026-08-10');
  });
});

describe('カレンダーの日次集計', () => {
  const items = [
    { itemCode: 'a', isRateBoosted: false, estimatedReward: 100 },
    { itemCode: 'b', isRateBoosted: true, estimatedReward: 200 },
    { itemCode: 'c', isRateBoosted: false, estimatedReward: 300 },
  ];

  it('予約件数を数える', () => {
    const sum = summarizeDay(items, {}, { a: { reservedAt: 'x' }, c: { reservedAt: 'y' } });
    assert.equal(sum.reserved, 2);
    assert.equal(sum.todo, 3);
    assert.equal(sum.posted, 0);
  });

  it('予約を渡さなくても従来どおり動く（既存の呼び出しを壊さない）', () => {
    const sum = summarizeDay(items, { b: true });
    assert.equal(sum.reserved, 0);
    assert.equal(sum.posted, 1);
    assert.equal(sum.todo, 2);
    assert.equal(sum.rateBoosted, 1);
    assert.equal(sum.reward, 600);
  });

  it('投稿済みと予約は重ならない（投稿時に予約が外れるため）', () => {
    const sum = summarizeDay(items, { a: true }, { b: { reservedAt: 'x' } });
    assert.equal(sum.posted, 1);
    assert.equal(sum.reserved, 1);
    assert.equal(sum.todo, 2);
  });
});
