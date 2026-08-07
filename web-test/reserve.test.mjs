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

const DAY = '2026-08-10';
const OTHER = '2026-08-11';

describe('予約投稿（投稿文を先に書いて当日コピペする）', () => {
  it('予約すると投稿文も一緒に保存される', () => {
    reset();
    store.setReserved(DAY, 'shop:1', true, { text: '本文です\n#タグ', angle: 'ストック切れ回避' });

    assert.equal(store.isReserved(DAY, 'shop:1'), true);
    assert.equal(store.getComment('shop:1'), '本文です\n#タグ');
    assert.equal(store.getState().postedAngle['shop:1'], 'ストック切れ回避');
    assert.equal(store.getState().reserved[store.dayItemKey(DAY, 'shop:1')].scheduledDate, DAY);
  });

  it('予約した日時が残る（いつ準備したか分かるようにする）', () => {
    reset();
    store.setReserved(DAY, 'shop:1', true, { text: '本文' });
    assert.ok(Date.parse(store.getState().reserved[store.dayItemKey(DAY, 'shop:1')].reservedAt) > 0);
  });

  it('予約を取り消しても投稿文は消さない（書き直す手間を戻さない）', () => {
    reset();
    store.setReserved(DAY, 'shop:1', true, { text: '書いた本文' });
    store.setReserved(DAY, 'shop:1', false);

    assert.equal(store.isReserved(DAY, 'shop:1'), false);
    assert.equal(store.getComment('shop:1'), '書いた本文');
  });

  it('投稿済みにすると予約は自動で外れる（「予約のみ」に投稿済みが残らない）', () => {
    reset();
    store.setReserved(DAY, 'shop:1', true, { text: '本文' });
    store.addPost({ postId: 'p1', dateKey: DAY, itemCode: 'shop:1', postedAt: '2026-08-10T20:00:00+09:00', itemNameRaw: 'x' });

    assert.equal(store.isReserved(DAY, 'shop:1'), false);
    assert.equal(store.isPosted(DAY, 'shop:1'), true);
    // 投稿ログと投稿文は残る
    assert.equal(store.getState().posts.length, 1);
    assert.equal(store.getComment('shop:1'), '本文');
  });

  it('予約していない商品の投稿でも落ちない', () => {
    reset();
    store.addPost({ postId: 'p1', dateKey: DAY, itemCode: 'shop:9', postedAt: '2026-08-10T20:00:00+09:00', itemNameRaw: 'x' });
    assert.equal(store.isPosted(DAY, 'shop:9'), true);
  });

  it('エクスポートに予約が含まれる（端末を替えても引き継げる）', () => {
    reset();
    store.setReserved(DAY, 'shop:1', true, { text: '本文' });
    const dumped = JSON.parse(store.exportJson());
    assert.equal(dumped.data.reserved[store.dayItemKey(DAY, 'shop:1')].scheduledDate, DAY);
  });
});

describe('押した日にだけ反映する（同じ商品が複数日に出る問題）', () => {
  it('ある日で予約しても、他の日には付かない', () => {
    reset();
    store.setReserved(DAY, 'shop:1', true, { text: '本文' });

    assert.equal(store.isReserved(DAY, 'shop:1'), true);
    assert.equal(store.isReserved(OTHER, 'shop:1'), false);
  });

  it('ある日で投稿済みにしても、他の日には付かない', () => {
    reset();
    store.addPost({ postId: 'p1', dateKey: DAY, itemCode: 'shop:1', postedAt: '2026-08-10T20:00:00+09:00', itemNameRaw: 'x' });

    assert.equal(store.isPosted(DAY, 'shop:1'), true);
    assert.equal(store.isPosted(OTHER, 'shop:1'), false);
  });

  it('同じ商品を別々の日で個別に扱える', () => {
    reset();
    store.setReserved(DAY, 'shop:1', true, { text: '本文' });
    store.setReserved(OTHER, 'shop:1', true, { text: '本文' });
    store.setReserved(DAY, 'shop:1', false);

    assert.equal(store.isReserved(DAY, 'shop:1'), false);
    assert.equal(store.isReserved(OTHER, 'shop:1'), true);
  });

  it('投稿済みの取り消しは、その日の投稿ログだけを撤回する', () => {
    reset();
    store.addPost({ postId: 'p1', dateKey: DAY, itemCode: 'shop:1', postedAt: '2026-08-10T20:00:00+09:00', itemNameRaw: 'x' });
    store.addPost({ postId: 'p2', dateKey: OTHER, itemCode: 'shop:1', postedAt: '2026-08-11T20:00:00+09:00', itemNameRaw: 'x' });
    store.undoPost(DAY, 'shop:1');

    assert.equal(store.isPosted(DAY, 'shop:1'), false);
    assert.equal(store.isPosted(OTHER, 'shop:1'), true);
    assert.deepEqual(
      store.getState().posts.map((p) => p.postId),
      ['p2'],
    );
  });
});

