// /Friends/friends-ui.js
// UI поверх FriendsCore: список друзей + добавление (ссылка/код/QR/почта).

import { getPlayableGames } from './games-registry.js';

const esc = v => String(v || '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
})[c]);

export const mountFriendsUI = (root, core, { onGameInvite = null } = {}) => {
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
      <button class="vf-btn vf-btn-add" type="button" data-act="add">＋ Добавить</button>
    </div>
    <div class="vf-list">
      ${friends.length ? friends.map(f => {
        const fid = f.friendId;
        const name = f.profile?.displayName || 'Друг';
        const avatar = f.profile?.avatarUrl;
        const online = !!presence[fid]?.online;
        return `
          <button class="vf-friend" type="button" data-friend="${esc(fid)}">
            <span class="vf-ava">${avatar ? `<img src="${esc(avatar)}" alt="">` : '👤'}</span>
            <b>${esc(name)}</b>
            <small class="${online ? 'is-online' : ''}">${online ? 'онлайн' : 'не в сети'}</small>
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
    el.querySelectorAll('[data-friend]').forEach(btn => {
      btn.addEventListener('click', () => openFriendActions(btn.dataset.friend, btn.querySelector('b')?.textContent || 'Друг'));
    });
  };

  const openModal = html => {
    const ov = document.createElement('div');
    ov.className = 'vf-modal-ov';
    ov.innerHTML = `<div class="vf-modal">${html}</div>`;
    el.append(ov);
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    return ov;
  };

  const openFriendActions = (friendId, name) => {
    const games = getPlayableGames();
    const ov = openModal(`
      <div class="vf-modal-head"><span class="vf-ava">👤</span><b>${esc(name)}</b></div>
      <div class="vf-actions">
        <button class="vf-btn" data-a="invite">▶ Пригласить в игру</button>
        <button class="vf-btn vf-sec" data-a="chat">💬 Написать в чат</button>
        <button class="vf-btn vf-sec" data-a="push">🔔 Отправить пуш</button>
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
        ov.remove();
        if (typeof onGameInvite === 'function') {
          onGameInvite({ friendId, gameId: b.dataset.game });
        } else {
          toast('Игровое приглашение появится в Фазе C');
        }
      });
    });

    ov.querySelector('[data-a="chat"]')?.addEventListener('click', () => {
      ov.remove();
      openChatModal(friendId, name);
    });
    ov.querySelector('[data-a="push"]')?.addEventListener('click', async () => {
      ov.remove();
      try {
        await core._req('push_send', { toFriendId: friendId, kind: 'GENERIC', text: '👋 Привет из Витрины!' });
        toast('Пуш отправлен');
      } catch (err) {
        toast(`Ошибка: ${err.message}`);
      }
    });
    ov.querySelector('[data-a="voice"]')?.addEventListener('click', () => {
      ov.remove();
      toast('Голос работает внутри сетевого боя после P2P-подключения');
    });

    ov.querySelector('[data-a="remove"]')?.addEventListener('click', async () => {
      ov.remove();
      try { await core.removeFriend(friendId); toast('Друг удалён'); refresh({ force: true }); }
      catch (err) { toast(`Ошибка: ${err.message}`); }
    });
  };

  const openChatModal = friendId => {
    let lastAt = 0;
    let timer = 0;

    const ov = openModal(`
      <div class="vf-modal-head" style="justify-content:space-between">
        <b>Чат</b>
        <button class="vf-btn vf-sec" id="vf-chat-close" style="min-height:30px;padding:0 10px;font-size:16px;box-shadow:none">✕</button>
      </div>
      <div class="vf-chat-log" style="min-height:180px;max-height:260px;overflow:auto;display:grid;gap:6px;text-align:left;margin-bottom:10px;padding:10px;border-radius:14px;background:rgba(0,0,0,.2);border:1px solid rgba(255,255,255,.08)"></div>
      <form class="vf-chat-form" style="display:grid;grid-template-columns:1fr auto;gap:8px">
        <input type="text" maxlength="500" placeholder="Сообщение..." autocomplete="off" style="min-width:0;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#fff;border-radius:12px;padding:0 12px;outline:none">
        <button class="vf-btn" type="submit" style="min-height:40px;box-shadow:none">▶</button>
      </form>
    `);

    const log = ov.querySelector('.vf-chat-log');
    const input = ov.querySelector('input');

    const append = msg => {
      const mine = msg.fromFriendId === core.identity?.friendId;
      const row = document.createElement('div');
      row.style.cssText = `justify-self:${mine ? 'end' : 'start'};max-width:86%;padding:8px 10px;border-radius:12px;background:${mine ? 'linear-gradient(135deg,var(--vf-red),#8b5cff)' : 'rgba(255,255,255,.08)'};font-size:13px;line-height:1.3;color:#fff`;
      row.textContent = msg.text || '';
      log.append(row);
      log.scrollTop = log.scrollHeight;
    };

    const load = async () => {
      if (document.hidden) return;
      try {
        const items = await core.getChatMessages({ friendId, after: lastAt });
        items.forEach(msg => {
          lastAt = Math.max(lastAt, Number(msg.createdAt || 0));
          append(msg);
        });
      } catch {}
    };

    ov.querySelector('#vf-chat-close').onclick = () => {
      clearInterval(timer);
      ov.remove();
    };

    ov.querySelector('.vf-chat-form').onsubmit = async e => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        const res = await core.sendChatMessage({ toFriendId: friendId, text });
        append({ fromFriendId: core.identity?.friendId, text, createdAt: res.createdAt || Date.now() });
      } catch (err) {
        toast(`Ошибка: ${err.message}`);
      }
    };

    load();
    timer = setInterval(load, 3500);
    ov.addEventListener('remove', () => clearInterval(timer));
  };

  const openAddModal = async () => {
    const ov = openModal(`
      <div class="vf-modal-head" style="justify-content:space-between">
        <b>Добавить друга</b>
        <button class="vf-btn vf-sec" id="vf-add-close" style="min-height:30px;padding:0 10px;font-size:16px;box-shadow:none">✕</button>
      </div>
      <div class="vf-add-body"><p>Создаём приглашение...</p></div>
    `);
    ov.querySelector('#vf-add-close').onclick = () => ov.remove();

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

          ov.remove();
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

  return { refresh };
};
