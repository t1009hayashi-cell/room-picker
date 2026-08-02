import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDraftComments, extractNoun, extractUnitPrice, seasonOf, validateComment } from '../src/comment.js';
import { config } from './helpers.js';

const SAMPLES = [
  { itemName: '送料無料 コーヒー豆 コーヒー 2kg 怒涛の珈琲豆 粉 (G500×4) 加藤珈琲', genreName: 'コーヒー', itemPrice: 5398, postageFlag: 0 },
  { itemName: 'ラベルレス ミネラルウォーター 500ml×24本 まとめ買い', genreName: '水・ソフトドリンク', itemPrice: 3480, postageFlag: 0 },
  { itemName: 'トイレットペーパー 12ロール×8パック 業務用', genreName: '日用品雑貨', itemPrice: 4280, postageFlag: 1 },
  { itemName: 'おむつ テープ Mサイズ 2パック まとめ買い', genreName: 'キッズ・ベビー・マタニティ', itemPrice: 6980, postageFlag: 0 },
  { itemName: 'フライパン 26cm IH対応 セット', genreName: 'キッチン用品・食器', itemPrice: 8800, postageFlag: 0 },
  { itemName: '訳あり 冷凍食品 詰め合わせ 20食', genreName: '食品', itemPrice: 5980, postageFlag: 0 },
  { itemName: 'スイーツ 福袋 チョコレート 1kg 大容量', genreName: 'スイーツ・お菓子', itemPrice: 3980, postageFlag: 0 },
  { itemName: '謎の商品', genreName: '食品', itemPrice: 3200, postageFlag: 1 },
];

describe('投稿文テンプレート（仕様書 9.1）', () => {
  it('すべての月・すべてのサンプルで生成ルールを満たす', async () => {
    const { scoring, ngWords } = await config();
    for (const sample of SAMPLES) {
      for (let month = 1; month <= 12; month += 1) {
        const drafts = buildDraftComments(
          { ...sample, reviewCount: 4300, reviewAverage: 4.53, pointRate: 10, month },
          scoring,
          ngWords,
        );
        assert.equal(drafts.length, 2, `${sample.itemName} / ${month}月: 角度が2つでない`);
        assert.equal(new Set(drafts.map((d) => d.angle)).size, 2, '同じ角度が2つ選ばれた');

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

  it('商品名に含まれる「最安値」等を投稿文に転記しない', async () => {
    const { scoring, ngWords } = await config();
    const drafts = buildDraftComments(
      {
        itemName: '【楽天1位】最安値挑戦 半額 コーヒー豆 2kg',
        genreName: 'コーヒー',
        itemPrice: 5398,
        reviewCount: 100,
        reviewAverage: 4.5,
        postageFlag: 0,
        pointRate: 1,
        month: 8,
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

  it('1行目が商品名の書き出しから始まらない', async () => {
    const { scoring, ngWords } = await config();
    const drafts = buildDraftComments(
      {
        itemName: 'コーヒー豆 2kg 送料無料',
        genreName: 'コーヒー',
        itemPrice: 5398,
        reviewCount: 100,
        reviewAverage: 4.5,
        postageFlag: 0,
        pointRate: 1,
        month: 8,
      },
      scoring,
      ngWords,
    );
    for (const draft of drafts) {
      assert.equal(draft.firstLine.startsWith('コーヒー豆'), false, draft.firstLine);
    }
  });

  it('レビューが0件でも生成できる', async () => {
    const { scoring, ngWords } = await config();
    const drafts = buildDraftComments(
      {
        itemName: '麦茶 2L×12本 ケース',
        genreName: '水・ソフトドリンク',
        itemPrice: 2980,
        reviewCount: 0,
        reviewAverage: 0,
        postageFlag: 1,
        pointRate: 1,
        month: 7,
      },
      scoring,
      ngWords,
    );
    for (const draft of drafts) {
      assert.deepEqual(validateComment(draft, scoring, ngWords, '麦茶 2L×12本 ケース'), []);
    }
  });
});

describe('補助関数', () => {
  it('カテゴリ語は長い語を優先する', () => {
    assert.equal(extractNoun('インスタントコーヒー 詰め替え', 'コーヒー'), 'インスタントコーヒー');
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

  it('季節判定', () => {
    assert.equal(seasonOf(1), 'winter');
    assert.equal(seasonOf(4), 'spring');
    assert.equal(seasonOf(7), 'summer');
    assert.equal(seasonOf(10), 'autumn');
    assert.equal(seasonOf(12), 'winter');
  });
});
