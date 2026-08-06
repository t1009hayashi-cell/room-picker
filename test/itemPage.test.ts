import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReviewUrlResolver, buildReviewUrl, extractReviewIds } from '../src/rakuten/itemPage.js';

describe('レビューURLの組み立て（追加要件 6章）', () => {
  it('商品ページのHTMLから shop_bid と iid を取り出す', () => {
    const html = '<a href="/rd/?shop_bid=249917&iid=10001714&scid=x">レビューを見る</a>';
    assert.deepEqual(extractReviewIds(html), { shopBid: '249917', itemNumericId: '10001714' });
  });

  it('文字化けした本文の中でも読める（ASCII部分だけ見ている）', () => {
    const html = '�����<a href="?shop_bid=1234&iid=5678">��</a>�';
    assert.deepEqual(extractReviewIds(html), { shopBid: '1234', itemNumericId: '5678' });
  });

  it('どちらか欠けたら null（推測して埋めない）', () => {
    assert.equal(extractReviewIds('shop_bid=249917 のみ'), null);
    assert.equal(extractReviewIds('?iid=10001714 のみ'), null);
    assert.equal(extractReviewIds(''), null);
  });

  it('レビューURLの形が仕様どおり', () => {
    assert.equal(
      buildReviewUrl({ shopBid: '249917', itemNumericId: '10001714' }),
      'https://review.rakuten.co.jp/item/1/249917_10001714/1.1/',
    );
  });
});

/** 呼び出し回数を数える偽の fetch */
function fakeFetch(handler: (url: string) => { status: number; body: string } | Error) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    calls.push(String(url));
    const res = handler(String(url));
    if (res instanceof Error) throw res;
    return new Response(res.body, { status: res.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('レビューURLの取得', () => {
  it('取得できれば3項目が埋まる', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: 'x shop_bid=111&iid=222 y' }));
    const resolver = new ReviewUrlResolver({ intervalMs: 1000, fetchImpl: impl });
    const r = await resolver.resolve('https://item.rakuten.co.jp/shop/abc/');

    assert.equal(r.shopBid, '111');
    assert.equal(r.itemNumericId, '222');
    assert.equal(r.reviewUrl, 'https://review.rakuten.co.jp/item/1/111_222/1.1/');
  });

  it('取得に失敗しても例外を投げず null を返す（エラーで止めない）', async () => {
    const { impl } = fakeFetch(() => ({ status: 404, body: '' }));
    const resolver = new ReviewUrlResolver({ intervalMs: 1000, fetchImpl: impl });
    const r = await resolver.resolve('https://item.rakuten.co.jp/shop/abc/');
    assert.deepEqual(r, { shopBid: null, itemNumericId: null, reviewUrl: null });
    assert.equal(resolver.stats.failed, 1);
  });

  it('通信で例外が出ても止めない', async () => {
    const { impl } = fakeFetch(() => new Error('ECONNRESET'));
    const resolver = new ReviewUrlResolver({ intervalMs: 1000, fetchImpl: impl });
    const r = await resolver.resolve('https://item.rakuten.co.jp/shop/abc/');
    assert.equal(r.reviewUrl, null);
    assert.equal(resolver.stats.failed, 1);
  });

  it('shop_bid が見つからなければ null', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: '<html>なにも無い</html>' }));
    const resolver = new ReviewUrlResolver({ intervalMs: 1000, fetchImpl: impl });
    assert.equal((await resolver.resolve('https://item.rakuten.co.jp/shop/abc/')).reviewUrl, null);
  });

  it('URLが空・不正なら通信しない', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: 'shop_bid=1&iid=2' }));
    const resolver = new ReviewUrlResolver({ intervalMs: 1000, fetchImpl: impl });
    assert.equal((await resolver.resolve('')).reviewUrl, null);
    assert.equal((await resolver.resolve('ftp://example.com')).reviewUrl, null);
    assert.equal(calls.length, 0);
  });

  it('リクエストの間隔を1秒以上空ける（仕様書4.3）', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: 'shop_bid=1&iid=2' }));
    const resolver = new ReviewUrlResolver({ intervalMs: 1000, fetchImpl: impl });
    const started = Date.now();
    await resolver.resolve('https://item.rakuten.co.jp/a/1/');
    await resolver.resolve('https://item.rakuten.co.jp/a/2/');
    assert.ok(Date.now() - started >= 1000, `間隔が短すぎる: ${Date.now() - started}ms`);
  });

  it('上限を超えたら通信しない（日次実行が長くなりすぎるのを防ぐ）', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: 'shop_bid=1&iid=2' }));
    const resolver = new ReviewUrlResolver({ intervalMs: 1000, fetchImpl: impl, maxItems: 1 });
    await resolver.resolve('https://item.rakuten.co.jp/a/1/');
    await resolver.resolve('https://item.rakuten.co.jp/a/2/');
    assert.equal(calls.length, 1);
  });
});
