// /Friends/friends-core.js
// Data + identity + network для модуля Друзья. Без DOM.

const SIGNALING_URL = 'https://functions.yandexcloud.net/d4e2epg33mkshjoar6av';

const safe = v => String(v == null ? '' : v).trim();
const jsonParse = raw => { try { return JSON.parse(raw); } catch { return null; } };

const sha256Hex = async text => {
  if (!crypto?.subtle) {
    let h = 0x811c9dc5;
    const s = safe(text);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return `weak${(h >>> 0).toString(16).padStart(8, '0')}`;
  }
  const data = new TextEncoder().encode(safe(text));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
};

export const makeFriendId = async yandexId =>
  yandexId ? `ya_${(await sha256Hex(`friend:${safe(yandexId)}`)).slice(0, 24)}` : '';

export const makeChatRoomId = async (a, b) => {
  const pair = [safe(a), safe(b)].sort().join('|');
  return `c_${(await sha256Hex(`chat:${pair}`)).slice(0, 20)}`;
};

export class FriendsCore {
  constructor({ signalingUrl = SIGNALING_URL } = {}) {
    this.signalingUrl = signalingUrl;
    this.identity = null;
    this._cache = { friends: [], at: 0 };
    this.onError = () => {};
  }

  // identity сверху: { friendId, displayName, avatar, yandexLinked, deviceStableId }
  setIdentity(identity = {}) {
    this.identity = {
      friendId: safe(identity.friendId),
      displayName: safe(identity.displayName || 'Слушатель'),
      avatar: safe(identity.avatar || ''),
      yandexLinked: !!identity.yandexLinked,
      deviceStableId: safe(identity.deviceStableId || '')
    };
    return this.identity;
  }

  // Удобный хелпер: построить identity из сырого yandex-профиля (без токена).
  async setIdentityFromYandex({ yandexId, displayName, avatar } = {}) {
    const friendId = await makeFriendId(yandexId);
    return this.setIdentity({
      friendId,
      displayName,
      avatar,
      yandexLinked: !!yandexId
    });
  }

  isReady() {
    return !!this.identity?.friendId && this.identity.yandexLinked;
  }

  async _req(action, data = {}) {
    if (!this.isReady()) throw new Error('friends_identity_required');

    let res;
    try {
      res = await fetch(this.signalingUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Vi3-Player': this.identity.friendId,
          'X-Vi3-Secret': this.identity.friendId
        },
        credentials: 'omit',
        mode: 'cors',
        body: JSON.stringify({
          action,
          playerId: this.identity.friendId,
          clientSecret: this.identity.friendId,
          displayName: this.identity.displayName,
          avatarUrl: this.identity.avatar,
          ...data
        })
      });
    } catch (err) {
      this.onError(err);
      throw new Error('network_unreachable');
    }

    const json = jsonParse(await res.text()) || {};
    if (!res.ok || json.ok === false) {
      const err = new Error(json.error || json.reason || `http_${res.status}`);
      err.status = res.status;
      this.onError(err);
      throw err;
    }
    return json;
  }

  async register() {
    await this._req('player_register', { displayName: this.identity.displayName });
    await this.syncProfile();
    return true;
  }

  async syncProfile() {
    return this._req('profile_set', {
      displayName: this.identity.displayName,
      avatarUrl: this.identity.avatar
    });
  }

  async getFriendList({ force = false } = {}) {
    if (!force && this._cache.friends.length && Date.now() - this._cache.at < 30000) {
      return this._cache.friends;
    }
    const res = await this._req('friend_list', {});
    const items = Array.isArray(res.items) ? res.items : [];
    this._cache = { friends: items, at: Date.now() };
    return items;
  }

  // Presence только по требованию (батч).
  async getPresence(friendIds = []) {
    const ids = friendIds.map(safe).filter(Boolean).slice(0, 50);
    if (!ids.length) return {};
    const res = await this._req('presence_batch', { friendIds: ids });
    return res.presence || {};
  }

  async removeFriend(friendId) {
    this._cache.at = 0;
    return this._req('friend_remove', { targetId: safe(friendId) });
  }

  async createInvite() {
    const res = await this._req('friend_invite_create', {});
    const url = `${location.origin}/?addFriend=${encodeURIComponent(res.inviteId)}&key=${encodeURIComponent(res.secret)}`;
    return { ...res, url, code: shortCode(res.inviteId) };
  }

  async acceptInvite({ inviteId, secret }) {
    this._cache.at = 0;
    return this._req('friend_invite_accept', { inviteId: safe(inviteId), secret: safe(secret) });
  }

  async getInviteInfo(inviteId, secret) {
    const res = await fetch(this.signalingUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'friend_invite_get', inviteId: safe(inviteId), secret: safe(secret) })
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'invite_not_found');
    return json.invite;
  }

  async sendGameInvite({ toFriendId, gameId, roomId, roomSecret }) {
    return this._req('push_send', {
      toFriendId: safe(toFriendId),
      kind: 'GAME_INVITE',
      gameId: safe(gameId),
      roomId: safe(roomId),
      roomSecret: safe(roomSecret)
    });
  }

  async getPushes() {
    const res = await this._req('push_poll', {});
    return Array.isArray(res.items) ? res.items : [];
  }

  async getProfile(targetId) {
    const res = await this._req('profile_get', { targetId: safe(targetId) });
    return res.profile || null;
  }
}

const shortCode = inviteId => safe(inviteId).replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase();

export default FriendsCore;
