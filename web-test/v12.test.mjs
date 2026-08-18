/**
 * 追加要件v1.2 のテスト。
 * 投稿ログ47件の実測で見つかった不具合（分類の空欄・タグの取りこぼし・
 * ヘッダー本文の汚れ）が再発しないことを固定する。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { headerLine, measureComment, splitComment } from '../docs/js/lib/commentText.js';
import { extractPostFeatures } from '../docs/js/lib/postFeatures.js';
import { suggestTags, tagLine } from '../docs/js/lib/tagSuggest.js';
import { byHeaderType, byPurchased, labeledPosts, latestLikeCount } from '../docs/js/lib/aggregate.js';
import { matchResults } from '../docs/js/lib/match.js';

const NL = String.fromCharCode(10);
const lines = (...rows) => rows.join(NL);

/** プロンプトの出力例に近い、タグを4行に分けた投稿文 */
const REAL_POST = lines(
  '夏休みのお昼ごはんって毎日悩む',
  '',
  'そんな日は冷凍庫から出すだけで済む',
  '✅骨取り済みで小分け冷凍されている',
  '✅8/11まで50%OFFで2,980円になる',
  '',
  '在庫と価格は楽天市場のページで👇',
  '',
  '─────────────',
  '#共働き家庭のまとめ買い',
  '#冷凍ストック #骨取り魚 #時短ごはん',
  '#夏休みのお昼ごはん #まとめ買い',
  '#買ってよかった #育ち盛り',
);

describe('1.4 ヘッダー本文は本文の最初の中身のある行だけ', () => {
  it('先頭の空行を飛ばす', () => {
    assert.equal(headerLine(lines('', '', '本当の1行目', '続き')), '本当の1行目');
  });

  it('先頭に置いたハッシュタグ行をヘッダーにしない', () => {
    // プロンプトは「ハッシュタグを1行目に置く形式」も認めている。
    // ここを拾うと、47件で起きた「ヘッダー本文にタグが混入」が再発する
    assert.equal(headerLine(lines('#冷凍ストック #まとめ買い', '夏休みのお昼ごはんって毎日悩む', '本文')), '夏休みのお昼ごはんって毎日悩む');
  });

  it('箇条書きしかない場合はその行を返す（勝手に飛ばさない）', () => {
    assert.equal(headerLine(lines('✅骨取り済み', '#タグ')), '✅骨取り済み');
  });

  it('extractPostFeatures のヘッダーも同じ行になる', () => {
    const f = extractPostFeatures(REAL_POST);
    assert.equal(f.headerText, '夏休みのお昼ごはんって毎日悩む');
    assert.equal(f.headerLength, 15);
  });
});

describe('4.3 ハッシュタグは本文から一元的に取る', () => {
  it('複数行に分かれたタグをすべて拾う', () => {
    // 1行しか見ない実装では2個しか取れず、残りは本文に混ざったままになっていた
    const { hashtags } = splitComment(REAL_POST);
    assert.equal(hashtags.length, 8);
    assert.ok(hashtags.includes('#共働き家庭のまとめ買い'));
    assert.ok(hashtags.includes('#育ち盛り'));
  });

  it('タグ行は本文から外れる', () => {
    const { body } = splitComment(REAL_POST);
    assert.ok(!body.includes('#'), `本文にタグが残っている: ${body}`);
    assert.ok(body.includes('─────────────'), '罫線は本文として残す');
  });

  it('タグ数も本文からの実測値になる', () => {
    assert.equal(extractPostFeatures(REAL_POST).hashtagCount, 8);
    assert.equal(measureComment(REAL_POST).hashtagCount, 8);
  });

  it('タグの後ろに空行があっても数えられる', () => {
    assert.equal(splitComment(lines('本文', '#a #b', '', '')).hashtags.length, 2);
  });

  it('タグが無い投稿は0個', () => {
    assert.equal(splitComment(lines('本文', 'もう1行')).hashtags.length, 0);
  });
});

