import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RakutenClient } from '../src/rakuten/client.js';

/** 指定した応答を順に返す偽の fetch */
function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    calls.push(String(url));
    const next = responses.shift();
    if (next === undefined) throw new Error('想定より多く呼ばれました');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: next.headers,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(fetchImpl: typeof fetch, maxAttempts = 3) {
  return new RakutenClient({
    applicationId: 'dummy-app-id',
    accessKey: 'dummy-access-key',
    // テストを待たせないため最小値にする（実行時は 1100ms 以上・仕様書4.3）
    intervalMs: 1000,
    maxAttempts,
    fetchImpl,
  });
}

describe('楽天APIの一時的な失敗の扱い', () => {
  it('429 のあと成功すれば結果を返す', async () => {
    const { impl, calls } = fakeFetch([
      { status: 429, body: { errors: { errorMessage: 'too many requests' } }, headers: { 'Retry-After': '0' } },
      { status: 200, body: { title: 'ランキング', Items: [{ itemCode: 'a:1' }] } },
    ]);

    const result = await client(impl).fetchRanking('100227');
    assert.equal(result.title, 'ランキング');
    assert.equal(result.items.length, 1);
    assert.equal(calls.length, 2);
  });

  it('500 も再試行する', async () => {
    const { impl, calls } = fakeFetch([
      { status: 500 },
      { status: 200, body: { title: 'x', Items: [] } },
    ]);
    await client(impl).fetchRanking('100227');
    assert.equal(calls.length, 2);
  });

  it('通信自体が失敗しても再試行する', async () => {
    const { impl, calls } = fakeFetch([
      new Error('fetch failed'),
      { status: 200, body: { title: 'x', Items: [] } },
    ]);
    await client(impl).fetchRanking('100227');
    assert.equal(calls.length, 2);
  });

  it('上限まで失敗したら最後のエラーを投げる', async () => {
    const { impl, calls } = fakeFetch([{ status: 429 }, { status: 429 }]);
    await assert.rejects(() => client(impl, 2).fetchRanking('100227'), /429/);
    assert.equal(calls.length, 2);
  });

  it('429 のエラー文に、間隔を空ける案内を入れる', async () => {
    const { impl } = fakeFetch([{ status: 429 }]);
    await assert.rejects(() => client(impl, 1).fetchRanking('100227'), /しばらく待って/);
  });

  it('認証エラー(400)は再試行しない（待っても変わらないため）', async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: { errors: { errorMessage: 'applicationId must be present' } } },
    ]);
    await assert.rejects(() => client(impl).fetchRanking('100227'), /applicationId/);
    assert.equal(calls.length, 1);
  });

  it('404 は再試行しない（エンドポイントが違うため）', async () => {
    const { impl, calls } = fakeFetch([{ status: 404, body: { message: 'Resource not found' } }]);
    await assert.rejects(() => client(impl).fetchRanking('100227'), /404/);
    assert.equal(calls.length, 1);
  });

  it('エラー文にアプリIDとアクセスキーを出さない', async () => {
    const { impl } = fakeFetch([
      { status: 400, body: { message: 'bad request for dummy-app-id with dummy-access-key' } },
    ]);
    await assert.rejects(
      () => client(impl, 1).fetchRanking('100227'),
      (err: Error) => {
        assert.ok(!err.message.includes('dummy-app-id'), 'アプリIDが漏れている');
        assert.ok(!err.message.includes('dummy-access-key'), 'アクセスキーが漏れている');
        assert.ok(err.message.includes('***'));
        return true;
      },
    );
  });

  it('ジャンル検索も再試行の対象になる', async () => {
    const { impl, calls } = fakeFetch([
      { status: 429 },
      { status: 200, body: { genre: { genreId: '100227', nameJa: '食品', level: 1 }, children: [] } },
    ]);
    const result = await client(impl).fetchGenre('100227');
    assert.equal(result.current?.genreName, '食品');
    assert.equal(calls.length, 2);
  });
});
