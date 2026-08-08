import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ANGLES,
  CRITERIA,
  HEADER_TYPES,
  extractPostFeatures,
  headerBand,
  lineLengthBand,
  totalLengthBand,
} from '../docs/js/lib/postFeatures.js';

/** 投稿プロンプトの「正しい出力例」をそのまま使う */
const SAMPLE = [
  '夏休みのお昼ごはん、もうネタが尽きた',
  '',
  'そんな日に冷凍庫から出すだけ',
  '2年連続 楽天グルメ大賞のさば',
  '',
  '✅骨取り済みで小分け冷凍',
  '✅流水30分で解凍できる',
  '✅8/11まで50%OFF 2,980円',
  '✅送料無料',
  '',
  '塩焼きでもフライでも使えて',
  '味付けを変えれば飽きない',
  '',
  '難点があるとすれば',
  '思ったより早くなくなること',
  '',
  '在庫と価格は楽天市場のページで👇',
  '',
  '─────────────',
  '#共働き家庭のまとめ買い #冷凍ストック #骨取り魚 #時短ごはん #まとめ買い #買ってよかった #育ち盛り #献立に困ったら #お取り寄せ #オリジナル写真',
].join('\n');

describe('投稿した文章から特徴を取る', () => {
  const f = extractPostFeatures(SAMPLE);

  it('ヘッダーは1行目', () => {
    assert.equal(f.headerText, '夏休みのお昼ごはん、もうネタが尽きた');
    assert.equal(f.headerLength, 18);
  });

  it('空行は行数に数えない（改行の細かさを見たいため）', () => {
    // 中身のある行だけを数える
    assert.equal(f.lineCount, 13);
  });

  it('記号付き箇条書きの行数を数える', () => {
    assert.equal(f.bulletLines, 4);
    assert.equal(f.hasBullets, true);
  });

  it('CTA・罫線・絵文字・数字を判定する', () => {
    assert.equal(f.hasCta, true);
    assert.equal(f.hasDivider, true);
    assert.equal(f.hasEmoji, true);
    assert.equal(f.hasNumber, true);
  });

  it('ハッシュタグを数え、オリジナル写真タグを見つける', () => {
    assert.equal(f.hashtagCount, 10);
    assert.equal(f.hasOriginalPhotoTag, true);
  });

  it('1行あたりの平均文字数を出す（上位ほど短いという実測がある）', () => {
    assert.ok(f.averageLineLength > 0 && f.averageLineLength <= 24, `平均 ${f.averageLineLength}字`);
  });

  it('タグ込みの文字数は本文より長い（ROOMの上限500文字の判定に使う）', () => {
    assert.ok(f.totalLength > f.bodyLength);
  });

  it('箇条書きもCTAも無い文章では立たない', () => {
    const plain = extractPostFeatures('ふつうの見出し\nふつうの本文です\n#a #b');
    assert.equal(plain.hasBullets, false);
    assert.equal(plain.hasCta, false);
    assert.equal(plain.hasDivider, false);
    assert.equal(plain.hasOriginalPhotoTag, false);
    assert.equal(plain.hashtagCount, 2);
  });

  it('空文字でも落ちない', () => {
    const empty = extractPostFeatures('');
    assert.equal(empty.headerLength, 0);
    assert.equal(empty.lineCount, 0);
    assert.equal(empty.averageLineLength, 0);
    assert.equal(empty.hashtagCount, 0);
  });

  it('ハッシュタグを1行目に置いた形でも数えられる', () => {
    const first = extractPostFeatures('#a #b #c\n見出し\n本文');
    assert.equal(first.hashtagCount, 3);
    assert.equal(first.headerText, '見出し');
  });
});

describe('文字数帯の区切り（投稿プロンプトの実測値）', () => {
  it('ヘッダーは20〜30文字が推奨', () => {
    assert.equal(headerBand(15), '〜19');
    assert.equal(headerBand(25), '20〜30');
    assert.equal(headerBand(35), '31〜');
  });

  it('全体はROOMの上限500文字を意識して区切る', () => {
    assert.equal(totalLengthBand(200), '〜250');
    assert.equal(totalLengthBand(322), '251〜350');
    assert.equal(totalLengthBand(400), '351〜480');
    assert.equal(totalLengthBand(520), '481〜（上限超え）');
  });

  it('1行あたりの平均は24文字以下が細かい', () => {
    assert.equal(lineLengthBand(21), '〜24（細かい）');
    assert.equal(lineLengthBand(26), '25〜29');
    assert.equal(lineLengthBand(32), '30〜（粗い）');
    assert.equal(lineLengthBand(0), '不明');
  });
});

describe('分類の選択肢（投稿プロンプトに載っているもの）', () => {
  it('角度は7種', () => {
    assert.equal(ANGLES.length, 7);
    for (const a of ['スーパーにない型', '評判の裏取り型', 'セール速報型', 'ギフト型']) {
      assert.ok(ANGLES.includes(a), `${a} が無い`);
    }
  });

  it('ヘッダー型に共感課題型と状況名指し型が入っている（実測で上位に多い）', () => {
    assert.ok(HEADER_TYPES.includes('共感課題型'));
    assert.ok(HEADER_TYPES.includes('状況名指し型'));
  });

  it('選定基準は3つ', () => {
    assert.deepEqual(CRITERIA, ['スーパーにない', '評価が高い', '今だけ安い']);
  });
});