describe('4.2 ニッチタグの自動生成', () => {
  it('商品名から複合語のニッチタグを作る', () => {
    const { niche } = suggestTags('骨取りサバ切身 1kg 送料無料');
    assert.deepEqual(niche, ['骨取りサバ', 'サバ切身']);
  });

  it('数量・配送・販促の断片をタグにしない', () => {
    const all = Object.values(suggestTags('【送料無料】訳あり ホタテ 1kg 500g 4個セット 令和5年産')).flat();
    for (const bad of ['1kg', '500g', '送料', '送料無料', '訳あり', '個セット', '令和', '年産']) {
      assert.ok(!all.includes(bad), `無意味な断片が出ている: #${bad}`);
    }
  });

  it('商品名に無いカテゴリタグを補う', () => {
    const { mid } = suggestTags('骨取りサバ切身 1kg');
    assert.ok(mid.includes('骨取り魚'), `補えていない: ${mid.join(',')}`);
  });

  it('ニッチ・中規模・ビッグの3層に分かれる', () => {
    const s = suggestTags('冷凍 鶏なんこつ唐揚げ 500g 業務用');
    assert.ok(s.niche.includes('鶏なんこつ唐揚げ'));
    assert.ok(s.mid.length > 0);
    assert.ok(s.big.includes('お取り寄せ'));
    // 同じタグが2つの層に出ると、どちらを選べばよいか分からなくなる
    assert.equal(s.niche.filter((t) => s.mid.includes(t)).length, 0);
  });

  it('過去によく使ったタグを中規模に残す（自分のコレクションタグ）', () => {
    const past = Array(4).fill('#共働き家庭のまとめ買い');
    const { mid } = suggestTags('冷凍 唐揚げ 500g', { pastHashtags: past });
    assert.ok(mid.includes('共働き家庭のまとめ買い'));
  });

  it('コピー用の1行にできる', () => {
    assert.equal(tagLine(['骨取りサバ', 'サバ切身']), '#骨取りサバ #サバ切身');
  });
});

function post(patch = {}) {
  return {
    postId: 'p1',
    postedAt: '2026-08-18T10:00:00+09:00',
    itemCode: 'shop:1',
    itemNameRaw: '商品',
    shopName: '店',
    genreName: '食品',
    headerType: '共感課題型',
    labelVersion: 'v2',
    criteria: [],
    hashtags: [],
    ...patch,
  };
}

describe('1.5 分類方式v1の投稿は分析に混ぜない', () => {
  it('labelVersion が v2 のものだけ残す', () => {
    const posts = [post({ postId: 'a' }), post({ postId: 'b', labelVersion: 'v1', headerType: '数字型' })];
    assert.deepEqual(labeledPosts(posts).map((p) => p.postId), ['a']);
  });

  it('v1を混ぜないので、廃止した型名が集計に出てこない', () => {
    const posts = [post({ postId: 'a' }), post({ postId: 'b', labelVersion: 'v1', headerType: 'セール速報型' })];
    const { byPostId } = matchResults(posts, []);
    const keys = byHeaderType(labeledPosts(posts), byPostId).map((r) => r.key);
    assert.deepEqual(keys, ['共感課題型']);
  });
});

describe('2.1 / 2.3 いいね数', () => {
  it('履歴の最新の値を取る（記録順ではなく計測日で決める）', () => {
    const p = post({
      likes: [
        { count: 40, measuredAt: '2026-08-18T10:00:00+09:00' },
        { count: 12, measuredAt: '2026-08-11T10:00:00+09:00' },
      ],
    });
    assert.equal(latestLikeCount(p), 40);
  });

  it('未記録なら null。0とは区別する', () => {
    assert.equal(latestLikeCount(post()), null);
    assert.equal(latestLikeCount(post({ likes: [{ count: 0, measuredAt: '2026-08-18' }] })), 0);
  });

  it('平均いいねは記録済みの投稿だけで割る（未記録を0にしない）', () => {
    const posts = [
      post({ postId: 'a', likes: [{ count: 30, measuredAt: '2026-08-18' }] }),
      post({ postId: 'b', likes: [{ count: 10, measuredAt: '2026-08-18' }] }),
      post({ postId: 'c' }),
    ];
    const { byPostId } = matchResults(posts, []);
    const row = byHeaderType(posts, byPostId)[0];
    assert.equal(row.posts, 3);
    assert.equal(row.likedPosts, 2);
    assert.equal(row.averageLikes, 20);
  });
});

describe('3章 購入済みの層', () => {
  it('購入済みと未購入で分けられる', () => {
    const posts = [
      post({ postId: 'a', purchased: true }),
      post({ postId: 'b', purchased: false, itemNameRaw: 'x' }),
    ];
    const { byPostId } = matchResults(posts, []);
    assert.deepEqual(byPurchased(posts, byPostId).map((r) => r.key).sort(), ['未購入', '購入済み']);
  });
});
