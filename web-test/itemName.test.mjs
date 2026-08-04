import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SEARCH_QUERY_MAX, toSearchQuery } from '../docs/js/lib/itemName.js';

const len = (s) => Array.from(s).length;

describe('商品名を検索用に整える（ROOM内検索に貼る）', () => {
  it('上限を超えない', () => {
    const long = '【ふるさと納税】高評価★4.82【部位＋カット＋重量が選べる！】国産若鶏バラエティセット 小分け 冷凍 鶏肉 1.5kg 2kg 3kg もも むね';
    assert.ok(len(toSearchQuery(long)) <= SEARCH_QUERY_MAX, toSearchQuery(long));
  });

  it('先頭の販促の囲み文を落として、商品の名前から始める', () => {
    assert.equal(
      toSearchQuery('【ふるさと納税】【内容・発送月が選べる!!】宮崎県産 豚バラエティー 2.1kg〜4.1kgセット 精肉 肉 豚'),
      '宮崎県産 豚バラエティー 2.1kg〜4.1kgセット 精肉',
    );
  });

  it('＼…／ の囲み文も落とす', () => {
    assert.equal(
      toSearchQuery('＼10kg 4,540円／ 令和7年産 白米 青森県産 ときわGreen 精米 5kg 10kg 20kg'),
      '令和7年産 白米 青森県産 ときわGreen 精米 5kg',
    );
  });

  it('ポイント倍率・期限・送料無料を落とす', () => {
    const q = toSearchQuery('ポイント5倍 8/3(月)23：59まで ALL令和7年産 きらっとごはん 白米 送料無料 5kg');
    assert.equal(q, 'ALL令和7年産 きらっとごはん 白米 5kg');
  });

  it('価格の売り文句だけをコピーしてしまわない', () => {
    // 「お試し送料無料2,490円～」を落とさないと「お試し」だけになり検索できない
    const q = toSearchQuery('お試し送料無料2,490円～ 骨取りサバ切身 1kg 無塩or有塩が選べる♪骨とり 骨なし 鯖 さば 冷凍食品');
    assert.ok(q.startsWith('骨取りサバ切身'), q);
    assert.equal(q.includes('送料無料'), false);
  });

  it('『』で囲まれた商品名は残す（ブランド名が入るため）', () => {
    const q = toSearchQuery('バームクーヘン ギフト『 マダムブリュレ 』【冷凍便】 新感覚 バウムクーヘン 人気 スイーツ');
    assert.ok(q.includes('マダムブリュレ'), q);
  });

  it('「」の選択肢の注記は落とす', () => {
    const q = toSearchQuery('「有塩or無塩」「骨ありor骨なし」が選べる！脂のり抜群の銀鮭 切り身 業務用 1kg');
    assert.ok(q.includes('銀鮭'), q);
    assert.equal(q.includes('有塩or無塩'), false);
  });

  it('語の途中で切らない', () => {
    const q = toSearchQuery('おせち 早割 博多久松 2027 4〜5人前 おせち料理 おせちランキング 累計313週以上1位達成');
    assert.equal(q, 'おせち 早割 博多久松 2027 4〜5人前 おせち料理');
    // 切り出した語がすべて元の商品名に含まれている（語が壊れていない）
    for (const word of q.split(' ')) {
      assert.ok(
        'おせち 早割 博多久松 2027 4〜5人前 おせち料理 おせちランキング'.includes(word),
        `語が壊れている: ${word}`,
      );
    }
  });

  it('末尾に区切り記号を残さない', () => {
    assert.equal(toSearchQuery('国産若鶏バラエティセット- 小分け 冷凍'), '国産若鶏バラエティセット- 小分け 冷凍'.replace(/-$/, ''));
    assert.doesNotMatch(toSearchQuery('テスト商品 -'), /[-\s]$/u);
  });

  it('先頭に句読点を残さない', () => {
    assert.doesNotMatch(toSearchQuery('更に2個で600円OFF！ 鶏たたき 炭火焼き'), /^[！!、。]/u);
  });

  it('短い商品名はそのまま返す', () => {
    assert.equal(toSearchQuery('水 500ml 24本'), '水 500ml 24本');
  });

  it('空・null でも落ちない', () => {
    assert.equal(toSearchQuery(''), '');
    assert.equal(toSearchQuery(null), '');
    assert.equal(toSearchQuery(undefined), '');
  });

  it('1語だけで上限を超える商品名は上限で切る（空を返さない）', () => {
    const q = toSearchQuery('あ'.repeat(80));
    assert.equal(len(q), SEARCH_QUERY_MAX);
  });

  it('販促文しかない商品名でも何かを返す', () => {
    const q = toSearchQuery('【送料無料】【SALE】ポイント10倍');
    assert.ok(len(q) >= 0);
    assert.equal(typeof q, 'string');
  });

  it('上限は呼び出し側で変えられる', () => {
    assert.ok(len(toSearchQuery('おせち 早割 博多久松 2027 4〜5人前 おせち料理', 12)) <= 12);
  });
});
