import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDraftComments,
  deadlineLabel,
  extractNoun,
  extractUnitPrice,
  headerNumber,
  seasonOf,
  validateComment,
} from '../src/comment.js';
import { config } from './helpers.js';

/** 単価が出せる（数量表記がある）サンプル。ヘッダーと本文の目標に収まる前提のもの */
const SAMPLES = [
  { itemName: 'ラベルレス ミネラルウォーター 500ml×24本 まとめ買い', genreName: '水・ソフトドリンク', itemPrice: 3480, postageFlag: 0 },
  { itemName: 'トイレットペーパー 12ロール×8パック 業務用', genreName: '日用品雑貨', itemPrice: 4280, postageFlag: 1 },
  { itemName: 'おむつ テープ Mサイズ 2パック まとめ買い', genreName: 'キッズ・ベビー・マタニティ', itemPrice: 6980, postageFlag: 0 },
  { itemName: '訳あり 冷凍食品 詰め合わせ 20食', genreName: '食品', itemPrice: 5980, postageFlag: 0 },
  { itemName: 'ドリップバッグ コーヒー 100袋 詰め合わせ', genreName: 'コーヒー', itemPrice: 3980, postageFlag: 0 },
];

const base = { reviewCount: 4300, reviewAverage: 4.53, pointRate: 10, priceEndTime: null as string | null };

