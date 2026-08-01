import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildResults,
  decodeCsv,
  guessMapping,
  importCsv,
  parseAmount,
  parseCsv,
  parseCsvDateTime,
  parseRate,
} from '../docs/js/lib/csv.js';

const HEADER = '注文日時,商品名,ショップ名,ジャンル,売上金額,報酬額,料率,デバイス,計測ID,ステータス';
const ROW1 =
  '2026/08/05 21:33,"送料無料 コーヒー豆 コーヒー 2kg 怒涛の珈琲豆 粉 (G500×4) 加藤珈琲/",グルメコーヒー豆専門！加藤珈琲店,食品,"5,398",324,4%,スマートフォン,楽天ROOM,未確定';

describe('CSVパーサ（仕様書 10.2）', () => {
  it('引用符・カンマ・改行を含むフィールドを扱える', () => {
    const rows = parseCsv('a,"b,c",d\n"複数\n行",2,3');
    assert.deepEqual(rows[0], ['a', 'b,c', 'd']);
    assert.deepEqual(rows[1], ['複数\n行', '2', '3']);
  });

  it('二重引用符のエスケープを解く', () => {
    assert.deepEqual(parseCsv('"a""b",c')[0], ['a"b', 'c']);
  });

  it('CRLF を扱える', () => {
    assert.equal(parseCsv('a,b\r\nc,d').length, 2);
  });
});

describe('文字コードの判定', () => {
  it('UTF-8 をそのまま読む', () => {
    const { text, encoding } = decodeCsv(new TextEncoder().encode('商品名,売上金額').buffer);
    assert.equal(text, '商品名,売上金額');
    assert.equal(encoding, 'UTF-8');
  });

  it('BOM付きUTF-8のBOMを落とす', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('商品名')]);
    const { text, encoding } = decodeCsv(bytes.buffer);
    assert.equal(text, '商品名');
    assert.equal(encoding, 'UTF-8 (BOM)');
  });

  it('UTF-8として不正なら Shift_JIS で読み直す', () => {
    // 「商品名,売上金額」の Shift_JIS バイト列
    const sjis = new Uint8Array([
      0x8f, 0xa4, 0x95, 0x69, 0x96, 0xbc, 0x2c, 0x94, 0x84, 0x8f, 0xe3, 0x8b, 0xe0, 0x8a, 0x7a,
    ]);
    const { text, encoding } = decodeCsv(sjis.buffer);
    assert.equal(text, '商品名,売上金額');
    assert.equal(encoding, 'Shift_JIS');
  });
});

describe('列名でのマッピング（位置の決め打ち禁止）', () => {
  it('想定どおりのヘッダを対応付ける', () => {
    const mapping = guessMapping(HEADER.split(','));
    assert.equal(mapping.occurredAt, 0);
    assert.equal(mapping.itemNameRaw, 1);
    assert.equal(mapping.salesAmount, 4);
    assert.equal(mapping.reward, 5);
    assert.equal(mapping.status, 9);
  });

  it('列の順序が変わっても列名で追従する', () => {
    const mapping = guessMapping(['報酬額', '商品名', '注文日', '売上金額']);
    assert.equal(mapping.reward, 0);
    assert.equal(mapping.itemNameRaw, 1);
    assert.equal(mapping.occurredAt, 2);
    assert.equal(mapping.salesAmount, 3);
  });

  it('表記ゆれ（括弧・空白）を吸収する', () => {
    const mapping = guessMapping(['注文日 (JST)', '商品名', '売上金額（税込）', '報酬額']);
    assert.equal(mapping.occurredAt, 0);
    assert.equal(mapping.salesAmount, 2);
  });

  it('列名が想定と違ってもエラーで落とさず未マッピングを返す', () => {
    const rows = [['col_a', 'col_b'], ['1', '2']];
    const built = buildResults(rows, guessMapping(rows[0]));
    assert.equal(built.results.length, 0);
    assert.equal(built.missing.length > 0, true);
    assert.match(built.warnings[0], /手動で列を指定/);
  });
});

describe('値のパース', () => {
  it('金額の記号とカンマを落とす', () => {
    assert.equal(parseAmount('5,398'), 5398);
    assert.equal(parseAmount('¥5,398'), 5398);
    assert.equal(parseAmount('324円'), 324);
    assert.equal(parseAmount(''), 0);
  });

  it('料率は % 表記でも小数でも同じ値になる', () => {
    assert.equal(parseRate('4%'), 0.04);
    assert.equal(parseRate('4'), 0.04);
    assert.equal(parseRate('0.04'), 0.04);
    assert.equal(parseRate(''), null);
  });

  it('日時を JST の ISO に揃える', () => {
    assert.equal(parseCsvDateTime('2026/08/05 21:33'), '2026-08-05T21:33:00+09:00');
    assert.equal(parseCsvDateTime('2026-08-05'), '2026-08-05T00:00:00+09:00');
    assert.equal(parseCsvDateTime('2026年8月5日 9:05'), '2026-08-05T09:05:00+09:00');
    assert.equal(parseCsvDateTime(''), null);
  });
});

describe('成果レコードの組み立て（仕様書 5.5）', () => {
  it('1行を成果レコードに変換する', () => {
    const parsed = importCsv(new TextEncoder().encode(`${HEADER}\n${ROW1}`).buffer);
    assert.equal(parsed.results.length, 1);
    const row = parsed.results[0];
    assert.equal(row.occurredAt, '2026-08-05T21:33:00+09:00');
    // itemNameRaw は突合キー。整形・トリムを一切しない（末尾の / も残る）
    assert.equal(row.itemNameRaw, '送料無料 コーヒー豆 コーヒー 2kg 怒涛の珈琲豆 粉 (G500×4) 加藤珈琲/');
    assert.equal(row.salesAmount, 5398);
    assert.equal(row.reward, 324);
    assert.equal(row.rate, 0.04);
    assert.equal(row.trackingId, '楽天ROOM');
    assert.equal(row.status, '未確定');
    assert.equal(row.matchedPostId, null);
  });

  it('料率列が無ければ 報酬÷売上 で補う', () => {
    const header = '注文日,商品名,売上金額,報酬額';
    const parsed = importCsv(new TextEncoder().encode(`${header}\n2026/08/05,商品A,1000,40`).buffer);
    assert.equal(parsed.results[0].rate, 0.04);
  });

  it('itemNameRaw を突合キーとして無加工で保持する（前後の空白も残す）', () => {
    const header = '注文日,商品名,売上金額,報酬額';
    const parsed = importCsv(new TextEncoder().encode(`${header}\n2026/08/05,"  空白つき商品名 ",1000,40`).buffer);
    assert.equal(parsed.results[0].itemNameRaw, '  空白つき商品名 ');
  });

  it('完全一致を優先してから部分一致に降りる（「売上金額」が「報酬金額」列を奪わない）', () => {
    const mapping = guessMapping(['注文日', '商品名', '商品代金', '報酬金額']);
    assert.equal(mapping.reward, 3);
    assert.notEqual(mapping.salesAmount, 3);
  });

  it('日付や商品名を読めない行は読み飛ばして警告する', () => {
    const header = '注文日,商品名,売上金額,報酬額';
    const parsed = importCsv(new TextEncoder().encode(`${header}\n2026/08/05,商品A,1000,40\n,,,`).buffer);
    assert.equal(parsed.results.length, 1);
  });
});
