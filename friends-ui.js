// /Friends/friends-ui.js
// UI поверх FriendsCore: список друзей + добавление (ссылка/код/QR/почта).

import { getPlayableGames } from './games-registry.js?v=9.0.6';
import { createFriendsModalAdapter } from './modal-adapter.js?v=9.0.6';
import { openTextChatModal } from './chat-text-ui.js?v=9.0.6';
import { openVoiceCallUi } from './voice-call-ui.js?v=9.0.6';

const esc = v => String(v || '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
})[c]);

const renderFeatureCards = () => `
  <div class="friends-feature-grid">
    <div class="friends-feature-card">
      <span>💬</span>
      <div>
        <b>Личные сообщения</b>
        <small>Защищённые чаты, ответы, реакции и отметки доставки.</small>
      </div>
    </div>
    <div class="friends-feature-card">
      <span>📞</span>
      <div>
        <b>Голосовые звонки</b>
        <small>Прямое WebRTC-соединение там, где сеть разрешает маршрут без TURN.</small>
      </div>
    </div>
    <div class="friends-feature-card">
      <span>🔔</span>
      <div>
        <b>Push-уведомления</b>
        <small>Сообщения, звонки и приглашения не потеряются.</small>
      </div>
    </div>
    <div class="friends-feature-card">
      <span>🎮</span>
      <div>
        <b>Игровые приглашения</b>
        <small>Приглашайте друзей в «Войну Сердец».</small>
      </div>
    </div>
    <div class="friends-feature-card">
      <span>🔗</span>
      <div>
        <b>Добавление по ссылке</b>
        <small>Отправьте защищённое приглашение через мессенджер или почту.</small>
      </div>
    </div>
    <div class="friends-feature-card">
      <span>📍</span>
      <div>
        <b>Друг рядом</b>
        <small>Добавляйте знакомых коротким временным кодом.</small>
      </div>
    </div>
  </div>
`;

const renderFriendsGuide = webPushEnabled => `
  <section class="friends-authorized-guide">
    <div class="friends-guide-head">
      <div>
        <span>👋 Вы в разделе друзей</span>
        <small>Добавьте знакомого и начните общение.</small>
      </div>
      <span class="friends-guide-status">онлайн</span>
    </div>

    <div class="friends-guide-actions">
      <button type="button" data-act="add">
        ＋ Добавить друга
      </button>
      <button
        type="button"
        data-act="notify"
        class="${webPushEnabled ? 'is-enabled' : ''}"
      >
        ${webPushEnabled ? '🔔 Уведомления' : '🔕 Уведомления'}
      </button>
      <button type="button" data-act="refresh">
        ↻ Обновить
      </button>
    </div>

    <details class="friends-guide-details">
      <summary>✨ Что здесь можно делать</summary>
      ${renderFeatureCards()}
    </details>

    <div class="friends-guide-tip">
      💡 Нажмите на друга, чтобы открыть чат, позвонить или пригласить его в игру.
    </div>
  </section>
`;
export const mountFriendsUI = (root, core, { onGameInvite = null, onEnableWebPush = null, getUnread = null, getWebPushEnabled = null, onUnreadClick = null, onChatOpened = null, onVoiceOpened = null } = {}) => {
  if (!root) return null;

  const el = document.createElement('section');
  el.className = 'vf-wrap';
  root.append(el);
  let activeChatApi = null;

  const toast = text => {
    let t = el.querySelector('.vf-toast');
    if (!t) { t = document.createElement('div'); t.className = 'vf-toast'; el.append(t); }
    t.textContent = text;
    t.classList.add('is-show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('is-show'), 1600);
  };

  const renderList = (friends = [], presence = {}) => {
    const webPushEnabled =
      typeof getWebPushEnabled === 'function' &&
      getWebPushEnabled();

    return `
      ${renderFriendsGuide(webPushEnabled)}
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
          <small>Добавь друга по защищённой ссылке или временному коду.</small>
        </div>
      `}
      </div>
    `;
  };

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
    el.querySelector('[data-act="add"]')
      ?.addEventListener('click', openAddModal);

    el.querySelector('[data-act="refresh"]')
      ?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = '↻ Обновляем...';

        try {
          await refresh({ force: true });
          toast('Список друзей обновлён');
        } catch {
          toast('Не удалось обновить список');
        }
      });

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

  const openModal = (html, { closeOnBackdrop = true } = {}) => {
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

    if (closeOnBackdrop) {
      ov.addEventListener('click', event => {
        if (event.target === ov) close();
      });
    }

    return ov;
  };

  const modal = createFriendsModalAdapter({
    openModal
  });

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

  const openChatModal = (friendId, name = 'Друг') => openTextChatModal({
    friendId,
    name,
    core,
    openModal,
    toast,
    confirmAction: modal.confirm,
    onActiveChatChange: api => {
      activeChatApi = api;
    }
  });

  const openVoiceCallModal = (
    friendId,
    name = 'Друг',
    incoming = null
  ) => openVoiceCallUi({
    friendId,
    name,
    incoming,
    core,
    openModal,
    toast,
    confirmAction: modal.confirm,
    onVoiceOpened
  });

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
          <button class="vf-btn vf-sec" data-x="nearby">Друг рядом</button>
        </div>
        <div class="vf-nearby-box" hidden></div>
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

      ov.querySelector('[data-x="nearby"]')?.addEventListener('click', async () => {
        const box = ov.querySelector('.vf-nearby-box');
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
  const pushIncomingChat = push => {
    if (!push || activeChatApi?.friendId !== push.fromFriendId) return false;
    return activeChatApi.pushIncomingMessage?.(push) || false;
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

  return {
    refresh,
    openChat,
    openVoiceCall,
    getActiveChatFriendId: () => activeChatApi?.friendId || '',
    pushIncomingChat
  };
};
