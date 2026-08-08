import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ANGLES,
  DIVIDER,
  buildDraftComments,
  deadlineLabel,
  extractNoun,
  extractUnitPrice,
  isNotInStore,
  seasonOf,
  validateComment,
  wrapLine,
} from '../src/comment.js';
import { config } from './helpers.js';

const SAMPLES = [
  { itemName: '骨取りサバ切身 1kg 冷凍食品 業務用 小分け', genreName: '食品', itemPrice: 4980, postageFlag: 0 },
  { itemName: 'ラベルレス ミネラルウォーター 500ml×24本 まとめ買い', genreName: '水・ソフトドリンク', itemPrice: 3480, postageFlag: 0 },
  { itemName: 'ドリップバッグ コーヒー 100袋 詰め合わせ 業務用', genreName: 'コーヒー', itemPrice: 3980, postageFlag: 0 },
  { itemName: '訳あり 冷凍食品 詰め合わせ 20食 大容量', genreName: '食品', itemPrice: 5980, postageFlag: 0 },
  { itemName: 'スイーツ ギフト 詰め合わせ 化粧箱 12個入り', genreName: 'スイーツ・お菓子', itemPrice: 3980, postageFlag: 0 },
];

const base = {
  reviewCount: 4300,
  reviewAverage: 4.53,
  pointRate: 10,
  priceEndTime: null as string | null,
  discountRate: null as number | null,
  hasCoupon: false,
  couponDeadlineRaw: null as string | null,
};

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

  it('角度は投稿プロンプトの7種から選ばれる', async () => {
    const { scoring, ngWords } = await config();
    for (const sample of SAMPLES) {
      for (const draft of buildDraftComments({ ...sample, ...base, month: 8 }, scoring, ngWords)) {
        assert.ok((ANGLES as readonly string[]).includes(draft.angle), `想定外の角度: ${draft.angle}`);
      }
    }
  });

  it('冒頭に割引率を置かない（実測で条件訴求は下位の標準装備）', async () => {
    const { scoring, ngWords } = await config();
    const drafts = buildDraftComments(
      { ...SAMPLES[0]!, ...base, month: 8, discountRate: 60, couponDeadlineRaw: '8/11まで', hasCoupon: true },
      scoring,
      ngWords,
    );
    for (const draft of drafts) {
      assert.doesNotMatch(draft.firstLine, /\d+\s*[%％]\s*OFF/iu, `冒頭に割引率がある: ${draft.firstLine}`);
    }
    // 価格情報は捨てず、箇条書きの行に入れる
    const sale = drafts.find((d) => d.angle === 'セール速報型');
    assert.ok(sale, 'セール速報型が出ていない');
    assert.ok(sale.text.includes('60%OFF'), sale.text);
    assert.ok(sale.text.includes('8/11まで'), sale.text);
  });

  it('記号付き箇条書き・CTA・罫線が必ず入る', async () => {
    const { scoring, ngWords } = await config();
    for (const sample of SAMPLES) {
      for (const draft of buildDraftComments({ ...sample, ...base, month: 8 }, scoring, ngWords)) {
        const bullets = draft.text.split('\n').filter((l) => l.startsWith('✅')).length;
        assert.ok(bullets >= scoring.comment.bulletMin, `箇条書きが${bullets}行: ${draft.text}`);
        assert.ok(draft.text.includes('👇'), `CTAが無い: ${draft.text}`);
        assert.ok(draft.text.includes(DIVIDER), `罫線が無い: ${draft.text}`);
      }
    }
  });

  it('ハッシュタグは10〜15個で、コレクションタグを必ず含む', async () => {
    const { scoring, ngWords } = await config();
    for (const sample of SAMPLES) {
      for (const draft of buildDraftComments({ ...sample, ...base, month: 8 }, scoring, ngWords)) {
        assert.ok(
          draft.hashtags.length >= 10 && draft.hashtags.length <= 15,
          `${draft.hashtags.length}個: ${draft.hashtags.join(' ')}`,
        );
        assert.ok(draft.hashtags.includes('#共働き家庭のまとめ買い'), draft.hashtags.join(' '));
      }
    }
  });

  it('1行が30文字を超えない（上位ほど1行が短い）', async () => {
    const { scoring, ngWords } = await config();
    for (const sample of SAMPLES) {
      for (const draft of buildDraftComments({ ...sample, ...base, month: 8 }, scoring, ngWords)) {
        for (const line of draft.text.split('\n')) {
          assert.ok(Array.from(line).length <= scoring.comment.lineMax, `長すぎる行: ${line}`);
        }
      }
    }
  });

  it('タグ込みで480文字を超えない（ROOMの上限は500文字）', async () => {
    const { scoring, ngWords } = await config();
    for (const sample of SAMPLES) {
      for (const draft of buildDraftComments({ ...sample, ...base, month: 8 }, scoring, ngWords)) {
        const body = draft.text
          .split('\n')
          .filter((l) => l.trim() !== '')
          .reduce((sum, l) => sum + Array.from(l).length, 0);
        const overall = body + draft.hashtags.join(' ').length;
        assert.ok(overall <= 480, `${overall}文字: ${draft.text}`);
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

  it('商品名に含まれる「最安値」等を投稿文に転記しない', async () => {
    const { scoring, ngWords } = await config();
    const drafts = buildDraftComments(
      { itemName: '【楽天1位】最安値挑戦 半額 冷凍食品 20食 業務用', genreName: '食品', itemPrice: 5980, postageFlag: 0, ...base, month: 8 },
      scoring,
      ngWords,
    );
    for (const draft of drafts) {
      for (const banned of ngWords.commentBanned) {
        assert.equal(draft.text.includes(banned), false, `禁止語「${banned}」が混入: ${draft.text}`);
      }
    }
  });
});

describe('補助関数', () => {
  it('長い行を目安の文字数で折る。句読点を優先する', () => {
    const wrapped = wrapLine('帰ってすぐ出せるものがあると、夕飯の組み立てが一気に楽になる', 24);
    assert.ok(wrapped.length >= 2, wrapped.join(' / '));
    for (const line of wrapped) assert.ok(Array.from(line).length <= 24, line);
    // 句読点の位置で切れている
    assert.ok(wrapped[0]!.endsWith('、') || Array.from(wrapped[0]!).length === 24);
  });

  it('短い行はそのまま返す', () => {
    assert.deepEqual(wrapLine('短い行', 24), ['短い行']);
  });

  it('句読点が無い行は文節の切れ目で折る（語を割らない）', () => {
    // 助詞（ひらがな）の直後で切る
    assert.deepEqual(wrapLine('同じものを何度も買い直すより置いておけるほうが結局早いと思う', 24), [
      '同じものを何度も買い直すより置いておけるほうが',
      '結局早いと思う',
    ]);
  });

  it('漢字＋送り仮名＋漢字の途中では切らない', () => {
    // 「積み上がる」を「積み／上がっていく」と割らない
    const wrapped = wrapLine('毎日のことなので、ほんの少しの手間の差でも積み上がっていく', 24);
    assert.ok(
      wrapped.every((l) => !l.endsWith('積み')),
      wrapped.join(' / '),
    );
    assert.ok(wrapped.some((l) => l.includes('積み上がっていく')), wrapped.join(' / '));
  });

  it('「スーパーにない」の手がかりを判定する（単価を出してよいかの基準）', () => {
    assert.equal(isNotInStore('コーヒー豆 2kg 業務用'), true);
    assert.equal(isNotInStore('骨取りサバ切身'), true);
    // スーパーにも置いてある商品では単価を出さない
    assert.equal(isNotInStore('ふりかけ 3袋'), false);
  });

  it('カテゴリ語は商品名の中で先に出てくるものを選ぶ', () => {
    assert.equal(extractNoun('骨取りサバ切身 1kg 冷凍食品 高タンパク プロテイン', '食品'), '冷凍食品');
    assert.equal(extractNoun('インスタントコーヒー 詰め替え', 'コーヒー'), 'インスタントコーヒー');
  });

  it('1文字のカテゴリ語が複合語の一部に誤マッチしない', () => {
    assert.equal(extractNoun('珪藻土バスマット 速乾 吸水 日本製', '日用品雑貨'), '日用品雑貨');
    assert.equal(extractNoun('天然水 2L×12本 ケース', '水・ソフトドリンク'), '水');
  });

  it('数量表記から1個あたり単価を出す', () => {
    assert.deepEqual(extractUnitPrice('500ml×24本 まとめ買い', 3480), { count: 24, unit: '本', unitPrice: 145 });
    assert.equal(extractUnitPrice('2kg 送料無料', 5398), null);
  });

  it('期限はJSTの日付で「8/7まで」の形にする', () => {
    assert.equal(deadlineLabel('2026-08-07T23:59:00+09:00'), '8/7まで');
    assert.equal(deadlineLabel(null), null);
  });

  it('季節判定', () => {
    assert.equal(seasonOf(1), 'winter');
    assert.equal(seasonOf(4), 'spring');
    assert.equal(seasonOf(7), 'summer');
    assert.equal(seasonOf(10), 'autumn');
  });
});