describe('投稿文の生成（投稿プロンプトの型）', () => {
  it('すべての月・すべてのサンプルで生成ルールを満たす', async () => {
    const { scoring, ngWords } = await config();
    for (const sample of SAMPLES) {
      for (let month = 1; month <= 12; month += 1) {
        const drafts = buildDraftComments({ ...sample, ...base, month }, scoring, ngWords);
        assert.ok(drafts.length >= 1, `${sample.itemName} / ${month}月: 案が0件`);
        assert.equal(new Set(drafts.map((d) => d.angle)).size, drafts.length, '同じ角度が重複した');

        for (const draft of drafts) {
          const violations = validateComment(draft, scoring, ngWords, sample.itemName);
          assert.deepEqual(
            violations,
            [],
            `${sample.itemName} / ${month}月 / ${draft.angle}\n${draft.text}\n違反: ${JSON.stringify(violations)}`,
          );
        }
      }
    }
  });

  it('ヘッダーは約20文字で、数字を必ず1つ含む', async () => {
    const { scoring, ngWords } = await config();
    for (const sample of SAMPLES) {
      for (const draft of buildDraftComments({ ...sample, ...base, month: 8 }, scoring, ngWords)) {
        assert.ok(
          draft.firstLineLength >= scoring.comment.firstLineMin && draft.firstLineLength <= scoring.comment.firstLineMax,
          `${draft.firstLine} は ${draft.firstLineLength}文字`,
        );
        assert.match(draft.firstLine, /\d/, `数字が無い: ${draft.firstLine}`);
      }
    }
  });

  it('文末を「。」で終わらせない', async () => {
    const { scoring, ngWords } = await config();
    for (const sample of SAMPLES) {
      for (const draft of buildDraftComments({ ...sample, ...base, month: 8 }, scoring, ngWords)) {
        for (const line of draft.text.split('\n')) {
          assert.doesNotMatch(line, /[。．]$/u, `「。」で終わっている: ${line}`);
        }
      }
    }
  });

  it('✅の箇条書きを本文に入れる', async () => {
    const { scoring, ngWords } = await config();
    for (const sample of SAMPLES) {
      for (const draft of buildDraftComments({ ...sample, ...base, month: 8 }, scoring, ngWords)) {
        assert.ok(draft.text.includes('✅'), `✅が無い: ${draft.text}`);
      }
    }
  });

  it('ハッシュタグに感情・行動タグを必ず1つ入れる', async () => {
    const { scoring, ngWords } = await config();
    const feeling = ['#買ってよかった', '#リピート決定', '#ストックしてる'];
    for (const sample of SAMPLES) {
      for (const draft of buildDraftComments({ ...sample, ...base, month: 8 }, scoring, ngWords)) {
        assert.ok(draft.hashtags.some((t) => feeling.includes(t)), draft.hashtags.join(' '));
      }
    }
  });

  it('商品名に含まれる「最安値」等を投稿文に転記しない', async () => {
    const { scoring, ngWords } = await config();
    const drafts = buildDraftComments(
      {
        itemName: '【楽天1位】最安値挑戦 半額 ドリップバッグ 100袋',
        genreName: 'コーヒー',
        itemPrice: 3980,
        reviewCount: 100,
        reviewAverage: 4.5,
        postageFlag: 0,
        pointRate: 1,
        month: 8,
        priceEndTime: null,
      },
      scoring,
      ngWords,
    );
    for (const draft of drafts) {
      for (const banned of ngWords.commentBanned) {
        assert.equal(draft.text.includes(banned), false, `禁止語「${banned}」が混入: ${draft.text}`);
      }
    }
  });

  it('ヘッダーが商品名の書き出しから始まらない', async () => {
    const { scoring, ngWords } = await config();
    const drafts = buildDraftComments(
      {
        itemName: 'ドリップバッグ 100袋 送料無料',
        genreName: 'コーヒー',
        itemPrice: 3980,
        reviewCount: 100,
        reviewAverage: 4.5,
        postageFlag: 0,
        pointRate: 1,
        month: 8,
        priceEndTime: null,
      },
      scoring,
      ngWords,
    );
    for (const draft of drafts) {
      assert.equal(draft.firstLine.startsWith('ドリップバッグ'), false, draft.firstLine);
    }
  });

  it('レビューが0件でも生成できる', async () => {
    const { scoring, ngWords } = await config();
    const itemName = '麦茶 2L×12本 ケース';
    const drafts = buildDraftComments(
      {
        itemName,
        genreName: '水・ソフトドリンク',
        itemPrice: 2980,
        reviewCount: 0,
        reviewAverage: 0,
        postageFlag: 1,
        pointRate: 1,
        month: 7,
        priceEndTime: null,
      },
      scoring,
      ngWords,
    );
    assert.ok(drafts.length >= 1);
    for (const draft of drafts) {
      assert.deepEqual(validateComment(draft, scoring, ngWords, itemName), []);
    }
  });

  it('期間限定価格があるとセール速報の角度が出て、期限を本文に併記する', async () => {
    const { scoring, ngWords } = await config();
    const drafts = buildDraftComments(
      {
        itemName: 'ドリップバッグ コーヒー 100袋 詰め合わせ',
        genreName: 'コーヒー',
        itemPrice: 3980,
        reviewCount: 4300,
        reviewAverage: 4.5,
        postageFlag: 0,
        pointRate: 1,
        month: 8,
        priceEndTime: '2026-08-07T23:59:00+09:00',
      },
      scoring,
      ngWords,
    );
    const sale = drafts.find((d) => d.angle === 'セール速報');
    assert.ok(sale, `セール速報が出ていない: ${drafts.map((d) => d.angle).join(',')}`);
    // 「セール価格を書く場合、期限も必ず併記する」
    assert.ok(sale.text.includes('8/7まで'), sale.text);
  });

  it('期限もポイント倍率も無ければセール速報は出さない（価格を訴求できないため）', async () => {
    const { scoring, ngWords } = await config();
    const drafts = buildDraftComments(
      {
        itemName: 'ドリップバッグ コーヒー 100袋 詰め合わせ',
        genreName: 'コーヒー',
        itemPrice: 3980,
        reviewCount: 4300,
        reviewAverage: 4.5,
        postageFlag: 0,
        pointRate: 1,
        month: 8,
        priceEndTime: null,
      },
      scoring,
      ngWords,
    );
    assert.equal(drafts.some((d) => d.angle === 'セール速報'), false);
  });

  it('商品名に手がかりが無い角度は選ばない（別商品の紹介文にならないように）', async () => {
    const { scoring, ngWords } = await config();
    const drafts = buildDraftComments(
      {
        itemName: '珪藻土バスマット 速乾 吸水 Lサイズ',
        genreName: '日用品雑貨',
        itemPrice: 3480,
        reviewCount: 620,
        reviewAverage: 4.3,
        postageFlag: 0,
        pointRate: 1,
        month: 8,
        priceEndTime: null,
      },
      scoring,
      ngWords,
    );
    // 冷凍・味付けなどの語が無いので献立負担は付かない
    assert.equal(drafts.some((d) => d.angle === '献立負担'), false, drafts.map((d) => d.angle).join(','));
    assert.ok(drafts.length >= 1, '案が0件になった');
  });
});

