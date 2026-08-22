/**
 * 選択を求めるダイアログ。
 *
 * **なぜ必要か。**
 * 投稿の分類は、投稿ログ47件のうち27件が空欄だった。原因は
 * 「投稿済みにする」を押した後に分類を入れる動線がなく、
 * 入れなくても保存できてしまうこと。分類のない投稿は分析で
 * 「（未設定）」に落ち、後から遡って付け直すこともできない。
 *
 * そこで**投稿を確定する手前に置く**。1タップで終わる形にして、
 * 投稿の妨げにならない範囲に留める（追加要件v1.2 1.3 / 6章）。
 */

/**
 * 選択肢を1つ選んでもらう。選ばれた値、閉じられた場合は null を返す。
 * `options` は文字列の配列、または `{ value, label, note }` の配列。
 */
export function chooseOne({ title, description = '', options, cancelLabel = 'やめる' }) {
  return new Promise((resolve) => {
    const items = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));

    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal__panel" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <h3 class="modal__title">${escapeHtml(title)}</h3>
        ${description ? `<p class="modal__desc">${escapeHtml(description)}</p>` : ''}
        <div class="modal__options">
          ${items
            .map(
              (item, i) => `<button class="btn modal__option" data-index="${i}">
                <span class="modal__optionLabel">${escapeHtml(item.label)}</span>
                ${item.note ? `<span class="modal__optionNote">${escapeHtml(item.note)}</span>` : ''}
              </button>`,
            )
            .join('')}
        </div>
        <button class="btn btn--ghost modal__cancel">${escapeHtml(cancelLabel)}</button>
      </div>
    `;

    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
    };

    overlay.addEventListener('click', (event) => {
      // 背景を押したときだけ閉じる。パネル内の空白では閉じない
      if (event.target === overlay) close(null);
      const option = event.target.closest('.modal__option');
      if (option) close(items[Number(option.dataset.index)].value);
      if (event.target.closest('.modal__cancel')) close(null);
    });
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    overlay.querySelector('.modal__option')?.focus();
  });
}

/**
 * 主たる操作がリンク遷移になる確認ダイアログ。
 *
 * **なぜ `window.open` にしないのか。**
 * 分類ダイアログの `await` を挟んだあとの `window.open` は
 * ユーザー操作の文脈から外れており、iOS Safari のポップアップブロックに引っかかる。
 * クリップボードへの書き込みも同じ理由で失敗しうる。
 * 実体の `<a>` をタップしてもらえば、コピーも遷移もユーザー操作の中で起きる。
 *
 * `onActivate` はリンクを押した瞬間に呼ばれる（遷移は止めない）。
 */
export function confirmAction({ title, description = '', href, actionLabel, note = '', closeLabel = '閉じる', onActivate }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal__panel" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <h3 class="modal__title">${escapeHtml(title)}</h3>
        ${description ? `<p class="modal__desc">${escapeHtml(description)}</p>` : ''}
        <a class="btn btn--primary modal__link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(actionLabel)}</a>
        ${note ? `<p class="small muted" style="margin:8px 0 0">${escapeHtml(note)}</p>` : ''}
        <button class="btn btn--ghost modal__cancel">${escapeHtml(closeLabel)}</button>
      </div>
    `;

    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
    };

    overlay.querySelector('.modal__link').addEventListener('click', () => {
      // 遷移は既定の動作に任せる。ここではコピーなど、同じ操作でやりたいことだけ行う
      onActivate?.();
      close(true);
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(false);
      if (event.target.closest('.modal__cancel')) close(false);
    });
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    overlay.querySelector('.modal__link').focus();
  });
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function escapeAttr(text) {
  return escapeHtml(text);
}
