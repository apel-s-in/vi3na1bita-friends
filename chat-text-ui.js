// /Friends/chat-text-ui.js
// Текстовый чат: UI, optimistic-send, reply/quote, reactions, retry, adaptive polling.
import { openCryptoDevicesUi } from './crypto-devices-ui.js?v=8.8.8';
const esc = v => String(v || '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
})[c]);

const fmtChatTime = ts => {
  const d = new Date(Number(ts || Date.now()));
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yy}.${mm}.${dd} ${hh}:${mi}`;
};

const fmtStatusTime = ts => Number(ts || 0) > 0 ? fmtChatTime(ts) : '—';
const REACTION_EMOJIS = ['❤️', '👍', '🔥', '👏', '😱', '👎', '🥰'];

export const openTextChatModal = ({
  friendId,
  name = 'Друг',
  core,
  openModal,
  toast,
  onActiveChatChange = () => {}
} = {}) => {
  if (!friendId || !core || typeof openModal !== 'function') return false;

  let lastAt = 0;
  let timer = 0;
  let loadBusy = false;
  let loadFails = 0;
  let replyTo = null;
  let sendBusy = false;
  let cleanupObserver = null;

  const seen = new Set();
  const rowsByMsgId = new Map();
  const rowsByClientId = new Map();
  const messagesById = new Map();

  const statusLabel = msg => {
    if (msg.localStatus === 'failed') return '⚠️ не доставлено';
    if (msg.readAt) return '✓✓ прочитано';
    if (msg.deliveredAt) return '✓✓ доставлено';
    if (msg.createdAt) return '✓ отправлено';
    return '… отправка';
  };

  const statusDetails = msg => [
    `Отправлено: ${fmtStatusTime(msg.createdAt)}`,
    `Доставлено: ${fmtStatusTime(msg.deliveredAt)}`,
    `Прочитано: ${fmtStatusTime(msg.readAt)}`,
    msg.localStatus === 'failed' ? `Ошибка: ${msg.error || 'не отправлено'}` : ''
  ].filter(Boolean).join('\n');

  const ov = openModal(`
    <div class="vf-modal-head vf-chat-head">
      <button class="vf-btn vf-sec vf-chat-gear" type="button" id="vf-chat-settings" title="Настройки">⚙</button>
      <b>Чат с ${esc(name)}</b>
      <button class="vf-btn vf-sec vf-chat-close" type="button" id="vf-chat-close" title="Закрыть">✕</button>
    </div>
    <div class="vf-chat-settings-panel" hidden>
      <label class="vf-chat-retention">
        <span>Хранить сообщения в этом диалоге</span>
        <select id="vf-chat-retention">
          <option value="1">1 день</option>
          <option value="7">1 неделю</option>
          <option value="30">1 месяц</option>
        </select>
      </label>
      <button class="vf-btn vf-sec" type="button" id="vf-chat-crypto">🔐 Устройства и проверка ключей</button>
      <button class="vf-btn vf-sec" type="button" id="vf-chat-clear">Очистить только у меня</button>
      <button class="vf-btn vf-danger" type="button" id="vf-chat-purge-both">Удалить переписку у обоих</button>
    </div>
    <div class="vf-chat-log" aria-live="polite"></div>
    <div class="vf-chat-reply" hidden>
      <span></span>
      <button type="button" class="vf-chat-reply-x">×</button>
    </div>
    <form class="vf-chat-form">
      <textarea rows="1" maxlength="1000" placeholder="Сообщение..." autocomplete="off"></textarea>
      <span class="vf-chat-counter" hidden></span>
      <button class="vf-btn vf-chat-send" type="submit">▶</button>
    </form>
  `, { closeOnBackdrop: false });

  ov.querySelector('.vf-modal')?.classList.add('vf-chat-modal');

  const log = ov.querySelector('.vf-chat-log');
  const input = ov.querySelector('textarea');
  const panel = ov.querySelector('.vf-chat-settings-panel');
  const retentionSelect = ov.querySelector('#vf-chat-retention');
  const replyBox = ov.querySelector('.vf-chat-reply');
  const replyTextEl = replyBox.querySelector('span');

  core.getChatSettings(friendId).then(settings => {
    if (retentionSelect) {
      retentionSelect.value = String(settings?.retentionDays || 30);
    }
  }).catch(() => {});

  retentionSelect?.addEventListener('change', async () => {
    try {
      await core.setChatRetention(
        friendId,
        Number(retentionSelect.value)
      );

      lastAt = 0;
      seen.clear();
      rowsByMsgId.clear();
      rowsByClientId.clear();
      messagesById.clear();
      log.innerHTML = '';

      await load();
      toast?.('Срок хранения сохранён');
    } catch (err) {
      toast?.(`Ошибка: ${err.message}`);
    }
  });

  const renderReply = () => {
    if (!replyTo) {
      replyBox.hidden = true;
      replyTextEl.textContent = '';
      return;
    }
    replyBox.hidden = false;
    replyTextEl.textContent = `Ответ: ${replyTo.text}`;
  };

  const normalizeMyReactions = msg => {
    let mine = msg?.reactions?.[core.identity?.friendId];
    if (typeof mine === 'string') mine = mine ? [mine] : [];
    return Array.isArray(mine) ? mine.filter(Boolean).slice(0, 3) : [];
  };

  const renderQuoteHtml = msg => msg.replyToMsgId
    ? `<button type="button" class="vf-chat-quote" data-reply-to="${esc(msg.replyToMsgId)}"><span>↩ ответ</span><b>${esc(msg.replyText || 'Сообщение')}</b></button>`
    : '';

  const renderReactions = reactions => {
    const entries = Object.entries(reactions || {}).flatMap(([uid, raw]) => {
      const arr = (Array.isArray(raw) ? raw : (raw ? [raw] : [])).filter(Boolean).slice(0, 3);
      return arr.map(emoji => ({ uid, emoji }));
    });
    if (!entries.length) return '';
    return `<div class="vf-chat-reactions">${entries.map(x => `<span class="${x.uid === core.identity?.friendId ? 'is-my' : 'is-peer'}">${esc(x.emoji)}</span>`).join('')}</div>`;
  };

  const renderMessageInner = msg => {
    const mine = msg.fromFriendId === core.identity?.friendId;
    return `
      <div class="vf-chat-bubble" role="button" tabindex="0">
        ${renderQuoteHtml(msg)}
        <span class="vf-chat-text">${msg.encrypted ? '🔒 ' : ''}${esc(msg.text || '')}</span>
        ${renderReactions(msg.reactions)}
      </div>
      ${mine ? `
        <div class="vf-chat-statusline">
          <button class="vf-chat-retry" type="button" ${msg.localStatus === 'failed' ? '' : 'hidden'}>↻</button>
          <button class="vf-chat-status-btn" type="button">${esc(statusLabel(msg))}</button>
        </div>
      ` : `<div class="vf-chat-time">${fmtChatTime(msg.createdAt)}</div>`}
    `;
  };

  const getRowMessage = row => {
    const msgId = row?.dataset?.msgId || '';
    const clientMsgId = row?.dataset?.clientMsgId || '';
    return messagesById.get(msgId) || messagesById.get(clientMsgId) || null;
  };

  const scrollToMessage = msgId => {
    const row = rowsByMsgId.get(msgId) || rowsByClientId.get(msgId);
    if (!row) {
      toast?.('Исходное сообщение не найдено в загруженной истории');
      return false;
    }
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('is-target');
    setTimeout(() => row.classList.remove('is-target'), 1400);
    return true;
  };

  const setRowKeys = (row, msg) => {
    const prevMsgId = row.dataset.msgId || '';
    const prevClientId = row.dataset.clientMsgId || '';
    const nextMsgId = msg.msgId || prevMsgId || '';
    const nextClientId = msg.clientMsgId || prevClientId || '';

    if (prevMsgId && prevMsgId !== nextMsgId) rowsByMsgId.delete(prevMsgId);
    if (prevClientId && prevClientId !== nextClientId) rowsByClientId.delete(prevClientId);

    row.dataset.msgId = nextMsgId;
    row.dataset.clientMsgId = nextClientId;

    if (nextMsgId) {
      rowsByMsgId.set(nextMsgId, row);
      messagesById.set(nextMsgId, msg);
    }
    if (nextClientId) {
      rowsByClientId.set(nextClientId, row);
      messagesById.set(nextClientId, msg);
    }
  };

  const updateMessage = msg => {
    const row = (msg.msgId && rowsByMsgId.get(msg.msgId)) || (msg.clientMsgId && rowsByClientId.get(msg.clientMsgId)) || null;
    if (!row) return false;

    const prevMsgId = row.dataset.msgId || '';
    const prevClientId = row.dataset.clientMsgId || '';
    const cur = { ...(messagesById.get(prevMsgId) || messagesById.get(prevClientId) || {}), ...msg };

    setRowKeys(row, cur);
    row.innerHTML = renderMessageInner(cur);
    return true;
  };

  const append = msg => {
    const key = msg.clientMsgId || msg.msgId || `${msg.fromFriendId}:${msg.createdAt}:${msg.text}`;
    if (seen.has(key) || (msg.clientMsgId && rowsByClientId.has(msg.clientMsgId)) || (msg.msgId && rowsByMsgId.has(msg.msgId))) {
      updateMessage(msg);
      return;
    }

    seen.add(key);

    const mine = msg.fromFriendId === core.identity?.friendId;
    const row = document.createElement('div');
    row.className = `vf-chat-msg ${mine ? 'is-mine' : 'is-friend'}`;
    row.innerHTML = renderMessageInner(msg);
    setRowKeys(row, msg);

    row.addEventListener('click', e => {
      const quote = e.target.closest?.('[data-reply-to]');
      if (quote && row.contains(quote)) {
        e.preventDefault();
        e.stopPropagation();
        scrollToMessage(quote.dataset.replyTo || '');
        return;
      }

      const retry = e.target.closest?.('.vf-chat-retry');
      if (retry && row.contains(retry)) {
        e.preventDefault();
        e.stopPropagation();
        retryMessage(getRowMessage(row));
        return;
      }

      const status = e.target.closest?.('.vf-chat-status-btn');
      if (status && row.contains(status)) {
        e.preventDefault();
        e.stopPropagation();
        const cur = getRowMessage(row);
        if (cur) alert(statusDetails(cur));
        return;
      }

      const bubble = e.target.closest?.('.vf-chat-bubble');
      if (bubble && row.contains(bubble)) {
        e.preventDefault();
        const cur = getRowMessage(row);
        if (cur) openMessageMenu(cur);
      }
    });

    log.append(row);
    log.scrollTop = log.scrollHeight;
  };

  const pushIncomingMessage = msg => {
    if (!msg || msg.fromFriendId !== friendId) return false;

    if (Number(msg.cryptoVersion || 0) === 2 && !msg.crypto) {
      load().catch(() => false);
      return true;
    }

    append({
      msgId: msg.msgId || msg.pushId || `push-${Date.now()}`,
      clientMsgId: msg.clientMsgId || '',
      fromFriendId: msg.fromFriendId,
      toFriendId: core.identity?.friendId,
      text: msg.text || '',
      replyToMsgId: msg.replyToMsgId || '',
      replyText: msg.replyText || '',
      reactions: msg.reactions || {},
      createdAt: msg.createdAt || Date.now(),
      deliveredAt: msg.deliveredAt || msg.createdAt || Date.now(),
      readAt: msg.readAt || Date.now()
    });
    lastAt = Math.max(lastAt, Number(msg.createdAt || 0), Number(msg.updatedAt || 0));
    log.scrollTop = log.scrollHeight;
    return true;
  };

  const load = async () => {
    if (loadBusy || document.hidden) return false;
    loadBusy = true;
    try {
      const items = await core.getChatMessages({ friendId, after: lastAt });
      loadFails = 0;
      items.forEach(msg => {
        lastAt = Math.max(lastAt, Number(msg.createdAt || 0), Number(msg.updatedAt || 0));
        append(msg);
      });
      return items.length ? 'has-new' : true;
    } catch (err) {
      loadFails = Math.min(loadFails + 1, 8);
      if (Number(err?.status) === 429) loadFails = Math.max(loadFails, 5);
      return false;
    } finally {
      loadBusy = false;
    }
  };

  let idleTicks = 0;
  const scheduleLoad = () => {
    clearTimeout(timer);
    const base = idleTicks > 4 ? 30000 : 8000;
    const delay = Math.min(45000, base + loadFails * 6000);
    timer = setTimeout(async () => {
      const got = await load();
      idleTicks = got === 'has-new' ? 0 : idleTicks + 1;
      scheduleLoad();
    }, delay);
  };

  const sendText = async text => {
    const sentReply = replyTo;
    const localId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const localMsg = {
      msgId: localId,
      clientMsgId: localId,
      fromFriendId: core.identity?.friendId,
      text,
      replyToMsgId: sentReply?.msgId || '',
      replyText: sentReply?.text || '',
      createdAt: Date.now(),
      deliveredAt: 0,
      readAt: 0,
      localStatus: 'sending',
      cryptoVersion: 2,
      encrypted: true
    };

    append(localMsg);
    replyTo = null;
    renderReply();

    try {
      const res = await core.sendChatMessage({
        toFriendId: friendId,
        text,
        replyToMsgId: sentReply?.msgId || '',
        replyText: sentReply?.text || '',
        clientMsgId: localId
      });
      const createdAt = res.createdAt || Date.now();
      lastAt = Math.max(lastAt, Number(createdAt || 0));
      const realMsg = {
        ...localMsg,
        msgId: res.msgId || localId,
        createdAt,
        deliveredAt: res?.webPush?.sent > 0 ? createdAt : 0,
        cryptoVersion: 2,
        encrypted: true,
        localStatus: ''
      };
      seen.add(realMsg.msgId);
      updateMessage(realMsg);
    } catch (err) {
      const raw = String(err?.message || 'send_failed');
      const friendly =
        raw.includes('crypto_peer_not_ready')
          ? 'Собеседник ещё не открыл обновлённый раздел «Друзья» и не зарегистрировал ключ шифрования'
          : raw.includes('crypto_local_key_missing')
            ? 'Локальный ключ шифрования потерян. Откройте настройки криптоустройств'
            : raw.includes('crypto_envelope')
              ? 'Не удалось подготовить ключи для всех устройств'
              : raw.includes('chat_revision_conflict')
                ? 'Сообщение изменилось на другом устройстве. Повторите действие'
                : raw;

      localMsg.localStatus = 'failed';
      localMsg.error = friendly;
      messagesById.set(localId, localMsg);

      if (localMsg.clientMsgId) {
        messagesById.set(localMsg.clientMsgId, localMsg);
      }

      updateMessage(localMsg);
      toast?.(`Не отправлено: ${friendly}`);
    }
  };

  const retryMessage = async msg => {
    if (!msg?.text) return;
    const row = rowsByMsgId.get(msg.msgId) || rowsByClientId.get(msg.clientMsgId);
    row?.remove();

    if (msg.msgId) {
      rowsByMsgId.delete(msg.msgId);
      messagesById.delete(msg.msgId);
      seen.delete(msg.msgId);
    }
    if (msg.clientMsgId) {
      rowsByClientId.delete(msg.clientMsgId);
      messagesById.delete(msg.clientMsgId);
      seen.delete(msg.clientMsgId);
    }

    replyTo = msg.replyToMsgId ? { msgId: msg.replyToMsgId, text: msg.replyText || 'Сообщение' } : null;
    await sendText(msg.text);
  };

  const openMessageMenu = msg => {
    if (msg?.decryptFailed) {
      toast?.('Сообщение нельзя изменить: ключ расшифровки недоступен');
      return;
    }

    if (msg?.deletedAt) {
      toast?.('Сообщение уже удалено');
      return;
    }

    const menu = openModal(`
      <div class="vf-chat-menu">
        <div class="vf-chat-reacts">
          ${REACTION_EMOJIS.map(x => `<button type="button" data-emoji="${esc(x)}" class="${normalizeMyReactions(msg).includes(x) ? 'is-selected' : ''}">${esc(x)}</button>`).join('')}
        </div>
        <button class="vf-btn vf-sec" type="button" data-m="reply">↩ Ответить</button>
        <button class="vf-btn vf-sec" type="button" data-m="copy">📋 Копировать текст</button>
        <button class="vf-btn vf-danger" type="button" data-m="delete">🗑 Удалить</button>
      </div>
    `);

    menu.querySelectorAll('[data-emoji]').forEach(b => b.onclick = async () => {
      try {
        const res = await core.reactChatMessage({
          friendId,
          msgId: msg.msgId,
          emoji: b.dataset.emoji,
          message: msg
        });
        const cur = { ...(messagesById.get(msg.msgId) || msg), reactions: res.reactions || {} };
        updateMessage(cur);
        menu.vfClose?.();
      } catch (err) {
        toast?.(`Ошибка: ${err.message}`);
      }
    });

    menu.querySelector('[data-m="reply"]').onclick = () => {
      replyTo = { msgId: msg.msgId, text: String(msg.text || '').slice(0, 160) };
      renderReply();
      menu.vfClose?.();
      input?.focus?.();
    };

    menu.querySelector('[data-m="copy"]').onclick = async () => {
      await navigator.clipboard?.writeText?.(msg.text || '').catch(() => null);
      menu.vfClose?.();
      toast?.('Скопировано');
    };

    menu.querySelector('[data-m="delete"]').onclick = async () => {
      if (!confirm('Удалить сообщение у обоих собеседников?')) return;
      try {
        const result = await core.deleteChatMessage({
          friendId,
          msgId: msg.msgId,
          message: msg
        });

        updateMessage({
          ...msg,
          text: 'Сообщение удалено',
          replyToMsgId: '',
          replyText: '',
          reactions: {},
          deletedAt: Number(result.at || Date.now()),
          updatedAt: Number(result.at || Date.now()),
          encrypted: true,
          cryptoVersion: 2
        });

        lastAt = Math.max(
          lastAt,
          Number(result.at || Date.now())
        );
        menu.vfClose?.();
      } catch (err) {
        toast?.(`Ошибка: ${err.message}`);
      }
    };
  };

  const close = () => {
    clearTimeout(timer);
    cleanupObserver?.disconnect?.();
    onActiveChatChange(null);
    ov.vfClose?.();
  };

  const counterEl = ov.querySelector('.vf-chat-counter');
  const autoGrow = () => {
    if (!input) return;
    input.style.height = 'auto';
    const cap = Math.max(160, Math.floor(window.innerHeight * 0.40));
    input.style.height = `${Math.min(input.scrollHeight, cap)}px`;
    input.classList.toggle('is-scroll', input.scrollHeight > cap);
    if (counterEl) {
      const left = 1000 - input.value.length;
      counterEl.hidden = left > 200;
      counterEl.textContent = String(left);
    }
    log.scrollTop = log.scrollHeight;
  };

  ov.querySelector('#vf-chat-close').onclick = close;
  ov.querySelector('#vf-chat-settings').onclick = () => { panel.hidden = !panel.hidden; };
  ov.querySelector('.vf-chat-reply-x').onclick = () => {
    replyTo = null;
    renderReply();
  };
  ov.querySelector('#vf-chat-crypto').onclick = () => {
    openCryptoDevicesUi({
      core,
      friendId,
      name,
      openModal,
      toast
    });
  };
  ov.querySelector('#vf-chat-clear').onclick = async () => {
    if (!confirm('Скрыть всю историю этого диалога только у вас? У собеседника сообщения останутся.')) return;

    try {
      await core.clearChat(friendId);
      lastAt = Date.now();
      seen.clear();
      rowsByMsgId.clear();
      rowsByClientId.clear();
      messagesById.clear();
      log.innerHTML = '';
      panel.hidden = true;
      toast?.('Чат очищен только у вас');
    } catch (err) {
      toast?.(`Ошибка очистки: ${err.message}`);
    }
  };

  ov.querySelector('#vf-chat-purge-both').onclick = async () => {
    if (!confirm('Безвозвратно удалить всю переписку у вас и у собеседника?')) return;
    if (!confirm('Это действие нельзя отменить. Удалить переписку у обоих?')) return;

    try {
      await core.purgeChatForBoth(friendId);
      lastAt = Date.now();
      seen.clear();
      rowsByMsgId.clear();
      rowsByClientId.clear();
      messagesById.clear();
      log.innerHTML = '';
      panel.hidden = true;
      toast?.('Переписка удалена у обоих');
    } catch (err) {
      toast?.(`Ошибка удаления: ${err.message}`);
    }
  };

  input?.addEventListener('input', autoGrow);
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ov.querySelector('.vf-chat-form')?.requestSubmit?.();
    }
  });

  ov.querySelector('.vf-chat-form').onsubmit = async e => {
    e.preventDefault();
    if (sendBusy) return;
    const text = input.value.trim();
    if (!text) return;
    sendBusy = true;
    input.value = '';
    autoGrow();
    try {
      await sendText(text);
    } finally {
      sendBusy = false;
    }
  };

  cleanupObserver = new MutationObserver(() => {
    if (!document.body.contains(ov)) {
      clearTimeout(timer);
      cleanupObserver?.disconnect?.();
      onActiveChatChange(null);
    }
  });
  cleanupObserver.observe(document.body, { childList: true, subtree: true });

  onActiveChatChange({ friendId, pushIncomingMessage, scrollToMessage });
  load();
  scheduleLoad();
  setTimeout(() => {
    autoGrow();
    input?.focus?.();
  }, 80);

  return true;
};

export default { openTextChatModal };