describe('補助関数', () => {
  it('カテゴリ語は商品名の中で先に出てくるものを選ぶ', () => {
    // 実データ: 骨取りさばの商品名の後半に「プロテイン」があり、
    // 「プロテインならレビュー35,712件」という投稿文が生成されていた
    assert.equal(extractNoun('骨取りサバ切身 1kg 冷凍食品 高タンパク プロテイン', '食品'), '冷凍食品');
    assert.equal(extractNoun('プロテイン 1kg ホエイ 冷凍食品と一緒に', '食品'), 'プロテイン');
  });

  it('同じ位置なら長い語を優先する', () => {
    assert.equal(extractNoun('インスタントコーヒー 詰め替え', 'コーヒー'), 'インスタントコーヒー');
  });

  it('見つからなければジャンル名の先頭を使う', () => {
    assert.equal(extractNoun('謎の商品', 'キッズ・ベビー・マタニティ'), 'キッズ');
    assert.equal(extractNoun('謎の商品', ''), '毎日使うもの');
  });

  it('1文字のカテゴリ語が複合語の一部に誤マッチしない', () => {
    // 実データで「吸水」から「水」を拾い「水の買い出し」という投稿文になった
    assert.equal(extractNoun('珪藻土バスマット 速乾 吸水 日本製', '日用品雑貨'), '日用品雑貨');
    assert.equal(extractNoun('防水シーツ 2枚組', '日用品雑貨'), '日用品雑貨');
    // 独立した語として現れる場合は拾う
    assert.equal(extractNoun('天然水 2L×12本 ケース', '水・ソフトドリンク'), '水');
    assert.equal(extractNoun('水 500ml×24本', '水・ソフトドリンク'), '水');
  });

  it('数量表記から1個あたり単価を出す', () => {
    assert.deepEqual(extractUnitPrice('500ml×24本 まとめ買い', 3480), { count: 24, unit: '本', unitPrice: 145 });
    assert.equal(extractUnitPrice('2kg 送料無料', 5398), null);
    assert.equal(extractUnitPrice('1本 お試し', 500), null);
  });

  it('ヘッダーに入れる数字は単価を最優先にする', () => {
    const input = {
      itemName: 'x',
      genreName: 'y',
      itemPrice: 3480,
      reviewCount: 5000,
      reviewAverage: 4.5,
      postageFlag: 0,
      pointRate: 10,
      month: 8,
    };
    assert.equal(headerNumber(input, { count: 24, unit: '本', unitPrice: 145 }), '1本145円');
    // 単価が出せなければポイント倍率 → レビュー件数 → 価格の順
    assert.equal(headerNumber(input, null), 'ポイント10倍');
    assert.equal(headerNumber({ ...input, pointRate: 1 }, null), 'レビュー5,000件');
    assert.equal(headerNumber({ ...input, pointRate: 1, reviewCount: 3 }, null), '3,480円');
  });

  it('期限はJSTの日付で「8/7まで」の形にする', () => {
    assert.equal(deadlineLabel('2026-08-07T23:59:00+09:00'), '8/7まで');
    // UTC表記でもJSTに直して判定する（16:00Zは翌日1:00 JST）
    assert.equal(deadlineLabel('2026-08-07T16:00:00Z'), '8/8まで');
    assert.equal(deadlineLabel(null), null);
    assert.equal(deadlineLabel('こわれた日付'), null);
  });

  it('季節判定', () => {
    assert.equal(seasonOf(1), 'winter');
    assert.equal(seasonOf(4), 'spring');
    assert.equal(seasonOf(7), 'summer');
    assert.equal(seasonOf(10), 'autumn');
    assert.equal(seasonOf(12), 'winter');
  });
});