describe('投稿予定日を変えたときの追従', () => {
  it('予約は新しい日に移る（カードが移動しても印が迷子にならない）', () => {
    reset();
    store.setReserved(DAY, 'shop:1', true, { text: '本文' });
    store.setScheduledDate('shop:1', OTHER, DAY);

    assert.equal(store.isReserved(DAY, 'shop:1'), false);
    assert.equal(store.isReserved(OTHER, 'shop:1'), true);
    assert.equal(store.getState().reserved[store.dayItemKey(OTHER, 'shop:1')].scheduledDate, OTHER);
  });

  it('投稿済みも新しい日に移る', () => {
    reset();
    store.addPost({ postId: 'p1', dateKey: DAY, itemCode: 'shop:1', postedAt: '2026-08-10T20:00:00+09:00', itemNameRaw: 'x' });
    store.setScheduledDate('shop:1', OTHER, DAY);

    assert.equal(store.isPosted(DAY, 'shop:1'), false);
    assert.equal(store.isPosted(OTHER, 'shop:1'), true);
  });

  it('移動元を渡さなければ何も動かさない（発見日モードの印を巻き込まない）', () => {
    reset();
    store.setReserved(DAY, 'shop:1', true, { text: '本文' });
    store.setScheduledDate('shop:1', OTHER);

    assert.equal(store.isReserved(DAY, 'shop:1'), true);
    assert.equal(store.isReserved(OTHER, 'shop:1'), false);
  });
});

describe('古い保存データの移行', () => {
  it('商品コードだけの投稿済みを、投稿ログの日付に振り直す', () => {
    store.importJson(
      JSON.stringify({
        version: 1,
        posted: { 'shop:1': true },
        posts: [{ postId: 'p1', itemCode: 'shop:1', postedAt: '2026-08-10T20:00:00+09:00', itemNameRaw: 'x' }],
      }),
    );

    assert.equal(store.isPosted('2026-08-10', 'shop:1'), true);
    assert.equal(store.isPosted('2026-08-11', 'shop:1'), false);
  });

  it('投稿ログに dateKey があればそれを優先する', () => {
    store.importJson(
      JSON.stringify({
        version: 1,
        posted: { 'shop:1': true },
        // 押した日（08-04のリスト）と実際に押した時刻（08-10）が違う場合
        posts: [{ postId: 'p1', dateKey: '2026-08-04', itemCode: 'shop:1', postedAt: '2026-08-10T20:00:00+09:00' }],
      }),
    );

    assert.equal(store.isPosted('2026-08-04', 'shop:1'), true);
    assert.equal(store.isPosted('2026-08-10', 'shop:1'), false);
  });

  it('JSTで日付を判定する（UTCだと前日にずれる時間帯がある）', () => {
    store.importJson(
      JSON.stringify({
        version: 1,
        posted: { 'shop:1': true },
        // UTCでは 2026-08-10T16:00Z = JSTでは 2026-08-11 01:00
        posts: [{ postId: 'p1', itemCode: 'shop:1', postedAt: '2026-08-11T01:00:00+09:00' }],
      }),
    );

    assert.equal(store.isPosted('2026-08-11', 'shop:1'), true);
  });

  it('商品コードだけの予約を、中に持っている投稿予定日に振り直す', () => {
    store.importJson(
      JSON.stringify({
        version: 1,
        reserved: { 'shop:1': { reservedAt: '2026-08-03T10:00:00Z', scheduledDate: '2026-08-10' } },
        posts: [],
      }),
    );

    assert.equal(store.isReserved('2026-08-10', 'shop:1'), true);
    assert.equal(store.isReserved('2026-08-11', 'shop:1'), false);
  });

  it('すでに新形式のキーはそのまま残す（二重変換しない）', () => {
    store.importJson(
      JSON.stringify({
        version: 1,
        posted: { '2026-08-10|shop:1': true },
        reserved: { '2026-08-10|shop:2': { reservedAt: 'x', scheduledDate: '2026-08-10' } },
        posts: [],
      }),
    );

    assert.equal(store.isPosted('2026-08-10', 'shop:1'), true);
    assert.equal(store.isReserved('2026-08-10', 'shop:2'), true);
    assert.equal(Object.keys(store.getState().posted).length, 1);
  });

  it('予約を持たない古い保存データを読み込んでも壊れない', () => {
    store.importJson(JSON.stringify({ version: 1, posted: {}, comments: {}, posts: [] }));
    assert.deepEqual(store.getState().reserved, {});

    store.setReserved(DAY, 'shop:1', true, { text: '本文' });
    assert.equal(store.isReserved(DAY, 'shop:1'), true);
  });
});

