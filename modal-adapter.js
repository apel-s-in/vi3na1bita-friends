// /Friends/modal-adapter.js
// Единое Promise-based подтверждение для standalone, Music и embedded Friends.
// Parent-side security gate остаётся отдельным обязательным уровнем.

const esc = value => String(value || '').replace(
  /[&<>"']/g,
  char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[char]
);

export const createFriendsModalAdapter = ({
  openModal
} = {}) => {
  if (typeof openModal !== 'function') {
    throw new Error('friends_modal_host_required');
  }

  const confirm = ({
    title = 'Подтвердите действие',
    text = '',
    confirmText = 'Продолжить',
    cancelText = 'Отмена',
    dangerous = false
  } = {}) => new Promise(resolve => {
    let settled = false;

    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(!!value);
    };

    const overlay = openModal(`
      <div class="vf-modal-head">
        <b>${esc(title)}</b>
      </div>
      <div class="${dangerous ? 'vf-crypto-warning' : 'vf-confirm-text'}">
        ${esc(text)}
      </div>
      <div class="vf-actions">
        <button
          class="vf-btn ${dangerous ? 'vf-danger' : ''}"
          type="button"
          data-confirm-yes
        >
          ${esc(confirmText)}
        </button>
        <button
          class="vf-btn vf-sec"
          type="button"
          data-confirm-no
        >
          ${esc(cancelText)}
        </button>
      </div>
    `, {
      closeOnBackdrop: false
    });

    const closeOriginal = overlay.vfClose?.bind(overlay);

    const close = value => {
      finish(value);
      closeOriginal?.();
    };

    overlay.vfClose = () => close(false);

    overlay.querySelector('[data-confirm-yes]')
      ?.addEventListener('click', () => close(true));

    overlay.querySelector('[data-confirm-no]')
      ?.addEventListener('click', () => close(false));
  });

  return Object.freeze({
    confirm
  });
};

export default {
  createFriendsModalAdapter
};
