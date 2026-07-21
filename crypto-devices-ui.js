// /Friends/crypto-devices-ui.js
// Управление E2EE-устройствами и ручная сверка safety number.

const esc = value => String(value || '').replace(/[&<>"']/g, char => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;'
})[char]);

const shortFingerprint = value => {
  const text = String(value || '');
  return text.match(/.{1,8}/g)?.join(' ') || '—';
};

const fmt = value => Number(value || 0) > 0
  ? new Date(Number(value)).toLocaleString('ru-RU')
  : '—';

export const openCryptoDevicesUi = async ({
  core,
  friendId,
  name = 'Друг',
  openModal,
  toast,
  confirmAction = async () => false
} = {}) => {
  if (!core || !friendId || typeof openModal !== 'function') return false;

  const ov = openModal(`
    <div class="vf-modal-head vf-chat-head">
      <b>🔐 Защита чата</b>
      <button class="vf-btn vf-sec vf-chat-close" type="button" data-crypto-close>✕</button>
    </div>
    <div class="vf-crypto-body">
      <div class="vf-empty">
        <span>⏳</span>
        <b>Проверяем ключи...</b>
      </div>
    </div>
  `, { closeOnBackdrop: false });

  ov.querySelector('[data-crypto-close]')?.addEventListener(
    'click',
    () => ov.vfClose?.()
  );

  const root = ov.querySelector('.vf-crypto-body');

  const render = async () => {
    const [own, all, local, safety] = await Promise.all([
      core.getOwnCryptoDevices(),
      core.getCryptoDevices(friendId),
      core.getLocalCryptoDevice(),
      core.getSafetyNumber(friendId).catch(() => null)
    ]);

    const peer = all.filter(item => item.ownerId === friendId);
    const verified = core.getSafetyVerification(friendId);
    const safetyChanged = !!(
      verified?.safetyId &&
      safety?.safetyId &&
      verified.safetyId !== safety.safetyId
    );

    const renderDevice = (item, mine = false) => `
      <div class="vf-crypto-device">
        <div>
          <b>${mine ? 'Моё устройство' : esc(name)}</b>
          <small>${esc(item.label || 'Устройство')} · ${fmt(item.createdAt)}</small>
          <code>${esc(shortFingerprint(item.fingerprint))}</code>
          ${item.revokedAt ? '<em>отозвано</em>' : ''}
          ${local?.deviceId === item.deviceId ? '<em class="is-ok">private key есть локально</em>' : ''}
        </div>
        ${mine && !item.revokedAt ? `
          <button class="vf-btn vf-danger" type="button" data-revoke="${esc(item.deviceId)}">
            Отозвать
          </button>
        ` : ''}
      </div>
    `;

    root.innerHTML = `
      ${!local ? `
        <div class="vf-crypto-warning">
          ⚠️ Локальный private key не найден. Старые сообщения этого устройства восстановить невозможно.
        </div>
      ` : ''}
      ${safetyChanged ? `
        <div class="vf-crypto-warning">
          ⚠️ Набор ключей собеседника изменился после предыдущей проверки. Сверьте safety number заново.
        </div>
      ` : ''}
      <section class="vf-crypto-section">
        <h3>Мои ключи</h3>
        ${own.length
          ? own.map(item => renderDevice(item, true)).join('')
          : '<div class="vf-empty"><small>Ключи не зарегистрированы</small></div>'}
      </section>
      <section class="vf-crypto-section">
        <h3>Ключи ${esc(name)}</h3>
        ${peer.length
          ? peer.map(item => renderDevice(item, false)).join('')
          : '<div class="vf-crypto-warning">Собеседник ещё не зарегистрировал E2EE-устройство.</div>'}
      </section>
      <section class="vf-crypto-section">
        <h3>Safety number</h3>
        ${safety ? `
          <p>Сравните этот код голосом или при личной встрече. Он должен полностью совпасть у обоих.</p>
          <code class="vf-safety-number">${esc(safety.display)}</code>
          <p>Для проверки передайте код собеседнику напрямую. Private key и сообщения никуда не отправляются.</p>
          <div class="vf-actions">
            <button class="vf-btn vf-sec" type="button" data-copy-safety>Копировать код</button>
            <button class="vf-btn" type="button" data-verify-safety>
              ${verified?.safetyId === safety.safetyId && !safetyChanged
                ? '✓ Проверено'
                : 'Коды совпали'}
            </button>
          </div>
        ` : `
          <div class="vf-crypto-warning">
            Safety number недоступен, пока у обоих нет активных ключей.
          </div>
        `}
      </section>
      <button class="vf-btn vf-danger" type="button" data-reset-crypto>
        Полный сброс моих ключей
      </button>
      <p class="vf-crypto-footnote">
        Полный сброс отзовёт все ваши E2EE-устройства. Старые сообщения, для которых нет нового envelope, станут недоступны.
      </p>
    `;

    root.querySelectorAll('[data-revoke]').forEach(button => {
      button.addEventListener('click', async () => {
        const confirmed = await confirmAction({
          title: 'Отозвать ключ устройства?',
          text: 'Устройство потеряет доступ к новым сообщениям. Без подходящего ключа часть истории может стать недоступна.',
          confirmText: 'Отозвать устройство',
          dangerous: true
        });

        if (!confirmed) return;

        try {
          await core.revokeCryptoDevice(button.dataset.revoke);
          toast?.('Устройство отозвано');
          await render();
        } catch (error) {
          toast?.(`Ошибка: ${error.message}`);
        }
      });
    });

    root.querySelector('[data-copy-safety]')?.addEventListener('click', async () => {
      await navigator.clipboard?.writeText?.(safety.display).catch(() => null);
      toast?.('Safety number скопирован');
    });

    root.querySelector('[data-verify-safety]')?.addEventListener('click', async () => {
      const confirmed = await confirmAction({
        title: 'Подтвердить safety number?',
        text: 'Подтвердите только после личной сверки полного кода с собеседником.',
        confirmText: 'Коды совпали'
      });

      if (!confirmed) return;

      core.setSafetyVerified(friendId, safety);
      toast?.('Ключи собеседника проверены');
      render();
    });

    root.querySelector('[data-reset-crypto]')?.addEventListener('click', async () => {
      const confirmed = await confirmAction({
        title: 'Полностью сбросить E2EE-ключи?',
        text: 'Все текущие ключи будут отозваны. Старые сообщения без подходящего envelope могут стать недоступны навсегда.',
        confirmText: 'Сбросить ключи',
        dangerous: true
      });

      if (!confirmed) return;

      try {
        await core.resetCryptoDevices();
        toast?.('Создан новый ключ шифрования');
        await render();
      } catch (error) {
        toast?.(`Ошибка сброса: ${error.message}`);
      }
    });
  };

  try {
    await render();
  } catch (error) {
    root.innerHTML = `
      <div class="vf-crypto-warning">
        Не удалось загрузить криптоустройства: ${esc(error.message)}
      </div>
    `;
  }

  return true;
};

export default { openCryptoDevicesUi };
