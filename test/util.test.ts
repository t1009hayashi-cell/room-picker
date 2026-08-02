import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays, diffDays, isoToJstDateKey, parseRakutenDateTime, toJstDateKey } from '../src/util/datetime.js';
import { parseAffiliateRate, toNumber, toNumberOrNull } from '../src/util/parse.js';
import { pickImageUrl, sanitizeUrl } from '../src/util/url.js';

describe('datetime（仕様書 5.1 日時の正規化）', () => {
  it('JSTとして解釈し +09:00 を付与する', () => {
    assert.equal(parseRakutenDateTime('2026-08-04 20:00'), '2026-08-04T20:00:00+09:00');
    assert.equal(parseRakutenDateTime('2026-08-11 01:59'), '2026-08-11T01:59:00+09:00');
    assert.equal(parseRakutenDateTime('2026-8-4 9:5'), '2026-08-04T09:05:00+09:00');
    assert.equal(parseRakutenDateTime('9999-12-31 23:59'), '9999-12-31T23:59:00+09:00');
  });

  it('空文字・空白・不正値はすべて null に統一する', () => {
    assert.equal(parseRakutenDateTime(''), null);
    assert.equal(parseRakutenDateTime('   '), null);
    assert.equal(parseRakutenDateTime(undefined), null);
    assert.equal(parseRakutenDateTime(null), null);
    assert.equal(parseRakutenDateTime('なし'), null);
    assert.equal(parseRakutenDateTime('2026-02-30 10:00'), null);
  });

  it('ホストのタイムゾーンに依存せず JST の日付キーを返す', () => {
    // UTC 2026-07-31T21:00Z = JST 2026-08-01 06:00
    assert.equal(toJstDateKey(new Date('2026-07-31T21:00:00Z')), '2026-08-01');
    // UTC 2026-07-31T14:59Z = JST 2026-07-31 23:59
    assert.equal(toJstDateKey(new Date('2026-07-31T14:59:00Z')), '2026-07-31');
    assert.equal(isoToJstDateKey('2026-08-11T01:59:00+09:00'), '2026-08-11');
  });

  it('日付の加減算が月またぎで正しい', () => {
    assert.equal(addDays('2026-07-31', 1), '2026-08-01');
    assert.equal(addDays('2026-08-01', -1), '2026-07-31');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(diffDays('2026-08-01', '2026-08-11'), 10);
  });
});

describe('parse（仕様書 4.1 型混在の吸収）', () => {
  it('文字列の価格を数値化する', () => {
    assert.equal(toNumber('8360'), 8360);
    assert.equal(toNumber('8,360'), 8360);
    assert.equal(toNumber(8360), 8360);
    assert.equal(toNumber(''), 0);
    assert.equal(toNumberOrNull(''), null);
  });

  it('文字列比較にならないことを確認する（"10000" < "9000" 問題）', () => {
    assert.equal(toNumber('10000') > toNumber('9000'), true);
  });

  it('affiliateRate はパーセント表記なので100で割る', () => {
    assert.equal(parseAffiliateRate('4.0'), 0.04);
    assert.equal(parseAffiliateRate('6.0'), 0.06);
    assert.equal(parseAffiliateRate('12.5'), 0.125);
    assert.equal(parseAffiliateRate(''), null);
    assert.equal(parseAffiliateRate('0'), null);
    assert.equal(parseAffiliateRate(undefined), null);
  });
});

describe('url（仕様書 4.1.2 アプリID露出の防止）', () => {
  it('rafcid を除去する', () => {
    const appId = 'aaaa-bbbb-cccc-dddd';
    assert.equal(
      sanitizeUrl(`https://item.rakuten.co.jp/shop/item/?rafcid=wsc_i_ra_${appId}`, appId),
      'https://item.rakuten.co.jp/shop/item/',
    );
    assert.equal(
      sanitizeUrl(`https://www.rakuten.co.jp/shop/?rafcid=wsc_i_ra_${appId}`, appId),
      'https://www.rakuten.co.jp/shop/',
    );
  });

  it('アプリIDを値に含む未知のパラメータも除去する', () => {
    const appId = 'aaaa-bbbb';
    assert.equal(sanitizeUrl(`https://example.com/x?foo=1&sid=wsc_${appId}`, appId), 'https://example.com/x?foo=1');
  });

  it('アフィリエイト転送URLから実際の商品URLを取り出す（新APIの形式）', () => {
    const appId = '5891715c-b3d2-4a84-91bf-d955622151a1';
    const affiliate =
      `https://hb.afl.rakuten.co.jp/hgc/${appId}/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fkouragumi%2F202114%2F` +
      '&m=http%3A%2F%2Fm.rakuten.co.jp%2Fkouragumi%2Fi%2F10001635%2F';
    const cleaned = sanitizeUrl(affiliate, appId);
    assert.equal(cleaned, 'https://item.rakuten.co.jp/kouragumi/202114/');
    assert.equal(cleaned.includes(appId), false);
  });

  it('転送先を取り出せない転送URLは、アプリIDを露出させるくらいなら捨てる', () => {
    const appId = '5891715c-b3d2-4a84-91bf-d955622151a1';
    assert.equal(sanitizeUrl(`https://hb.afl.rakuten.co.jp/hgc/${appId}/`, appId), '');
  });

  it('パスにアプリIDを含むURLは捨てる', () => {
    const appId = 'aaaa-bbbb';
    assert.equal(sanitizeUrl(`https://example.com/${appId}/item`, appId), '');
  });

  it('rafcid 以外のパラメータは残す', () => {
    assert.equal(sanitizeUrl('https://example.com/x?a=1&b=2'), 'https://example.com/x?a=1&b=2');
  });

  it('URLとして解釈できない場合はクエリを丸ごと落とす', () => {
    assert.equal(sanitizeUrl('item.rakuten.co.jp/x?rafcid=abc'), 'item.rakuten.co.jp/x');
    assert.equal(sanitizeUrl(''), '');
    assert.equal(sanitizeUrl(null), '');
  });

  it('mediumImageUrls はオブジェクト形式と文字列形式の両方を受ける', () => {
    assert.equal(pickImageUrl([{ imageUrl: 'https://img/1.jpg' }]), 'https://img/1.jpg');
    assert.equal(pickImageUrl(['https://img/2.jpg']), 'https://img/2.jpg');
    assert.equal(pickImageUrl([]), null);
    assert.equal(pickImageUrl(undefined), null);
  });
});
