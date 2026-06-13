// /Friends/friends-ui.js
// UI поверх FriendsCore: список друзей + добавление (ссылка/код/QR/почта).

import { getPlayableGames } from './games-registry.js';

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

export const mountFriendsUI = (root, core, { onGameInvite = null, onEnableWebPush = null, getUnread = null, getUnreadMeta = null, getWebPushEnabled = null, onUnreadClick = null, onChatOpened = null, onVoiceOpened = null } = {}) => {
  if (!root) return null;

  const el = document.createElement('section');
  el.className = 'vf-wrap';
  root.append(el);

  const toast = text => {
    let t = el.querySelector('.vf-toast');
    if (!t) { t = document.createElement('div'); t.className = 'vf-toast'; el.append(t); }
    t.textContent = text;
    t.classList.add('is-show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('is-show'), 1600);
  };

  const renderList = (friends = [], presence = {}) => `
    <div class="vf-head">
      <h2>Друзья</h2>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="vf-btn vf-btn-add ${typeof getWebPushEnabled === 'function' && getWebPushEnabled() ? 'vf-notify-on' : 'vf-notify-off'}" type="button" data-act="notify" title="${typeof getWebPushEnabled === 'function' && getWebPushEnabled() ? 'Системные уведомления включены' : 'Системные уведомления выключены'}">${typeof getWebPushEnabled === 'function' && getWebPushEnabled() ? '🔔 Увед.' : '🔕 Увед.'}</button>
        <button class="vf-btn vf-btn-add" type="button" data-act="add">＋ Добавить</button>
      </div>
    </div>
    <div class="vf-list">
      ${friends.length ? friends.map(f => {
        const fid = f.friendId;
        const name = f.profile?.displayName || 'Друг';
        const avatar = f.profile?.avatarUrl;
        const online = !!presence[fid]?.online;
        const unread = typeof getUnread === 'function' ? Number(getUnread(fid) || 0) : 0;
        return `
          <button class="vf-friend" type="button" data-friend="${esc(fid)}" data-name="${esc(name)}">
            <span class="vf-ava">${avatar ? `<img src="${esc(avatar)}" alt="">` : '👤'}</span>
            <b>${esc(name)}</b>
            ${unread ? `
              <span class="vf-unread" role="button" tabindex="0" data-unread-chat="${esc(fid)}" title="Открыть новое сообщение">
                💌${unread > 1 ? `<i>${unread > 9 ? '9+' : unread}</i>` : ''}
              </span>
            ` : `<small class="${online ? 'is-online' : ''}">${online ? 'онлайн' : 'не в сети'}</small>`}
          </button>
        `;
      }).join('') : `
        <div class="vf-empty">
          <span>👥</span>
          <b>Друзей пока нет</b>
          <small>Добавь друга по ссылке, коду или QR.</small>
        </div>
      `}
    </div>
  `;

  const refresh = async ({ force = false } = {}) => {
    if (!core.isReady()) {
      el.innerHTML = `<div class="vf-empty"><span>🔒</span><b>Войдите через Яндекс</b><small>Друзья доступны после входа в основном приложении.</small></div>`;
      return;
    }
    el.innerHTML = `<div class="vf-empty"><span>⏳</span><b>Загружаем друзей...</b></div>`;
    try {
      const friends = await core.getFriendList({ force });
      const presence = friends.length ? await core.getPresence(friends.map(f => f.friendId)) : {};
      el.innerHTML = renderList(friends, presence);
      bindList();
    } catch (err) {
      el.innerHTML = `<div class="vf-empty"><span>⚠️</span><b>Не удалось загрузить</b><small>${esc(err.message)}</small></div>`;
    }
  };

  const bindList = () => {
    el.querySelector('[data-act="add"]')?.addEventListener('click', openAddModal);
    el.querySelector('[data-act="notify"]')?.addEventListener('click', async () => {
      if (typeof onEnableWebPush !== 'function') {
        toast('Системные уведомления доступны в основном приложении');
        return;
      }

      const res = await onEnableWebPush();
      toast(res?.ok ? 'Системные уведомления включены' : `Уведомления не включены: ${res?.reason || 'ошибка'}`);
    });
    el.querySelectorAll('[data-unread-chat]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const friendId = btn.dataset.unreadChat;
        if (typeof onUnreadClick === 'function') onUnreadClick(friendId);
        else void openChat(friendId);
      });
    });

    el.querySelectorAll('[data-friend]').forEach(btn => {
      btn.addEventListener('click', () => openFriendActions(btn.dataset.friend, btn.dataset.name || 'Друг'));
    });
  };

  const openModal = html => {
    const ov = document.createElement('div');
    ov.className = 'vf-modal-ov';
    ov.innerHTML = `<div class="vf-modal">${html}</div>`;
    document.documentElement.classList.add('vf-modal-lock');
    document.body.classList.add('vf-modal-lock');
    el.append(ov);

    const close = () => {
      ov.remove();
      if (!document.querySelector('.vf-modal-ov')) {
        document.documentElement.classList.remove('vf-modal-lock');
        document.body.classList.remove('vf-modal-lock');
      }
    };

    ov.vfClose = close;
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    return ov;
  };

  const openFriendActions = (friendId, name) => {
    const games = getPlayableGames();
    const ov = openModal(`
      <div class="vf-modal-head"><span class="vf-ava">👤</span><b>${esc(name)}</b></div>
      <div class="vf-actions">
        <button class="vf-btn" data-a="invite">▶ Пригласить в игру</button>
        <button class="vf-btn vf-sec" data-a="chat">💬 Написать в чат</button>
        <button class="vf-btn vf-sec" data-a="push">🔔 Пригласить в приложение</button>
        <button class="vf-btn vf-sec" data-a="voice">🎙 Позвонить</button>
        <button class="vf-btn vf-danger" data-a="remove">🗑 Удалить из друзей</button>
      </div>
      <div class="vf-games" hidden>
        ${games.map(g => `<button class="vf-btn vf-sec" data-game="${esc(g.id)}">${esc(g.icon)} ${esc(g.title)}</button>`).join('')}
      </div>
    `);

    ov.querySelector('[data-a="invite"]')?.addEventListener('click', () => {
      ov.querySelector('.vf-games').hidden = false;
    });

    ov.querySelectorAll('[data-game]').forEach(b => {
      b.addEventListener('click', async () => {
        const gameId = b.dataset.game;
        const gameTitle = b.textContent.trim();
        let online = false;

        try {
          const presence = await core.getPresence([friendId]);
          online = !!presence[friendId]?.online;
        } catch {}

        ov.querySelector('.vf-modal').innerHTML = `
          <div class="vf-modal-head"><span class="vf-ava">👤</span><b>${esc(name)}</b></div>
          <div style="text-align:left;display:grid;gap:10px;margin-bottom:14px">
            <p style="margin:0;color:var(--vf-muted);font-size:13px;line-height:1.4">Вы хотите пригласить <b style="color:#fff">${esc(name)}</b> в игру <b style="color:#fff">${esc(gameTitle)}</b>?</p>
            <div style="padding:10px 12px;border-radius:14px;background:${online ? 'rgba(70,230,165,.1)' : 'rgba(255,212,90,.08)'};border:1px solid ${online ? 'rgba(70,230,165,.28)' : 'rgba(255,212,90,.28)'};color:${online ? '#adffdf' : '#ffe7a3'};font-size:12px;font-weight:900">
              Статус игрока: ${online ? 'онлайн' : 'не в сети · можно отправить push-вызов'}
            </div>
          </div>
          <div class="vf-actions">
            <button class="vf-btn" data-confirm-invite>Пригласить</button>
            <button class="vf-btn vf-sec" data-cancel-invite>Отклонить</button>
          </div>
        `;

        ov.querySelector('[data-cancel-invite]')?.addEventListener('click', () => ov.vfClose?.());
        ov.querySelector('[data-confirm-invite]')?.addEventListener('click', async () => {
          ov.querySelector('.vf-modal').innerHTML = `
            <div style="display:grid;place-items:center;gap:12px;padding:18px 8px">
              <div style="width:72px;height:72px;display:grid;place-items:center;border-radius:50%;background:rgba(255,49,89,.14);border:1px solid rgba(255,49,89,.35);font-size:38px;animation:vfFade .8s ease-in-out infinite alternate">💔</div>
              <b style="font-size:18px">Ожидаем ответ</b>
              <p style="margin:0;color:var(--vf-muted);font-size:13px;line-height:1.4">Приглашение для ${esc(name)} отправляется. Если игрок не в сети, он получит push-вызов при следующей активности.</p>
              <div class="vf-actions" style="width:100%">
                <button class="vf-btn vf-sec" data-wait-cancel>Отменить</button>
                <button class="vf-btn vf-sec" data-wait-extend>Продлить ожидание</button>
              </div>
            </div>
          `;

          ov.querySelector('[data-wait-cancel]')?.addEventListener('click', () => ov.vfClose?.());
          ov.querySelector('[data-wait-extend]')?.addEventListener('click', () => toast('Ожидание продлено'));

          if (typeof onGameInvite === 'function') {
            await onGameInvite({ friendId, gameId });
          } else {
            toast('Игровое приглашение появится в Фазе C');
          }
        });
      });
    });

    ov.querySelector('[data-a="chat"]')?.addEventListener('click', () => {
      ov.vfClose?.();
      void openChat(friendId);
    });
    ov.querySelector('[data-a="push"]')?.addEventListener('click', async () => {
      ov.vfClose?.();
      try {
        await core.sendPush({ toFriendId: friendId, kind: 'GENERIC' });
        toast('Приглашение отправлено');
      } catch (err) {
        toast(`Ошибка: ${err.message}`);
      }
    });
    ov.querySelector('[data-a="voice"]')?.addEventListener('click', async () => {
      ov.vfClose?.();
      const ok = await openVoiceCall(friendId);
      if (!ok) toast('Звонок уже принят на другом устройстве или сервис перегружен');
    });

    ov.querySelector('[data-a="remove"]')?.addEventListener('click', async () => {
      ov.vfClose?.();
      try { await core.removeFriend(friendId); toast('Друг удалён'); refresh({ force: true }); }
      catch (err) { toast(`Ошибка: ${err.message}`); }
    });
  };

  const openChatModal = (friendId, name = 'Друг') => {
    let lastAt = 0;
    let timer = 0;
    const seen = new Set();
    const rowsByMsgId = new Map();

    const ov = openModal(`
      <div class="vf-modal-head vf-chat-head">
        <button class="vf-btn vf-sec vf-chat-gear" type="button" id="vf-chat-settings" title="Настройки">⚙</button>
        <b>Чат с ${esc(name)}</b>
        <button class="vf-btn vf-sec vf-chat-close" type="button" id="vf-chat-close" title="Закрыть">✕</button>
      </div>
      <div class="vf-chat-settings-panel" hidden>
        <button class="vf-btn vf-danger" type="button" id="vf-chat-clear">Очистить чат</button>
      </div>
      <div class="vf-chat-log" aria-live="polite"></div>
      <form class="vf-chat-form">
        <input type="text" maxlength="500" placeholder="Сообщение..." autocomplete="off">
        <button class="vf-btn" type="submit">▶</button>
      </form>
    `);

    ov.querySelector('.vf-modal')?.classList.add('vf-chat-modal');

    const log = ov.querySelector('.vf-chat-log');
    const input = ov.querySelector('input');
    const panel = ov.querySelector('.vf-chat-settings-panel');

    const updateStatuses = msg => {
      if (!msg.msgId) return false;
      const row = rowsByMsgId.get(msg.msgId);
      const box = row?.querySelector?.('.vf-chat-statuses');
      if (!box) return false;
      box.innerHTML = `
        <div>Отправлено: ${fmtStatusTime(msg.createdAt)}</div>
        <div>Доставлено: ${fmtStatusTime(msg.deliveredAt)}</div>
        <div>Прочитано: ${fmtStatusTime(msg.readAt)}</div>
      `;
      return true;
    };

    const append = msg => {
      const key = msg.msgId || `${msg.fromFriendId}:${msg.createdAt}:${msg.text}`;
      if (seen.has(key)) {
        updateStatuses(msg);
        return;
      }
      seen.add(key);

      const mine = msg.fromFriendId === core.identity?.friendId;
      const row = document.createElement('div');
      row.className = `vf-chat-msg ${mine ? 'is-mine' : 'is-friend'}`;
      row.innerHTML = mine ? `
        <div class="vf-chat-bubble">${esc(msg.text || '')}</div>
        <div class="vf-chat-statuses">
          <div>Отправлено: ${fmtStatusTime(msg.createdAt)}</div>
          <div>Доставлено: ${fmtStatusTime(msg.deliveredAt)}</div>
          <div>Прочитано: ${fmtStatusTime(msg.readAt)}</div>
        </div>
      ` : `
        <div class="vf-chat-bubble">${esc(msg.text || '')}</div>
        <div class="vf-chat-time">${fmtChatTime(msg.createdAt)}</div>
      `;
      if (msg.msgId) rowsByMsgId.set(msg.msgId, row);
      log.append(row);
      log.scrollTop = log.scrollHeight;
    };

    const load = async () => {
      if (document.hidden) return;
      try {
        const items = await core.getChatMessages({ friendId, after: lastAt });
        items.forEach(msg => {
          lastAt = Math.max(lastAt, Number(msg.createdAt || 0), Number(msg.updatedAt || 0));
          append(msg);
        });
      } catch {}
    };

    const close = () => {
      clearInterval(timer);
      ov.vfClose?.();
    };

    ov.querySelector('#vf-chat-close').onclick = close;
    ov.querySelector('#vf-chat-settings').onclick = () => {
      panel.hidden = !panel.hidden;
    };

    ov.querySelector('#vf-chat-clear').onclick = async () => {
      if (!confirm('Очистить историю этого чата?')) return;
      try {
        await core.clearChat(friendId);
        lastAt = Date.now();
        seen.clear();
        log.innerHTML = '';
        panel.hidden = true;
        toast('Чат очищен');
      } catch (err) {
        toast(`Ошибка очистки: ${err.message}`);
      }
    };

    ov.querySelector('.vf-chat-form').onsubmit = async e => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        const res = await core.sendChatMessage({ toFriendId: friendId, text });
        const createdAt = res.createdAt || Date.now();
        lastAt = Math.max(lastAt, Number(createdAt || 0));
        append({
          msgId: res.msgId || `local-${createdAt}`,
          fromFriendId: core.identity?.friendId,
          text,
          createdAt,
          deliveredAt: res?.webPush?.sent > 0 ? createdAt : 0,
          readAt: 0
        });
        toast('Сообщение отправлено');
      } catch (err) {
        toast(`Ошибка отправки: ${err.message}`);
      }
    };

    const cleanup = () => {
      clearInterval(timer);
      observer.disconnect();
    };

    const observer = new MutationObserver(() => {
      if (!document.body.contains(ov)) cleanup();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    load();
    timer = setInterval(load, 3500);
    setTimeout(() => input.focus?.(), 80);
    return true;
  };

  const openVoiceCallModal = (friendId, name = 'Друг', incoming = null) => {
    let pc = null;
    let localStream = null;
    let roomId = incoming?.roomId || '';
    let roomSecret = incoming?.roomSecret || incoming?.key || '';
    let callId = incoming?.callId || '';
    let myPeerId = `${core.identity?.friendId}:voice:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    let remotePeerId = '';
    let pollTimer = 0;
    let roomTimer = 0;
    let tickTimer = 0;
    let startedAt = 0;
    let muted = false;
    let closed = false;
    let signalFails = 0;
    let roomFails = 0;
    let pollBusy = false;
    let roomBusy = false;
    let cleanupObserver = null;

    const ov = openModal(`
      <div class="vf-modal-head vf-chat-head">
        <button class="vf-btn vf-sec vf-chat-gear" type="button" id="vf-voice-info" title="Информация">ⓘ</button>
        <b>Звонок · ${esc(name)}</b>
        <button class="vf-btn vf-sec vf-chat-close" type="button" id="vf-voice-close" title="Закрыть">✕</button>
      </div>
      <div class="vf-voice-log" aria-live="polite"></div>
      <div class="vf-voice-state">
        <div class="vf-voice-icon">🎙</div>
        <b id="vf-voice-status">${incoming ? 'Входящий звонок' : 'Готов к звонку'}</b>
        <small id="vf-voice-detail">${incoming ? 'Нажмите «Ответить», чтобы подключить микрофон.' : 'Нажмите «Позвонить», чтобы отправить вызов.'}</small>
        <div class="vf-voice-timer" id="vf-voice-timer">00:00</div>
      </div>
      <audio id="vf-voice-audio" autoplay playsinline></audio>
      <div class="vf-voice-actions">
        <button class="vf-btn vf-danger" type="button" id="vf-voice-cancel">Отмена</button>
        <button class="vf-btn vf-sec" type="button" id="vf-voice-mute">🎙</button>
        <button class="vf-btn" type="button" id="vf-voice-call">${incoming ? 'Ответить' : 'Позвонить'}</button>
      </div>
    `);

    ov.querySelector('.vf-modal')?.classList.add('vf-chat-modal', 'vf-voice-modal');

    const log = ov.querySelector('.vf-voice-log');
    const statusEl = ov.querySelector('#vf-voice-status');
    const detailEl = ov.querySelector('#vf-voice-detail');
    const timerEl = ov.querySelector('#vf-voice-timer');
    const audioEl = ov.querySelector('#vf-voice-audio');
    const callBtn = ov.querySelector('#vf-voice-call');
    const muteBtn = ov.querySelector('#vf-voice-mute');

    const setState = (title, detail = '') => {
      statusEl.textContent = title;
      detailEl.textContent = detail;
      const row = document.createElement('div');
      row.className = 'vf-voice-row';
      row.innerHTML = `<b>${esc(title)}</b><small>${esc(detail)}</small><i>${fmtChatTime(Date.now())}</i>`;
      log.append(row);
      log.scrollTop = log.scrollHeight;
    };

    const renderHistory = async () => {
      try {
        const items = await core.getVoiceHistory(friendId);
        if (!items.length) return;
        items.forEach(x => {
          const mine = x.fromPlayerId === core.identity?.friendId;
          const row = document.createElement('div');
          row.className = 'vf-voice-row is-history';
          row.innerHTML = `<b>${mine ? 'Исходящий' : 'Входящий'} · ${esc(x.status || 'звонок')}</b><small>${Number(x.durationSec || 0) ? `${Math.round(x.durationSec)} сек.` : 'без разговора'}</small><i>${fmtChatTime(x.createdAt)}</i>`;
          log.append(row);
        });
      } catch {}
    };

    const fmtTimer = sec => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

    const startTimer = () => {
      startedAt = startedAt || Date.now();
      clearInterval(tickTimer);
      tickTimer = setInterval(() => {
        timerEl.textContent = fmtTimer(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
      }, 1000);
    };

    const sendSignal = async (type, data) => {
      if (!roomId || !roomSecret || !remotePeerId || closed) return null;
      try {
        return await core.sendVoiceSignal({ roomId, roomSecret, fromPeerId: myPeerId, toPeerId: remotePeerId, type, data });
      } catch (err) {
        signalFails++;
        if (signalFails >= 4) setState('Ошибка сигналинга', 'Не удаётся обменяться WebRTC-данными. Попробуйте перезвонить.');
        return null;
      }
    };

    const createPeer = async () => {
      if (pc) return pc;
      setState('Запрашиваем микрофон', 'Браузер может показать системное окно разрешения.');
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });

      const cfg = await core.getRtcConfig().catch(() => ({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }));
      pc = new RTCPeerConnection({ iceServers: cfg.iceServers || [] });

      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
      pc.ontrack = e => {
        audioEl.srcObject = e.streams[0];
        audioEl.play?.().catch(() => null);
        setState('Голос подключён', 'Вы слышите собеседника. Таймер разговора запущен.');
        startTimer();
      };
      pc.onicecandidate = e => {
        if (e.candidate) sendSignal('candidate', e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
      };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connecting') setState('Соединяем голосовой канал', 'Проверяем прямой маршрут/STUN/TURN.');
        if (s === 'connected') {
          setState('Соединение установлено', 'Голосовой канал активен.');
          startTimer();
        }
        if (s === 'failed') setState('Соединение не удалось', 'Попробуйте ещё раз. Для мобильных сетей нужен TURN.');
        if (s === 'disconnected') setState('Связь временно прервалась', 'Ожидаем восстановление WebRTC.');
      };

      return pc;
    };

    const pollSignals = () => {
      clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        if (closed || document.hidden || !roomId || !roomSecret || pollBusy) return;
        pollBusy = true;

        try {
          const items = await core.pollVoiceSignals({ roomId, roomSecret, peerId: myPeerId });
          signalFails = 0;

          for (const msg of items) {
            try {
              if (!pc && ['offer', 'answer', 'candidate'].includes(msg.type)) await createPeer();
              if (msg.fromPeerId) remotePeerId = msg.fromPeerId;

              if (msg.type === 'offer') {
                setState('Получено предложение соединения', 'Готовим ответ собеседнику.');
                await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                await sendSignal('answer', pc.localDescription);
              }

              if (msg.type === 'answer') {
                setState('Собеседник ответил', 'Завершаем установку WebRTC.');
                await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
              }

              if (msg.type === 'candidate' && pc?.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(msg.data)).catch(() => null);
              }

              if (msg.type === 'bye') {
                setState('Собеседник завершил звонок', 'Соединение закрыто.');
                await finish('ended_by_friend', false);
              }
            } catch {
              signalFails++;
              setState('Ошибка WebRTC-сигнала', 'Получен некорректный сигнал. Пробуем продолжить.');
            }
          }
        } catch (err) {
          signalFails++;
          if (signalFails === 2) setState('Сигналинг нестабилен', 'Пробуем восстановить обмен данными...');
          if (signalFails >= 8) {
            clearInterval(pollTimer);
            setState('Сигналинг недоступен', 'Звонок не может продолжиться. Закройте окно и попробуйте снова.');
          }
        } finally {
          pollBusy = false;
        }
      }, 2200);
    };

    const waitAnswerAndOffer = () => {
      clearInterval(roomTimer);
      roomTimer = setInterval(async () => {
        if (closed || document.hidden || !roomId || !roomSecret || roomBusy) return;
        roomBusy = true;

        try {
          const res = await core.getRoom(roomId);
          const room = res?.room || null;
          roomFails = 0;

          if (!room?.guestPeerId || room.status === 'waiting') return;

          clearInterval(roomTimer);
          remotePeerId = room.guestPeerId;
          setState('Друг ответил', 'Создаём защищённое голосовое соединение.');

          try {
            await createPeer();
            const offer = await pc.createOffer({ offerToReceiveAudio: true });
            await pc.setLocalDescription(offer);
            await sendSignal('offer', pc.localDescription);
          } catch {
            setState('Не удалось создать звонок', 'Проверьте разрешение микрофона и попробуйте снова.');
          }
        } catch (err) {
          roomFails++;
          if (roomFails === 2) setState('Ожидаем комнату', 'Сервер временно не отвечает, продолжаем ожидание...');
          if (roomFails >= 8) {
            clearInterval(roomTimer);
            setState('Комната звонка недоступна', 'Попробуйте завершить звонок и позвонить снова.');
          }
        } finally {
          roomBusy = false;
        }
      }, 2400);
    };

    const startOutgoing = async () => {
      callBtn.disabled = true;
      setState('Создаём звонок', 'Готовим комнату и отправляем push-вызов другу.');
      try {
        const res = await core.createVoiceCall({ toFriendId: friendId, peerId: myPeerId });
        callId = res.callId;
        roomId = res.roomId;
        roomSecret = res.roomSecret;
        remotePeerId = res.guestPeerId || '';
        setState('Ожидаем ответа', 'Другу отправлен входящий звонок. Если приложение закрыто — придёт системное уведомление.');
        pollSignals();
        waitAnswerAndOffer();
      } catch (err) {
        callBtn.disabled = false;
        setState(
          'Звонок не создан',
          /RESOURCE_EXHAUSTED|resource_exhausted/i.test(String(err?.message || ''))
            ? 'Сервис временно перегружен. Попробуйте еще раз через несколько секунд.'
            : 'Не удалось создать комнату.'
        );
      }
    };

    const answerIncoming = async () => {
      callBtn.disabled = true;
      setState('Отвечаем на звонок', 'Подключаем микрофон и присоединяемся к комнате.');
      try {
        const res = await core.joinVoiceCall({ friendId, callId, roomId, roomSecret, peerId: myPeerId });
        remotePeerId = res.hostPeerId;
        await createPeer();
        pollSignals();
        setState('Ожидаем голосовой канал', 'Ждём WebRTC offer от звонящего.');
      } catch (err) {
        setState(
          'Звонок уже принят',
          /room_busy|room_already_has_guest|voice_busy/i.test(String(err?.message || ''))
            ? 'Этот вызов уже принят на другом устройстве.'
            : 'Не удалось ответить на звонок.'
        );
        setTimeout(() => ov.vfClose?.(), 1200);
      }
    };

    const cleanupVoice = () => {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      clearInterval(roomTimer);
      clearInterval(tickTimer);
      try { cleanupObserver?.disconnect?.(); } catch {}
      try { pc?.close?.(); } catch {}
      try { localStream?.getTracks?.().forEach(t => t.stop()); } catch {}
      pc = null;
      localStream = null;
    };

    const finish = async (status = 'ended', ask = true) => {
      if (ask && !confirm('Завершить звонок?')) return;
      await sendSignal('bye', { at: Date.now() });
      const durationSec = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
      cleanupVoice();
      await core.endVoiceCall({ friendId, callId, roomId, status, durationSec }).catch(() => null);
      ov.vfClose?.();
    };

    cleanupObserver = new MutationObserver(() => {
      if (!document.body.contains(ov)) cleanupVoice();
    });
    cleanupObserver.observe(document.body, { childList: true, subtree: true });

    ov.querySelector('#vf-voice-close').onclick = () => finish('closed', true);
    ov.querySelector('#vf-voice-cancel').onclick = () => finish('cancelled', true);
    ov.querySelector('#vf-voice-info').onclick = () => toast('Для стабильной связи в мобильных сетях нужен TURN-сервер');
    callBtn.onclick = () => incoming ? answerIncoming() : startOutgoing();
    muteBtn.onclick = () => {
      muted = !muted;
      localStream?.getAudioTracks?.().forEach(t => { t.enabled = !muted; });
      muteBtn.textContent = muted ? '🔇' : '🎙';
      setState(muted ? 'Микрофон выключен' : 'Микрофон включён', muted ? 'Собеседник вас не слышит.' : 'Собеседник снова вас слышит.');
    };

    renderHistory();
    onVoiceOpened?.(friendId);
    return true;
  };

  const openVoiceCall = async (friendId, incoming = null) => {
    if (!friendId) return false;
    let name = 'Друг';
    try {
      const p = await core.getProfile(friendId);
      if (p?.displayName) name = p.displayName;
    } catch {}
    return openVoiceCallModal(friendId, name, incoming);
  };

  const openAddModal = async () => {
    const ov = openModal(`
      <div class="vf-modal-head" style="justify-content:space-between">
        <b>Добавить друга</b>
        <button class="vf-btn vf-sec" id="vf-add-close" style="min-height:30px;padding:0 10px;font-size:16px;box-shadow:none">✕</button>
      </div>
      <div class="vf-add-body"><p>Создаём приглашение...</p></div>
    `);
    ov.querySelector('#vf-add-close').onclick = () => ov.vfClose?.();

    try {
      const invite = await core.createInvite();
      const url = invite.url;
      ov.querySelector('.vf-add-body').innerHTML = `
        <p class="vf-code">Код: <b>${esc(invite.code)}</b></p>
        <p class="vf-link">${esc(url)}</p>
        <div class="vf-add-actions">
          <button class="vf-btn" data-x="copy">Скопировать ссылку</button>
          <button class="vf-btn vf-sec" data-x="share">Поделиться</button>
          <button class="vf-btn vf-sec" data-x="mail">Почта</button>
          <button class="vf-btn vf-sec" data-x="qr">QR-код</button>
          <button class="vf-btn vf-sec" data-x="nearby">Друг рядом</button>
        </div>
        <div class="vf-qr" hidden></div>
        <div style="text-align:left;background:rgba(0,0,0,0.2);padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,0.05);margin-top:12px;">
          <div style="font-size:12px;color:var(--vf-muted);margin-bottom:8px;">Или вставь присланную тебе ссылку:</div>
          <div style="display:flex;gap:8px;">
            <input type="text" id="vf-manual-link" placeholder="Вставь ссылку сюда" autocomplete="off" style="flex:1;min-width:0;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:10px;padding:8px 12px;font-size:14px;outline:none;">
            <button class="vf-btn" id="vf-manual-submit" style="min-height:36px;padding:0 12px;box-shadow:none">ОК</button>
          </div>
        </div>
      `;
      
      ov.querySelector('[data-x="copy"]')?.addEventListener('click', () => { navigator.clipboard?.writeText?.(url); toast('Ссылка скопирована'); });
      ov.querySelector('[data-x="share"]')?.addEventListener('click', () => {
        if (navigator.share) navigator.share({ title: 'Витрина · Друзья', text: 'Добавь меня в друзья', url }).catch(() => {});
        else { navigator.clipboard?.writeText?.(url); toast('Ссылка скопирована'); }
      });
      ov.querySelector('[data-x="mail"]')?.addEventListener('click', () => {
        location.href = `mailto:?subject=${encodeURIComponent('Добавь меня в друзья')}&body=${encodeURIComponent(url)}`;
      });
      ov.querySelector('[data-x="qr"]')?.addEventListener('click', () => {
        const box = ov.querySelector('.vf-qr');
        box.hidden = false;
        box.innerHTML = `<img alt="QR" src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}">`;
      });

      ov.querySelector('[data-x="nearby"]')?.addEventListener('click', async () => {
        const box = ov.querySelector('.vf-qr');
        box.hidden = false;
        box.innerHTML = `<p>Создаём код для друга рядом...</p>`;
        try {
          const near = await core.createNearbyFriendCode();
          box.innerHTML = `
            <div style="display:grid;gap:10px;text-align:center">
              <p class="vf-code">Код рядом: <b>${esc(near.code)}</b></p>
              <p style="margin:0;color:var(--vf-muted);font-size:12px;line-height:1.35">Попросите друга открыть «Добавить друга» и ввести этот код. Код действует несколько минут.</p>
              <div style="display:flex;gap:8px">
                <input type="text" inputmode="numeric" maxlength="6" id="vf-nearby-code" placeholder="Код друга" style="flex:1;min-width:0;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#fff;border-radius:12px;padding:0 12px;outline:none">
                <button class="vf-btn" id="vf-nearby-join" style="min-height:40px;box-shadow:none">ОК</button>
              </div>
            </div>
          `;
          box.querySelector('#vf-nearby-join')?.addEventListener('click', async () => {
            const code = box.querySelector('#vf-nearby-code')?.value || '';
            if (!code.trim()) return toast('Введите код друга');
            try {
              await core.joinNearbyFriendCode(code);
              toast('Друг добавлен!');
              ov.vfClose?.();
              refresh({ force: true });
            } catch (err) {
              toast('Код не найден или устарел');
            }
          });
        } catch (err) {
          box.innerHTML = `<p>Ошибка: ${esc(err.message)}</p>`;
        }
      });

      ov.querySelector('#vf-manual-submit').onclick = async () => {
        const val = ov.querySelector('#vf-manual-link').value.trim();
        if (!val) return;
        try {
          let addId, addKey;
          if (val.includes('addFriend=')) {
            let u;
            try { u = new URL(val); } catch { u = new URL('https://dummy.com/' + (val.startsWith('?') ? val : '?' + val)); }
            addId = u.searchParams.get('addFriend');
            addKey = u.searchParams.get('key');
          } else {
            return toast('Для добавления нужна полная ссылка. Короткие коды устарели.');
          }

          if (!addId || !addKey) return toast('Неверная ссылка. Скопируйте целиком.');

          ov.vfClose?.();
          toast('Добавляем...');
          await core.acceptInvite({ inviteId: addId, secret: addKey });
          toast('Друг добавлен!');
          refresh({ force: true });
        } catch (err) {
          toast('Ошибка: ' + (err.message === 'self_friend_forbidden' ? 'Нельзя добавить самого себя' : 'Ссылка недействительна'));
        }
      };
    } catch (err) {
      ov.querySelector('.vf-add-body').innerHTML = `<p>Ошибка: ${esc(err.message)}</p>`;
    }
  };

  const openChat = async friendId => {
    if (!friendId) return false;
    let name = 'Друг';
    try {
      const p = await core.getProfile(friendId);
      if (p?.displayName) name = p.displayName;
    } catch {}

    const opened = openChatModal(friendId, name);
    if (opened !== false) onChatOpened?.(friendId);
    return opened !== false;
  };

  return { refresh, openChat, openVoiceCall };
};
