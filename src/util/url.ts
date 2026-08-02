/**
 * 仕様書 4.1.2 対応。
 * `itemUrl` / `shopUrl` の末尾に `?rafcid=wsc_i_ra_<アプリID>` が自動付与される。
 * パブリックリポジトリにコミットするとアプリIDが露出するため、保存前に必ず除去する。
 */

const RAFCID_KEYS = ['rafcid', 'scid', 'sc2id'];

/**
 * rafcid 等のトラッキングパラメータを除去する。
 * appId を渡した場合、値にアプリIDを含むパラメータも併せて除去する（付与形式が変わった場合の保険）。
 */
export function sanitizeUrl(rawUrl: unknown, appId?: string | null): string {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return '';
  const url = rawUrl.trim();

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // URLとして解釈できない場合はクエリ文字列ごと落とす
    const idx = url.indexOf('?');
    return idx === -1 ? url : url.slice(0, idx);
  }

  // 2026年の新APIは商品URLをアフィリエイト転送URLで返し、
  // そのパスにアプリIDが入る:
  //   https://hb.afl.rakuten.co.jp/hgc/<アプリID>/?pc=<実URL>&m=<モバイル用URL>
  // このままコミットするとパブリックリポジトリにアプリIDが露出する（仕様書 4.1.2）。
  // 転送先の実URLを取り出して置き換える。楽天アプリが商品ページへ正しく遷移しない問題も
  // 転送URLが原因なので、ここで解消される。
  if (parsed.hostname === 'hb.afl.rakuten.co.jp') {
    const target = parsed.searchParams.get('pc') ?? parsed.searchParams.get('m');
    if (target) return sanitizeUrl(target, appId);
    // 転送先を取り出せない場合はアプリIDを含むURLを渡さない
    return '';
  }

  for (const key of RAFCID_KEYS) parsed.searchParams.delete(key);

  if (appId) {
    for (const [key, value] of [...parsed.searchParams.entries()]) {
      if (value.includes(appId)) parsed.searchParams.delete(key);
    }
    // パスにアプリIDが残る形式は想定外なので、URL自体を捨てる（露出させない方を優先する）
    if (parsed.pathname.includes(appId) || parsed.hostname.includes(appId)) return '';
  }

  const query = parsed.searchParams.toString();
  parsed.search = query === '' ? '' : `?${query}`;
  return parsed.toString();
}

/** mediumImageUrls は formatVersion により `[{imageUrl}]` と `[string]` の両方がありうる */
export function pickImageUrl(images: unknown, appId?: string | null): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  const first = images[0];
  const raw =
    typeof first === 'string'
      ? first
      : first && typeof first === 'object' && 'imageUrl' in first
        ? (first as { imageUrl?: unknown }).imageUrl
        : null;
  const cleaned = sanitizeUrl(raw, appId);
  return cleaned === '' ? null : cleaned;
}