describe('別の日に投稿済みかを引ける（二重投稿の防止）', () => {
  it('商品コードから投稿した日を引ける', () => {
    reset();
    store.addPost({ postId: 'p1', dateKey: DAY, itemCode: 'shop:1', postedAt: '2026-08-10T20:00:00+09:00' });
    const index = store.buildPostedItemIndex(store.getState().posts);
    assert.deepEqual(index.get('shop:1'), [DAY]);
  });

  it('この日以外に投稿した日だけを返す', () => {
    reset();
    store.addPost({ postId: 'p1', dateKey: DAY, itemCode: 'shop:1', postedAt: '2026-08-10T20:00:00+09:00' });
    const index = store.buildPostedItemIndex(store.getState().posts);

    // 投稿した当日は「別の日」に含めない（その日のバッジで分かるため）
    assert.deepEqual(store.postedOnOtherDays(index, 'shop:1', DAY), []);
    // 別の日で見ると投稿済みだと分かる
    assert.deepEqual(store.postedOnOtherDays(index, 'shop:1', OTHER), [DAY]);
  });

  it('複数の日に投稿していれば日付順に並ぶ', () => {
    reset();
    store.addPost({ postId: 'p2', dateKey: OTHER, itemCode: 'shop:1', postedAt: '2026-08-11T20:00:00+09:00' });
    store.addPost({ postId: 'p1', dateKey: DAY, itemCode: 'shop:1', postedAt: '2026-08-10T20:00:00+09:00' });
    const index = store.buildPostedItemIndex(store.getState().posts);
    assert.deepEqual(index.get('shop:1'), [DAY, OTHER]);
  });

  it('dateKey を持たない古いログは投稿時刻の日付で代用する', () => {
    store.importJson(
      JSON.stringify({
        version: 1,
        posts: [{ postId: 'p1', itemCode: 'shop:1', postedAt: '2026-08-10T20:00:00+09:00' }],
      }),
    );
    const index = store.buildPostedItemIndex(store.getState().posts);
    assert.deepEqual(index.get('shop:1'), ['2026-08-10']);
  });

  it('投稿していない商品は索引に載らない', () => {
    reset();
    const index = store.buildPostedItemIndex(store.getState().posts);
    assert.equal(index.has('shop:9'), false);
    assert.deepEqual(store.postedOnOtherDays(index, 'shop:9', DAY), []);
  });

  it('投稿を取り消すと索引からも消える', () => {
    reset();
    store.addPost({ postId: 'p1', dateKey: DAY, itemCode: 'shop:1', postedAt: '2026-08-10T20:00:00+09:00' });
    store.undoPost(DAY, 'shop:1');
    const index = store.buildPostedItemIndex(store.getState().posts);
    assert.equal(index.has('shop:1'), false);
  });
});

describe('カレンダーの日次集計', () => {
  const items = [
    { itemCode: 'a', isRateBoosted: false, estimatedReward: 100 },
    { itemCode: 'b', isRateBoosted: true, estimatedReward: 200 },
    { itemCode: 'c', isRateBoosted: false, estimatedReward: 300 },
  ];
  const k = (code) => store.dayItemKey(DAY, code);

  it('予約件数を数える', () => {
    const sum = summarizeDay(items, DAY, { reserved: { [k('a')]: { reservedAt: 'x' }, [k('c')]: { reservedAt: 'y' } } });
    assert.equal(sum.reserved, 2);
    assert.equal(sum.todo, 3);
    assert.equal(sum.posted, 0);
  });

  it('状態を渡さなくても落ちない', () => {
    const sum = summarizeDay(items, DAY);
    assert.equal(sum.reserved, 0);
    assert.equal(sum.posted, 0);
    assert.equal(sum.todo, 3);
    assert.equal(sum.rateBoosted, 1);
    assert.equal(sum.reward, 600);
  });

  it('投稿済みと予約は重ならない（投稿時に予約が外れるため）', () => {
    const sum = summarizeDay(items, DAY, { posted: { [k('a')]: true }, reserved: { [k('b')]: { reservedAt: 'x' } } });
    assert.equal(sum.posted, 1);
    assert.equal(sum.reserved, 1);
    assert.equal(sum.todo, 2);
  });

  it('他の日の印を数えない（同じ商品が複数日に出ても混ざらない）', () => {
    const sum = summarizeDay(items, DAY, {
      posted: { [store.dayItemKey(OTHER, 'a')]: true },
      reserved: { [store.dayItemKey(OTHER, 'b')]: { reservedAt: 'x' } },
    });
    assert.equal(sum.posted, 0);
    assert.equal(sum.reserved, 0);
    assert.equal(sum.todo, 3);
  });

  it('別の日に投稿済みの商品は「やること」に数えない', () => {
    // 同じ商品が複数の日に出るため、数えると件数が水増しされる
    const index = new Map([['a', [OTHER]]]);
    const sum = summarizeDay(items, DAY, {}, index);
    assert.equal(sum.todo, 2);
    assert.equal(sum.posted, 0);
  });

  it('索引を渡さなければ従来どおり数える', () => {
    assert.equal(summarizeDay(items, DAY, {}).todo, 3);
  });
});
