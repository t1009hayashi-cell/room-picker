/**
 * AI用プロンプトの生成（仕様書 9.2）。
 * 外部APIは呼ばない。テキストをクリップボードにコピーし、ユーザーが Claude に貼り付ける。
 *
 * 商品説明は日次JSONに 300 文字で切り詰めて保存しているため、プロンプトにもその範囲が入る
 * （仕様書 5.1 の「itemCaption を300文字で切り詰める」を優先した結果）。
 */

export function buildAiPrompt(item) {
  return `以下の商品について、楽天ROOMの投稿コメントを5案作ってください。

商品名：${item.itemName}
価格：${Math.round(item.itemPrice).toLocaleString('ja-JP')}円
ショップ：${item.shopName}
レビュー：${item.reviewCount}件（平均${item.reviewAverage}）
商品説明（先頭300文字）：${item.itemCaptionShort}

ターゲット：共働き世帯（子育て含む）
選定基準：まとめ買いで買い物回数を減らせるか

制約：
- 1行目は30〜35文字以内。ここしか表示されない
- 全体80〜150文字、1文ごとに改行、3行以内
- ハッシュタグ3〜4個
- 商品名の「最安値」「楽天1位」等は転記しない
- 実際には使用していないため、使用体験を装わない
- 5案は本文を近づけ、1行目のみ変える（ABテスト用）`;
}

export async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // iOS Safari で clipboard API が使えない場合のフォールバック
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  const ok = document.execCommand('copy');
  document.body.removeChild(area);
  return ok;
}
