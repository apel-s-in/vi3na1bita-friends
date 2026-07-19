// /Friends/friends-core.js
// Data + identity + network для модуля Друзья. Без DOM.

import { FriendsCrypto } from './friends-crypto.js?v=8.8.6';

const SIGNALING_URL = 'https://functions.yandexcloud.net/d4e2epg33mkshjoar6av';
export const CHAT_E2EE_V2 = true;

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
    this.chatE2eeV2 = CHAT_E2EE_V2;
    this.crypto = new FriendsCrypto({
      request: (action, data) => this._req(action, data)
    });
  }

  // Identity приходит только от основного приложения.
  setIdentity(identity = {}) {
    this.identity = {
      friendId: safe(identity.friendId),
      displayName: safe(identity.displayName || 'Слушатель'),
      avatar: safe(identity.avatar || ''),
      yandexLinked: !!identity.yandexLinked,
      deviceStableId: safe(identity.deviceStableId || ''),
      socialSession: safe(identity.socialSession || ''),
      sessionExpiresAt: Number(identity.sessionExpiresAt || 0)
    };

    this.crypto.setIdentity(this.identity);
    return this.identity;
  }

  isReady() {
    return !!(
      this.identity?.friendId &&
      this.identity?.yandexLinked &&
      this.identity?.socialSession &&
      Number(this.identity?.sessionExpiresAt || 0) > Date.now()
    );
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
          'X-Vi3-Session': this.identity.socialSession
        },
        credentials: 'omit',
        mode: 'cors',
        body: JSON.stringify({
          action,
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
      const err = new Error(`${action}: ${json.error || json.reason || `http_${res.status}`}`);
      err.status = res.status;
      err.action = action;
      this.onError(err);
      throw err;
    }
    return json;
  }

  async register() {
    await this._req('player_register', {
      displayName: this.identity.displayName
    });
    await this.syncProfile();

    if (this.chatE2eeV2) {
      await this.crypto.ensureDevice();
    }

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
  async heartbeat({ gameId = '', roomId = '' } = {}) {
    return this._req('presence_heartbeat', {
      deviceId: this.identity.deviceStableId || 'web',
      gameId: safe(gameId),
      roomId: safe(roomId)
    });
  }

  async getPresence(friendIds = []) {
    const ids = friendIds.map(safe).filter(Boolean).slice(0, 50);
    if (!ids.length) return {};
    const res = await this._req('presence_batch', { friendIds: ids });
    return res.presence || {};
  }

  async sendChatMessage({
    toFriendId,
    text,
    replyToMsgId = '',
    replyText = '',
    clientMsgId = ''
  }) {
    if (!this.chatE2eeV2) {
      throw new Error('chat_e2ee_required');
    }

    const cryptoPack = await this.crypto.encryptPayload({
      friendId: toFriendId,
      clientMsgId,
      kind: 'message',
      payload: {
        type: 'message',
        text: safe(text).slice(0, 1000),
        replyToMsgId: safe(replyToMsgId),
        replyText: safe(replyText).slice(0, 160),
        reactions: {}
      }
    });

    return this._req('chat_send_v2', {
      toFriendId: safe(toFriendId),
      clientMsgId: cryptoPack.clientMsgId,
      crypto: cryptoPack
    });
  }

  async reactChatMessage({
    friendId,
    msgId,
    emoji,
    message = null
  }) {
    if (Number(message?.cryptoVersion || 0) !== 2) {
      throw new Error('chat_e2ee_message_required');
    }

    let current = message;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (current.decryptFailed || current.deletedAt) {
        throw new Error('chat_message_not_editable');
      }

      const reactions = {
        ...(current.reactions || {})
      };
      const me = this.identity.friendId;
      const value = safe(emoji).slice(0, 8);

      let mine = Array.isArray(reactions[me])
        ? [...reactions[me]]
        : (reactions[me] ? [reactions[me]] : []);

      mine = mine.includes(value)
        ? mine.filter(item => item !== value)
        : [...mine, value].slice(-3);

      if (mine.length) reactions[me] = mine;
      else delete reactions[me];

      const cryptoPack = await this.crypto.encryptPayload({
        friendId,
        kind: 'reaction',
        subjectMsgId: msgId,
        payload: {
          type: 'message',
          text: safe(current.text).slice(0, 1000),
          replyToMsgId: safe(current.replyToMsgId),
          replyText: safe(current.replyText).slice(0, 160),
          reactions
        }
      });

      try {
        const result = await this._req('chat_update_v2', {
          friendId: safe(friendId),
          msgId: safe(msgId),
          expectedRevision: Number(current.revision || 1),
          crypto: cryptoPack
        });

        return {
          ...result,
          reactions
        };
      } catch (error) {
        if (
          !String(error?.message || '').includes('chat_revision_conflict') ||
          attempt >= 2
        ) {
          throw error;
        }

        current = await this.getChatMessage({
          friendId,
          msgId
        });

        if (!current) throw new Error('chat_message_not_found');
      }
    }

    throw new Error('chat_revision_conflict');
  }) {
    if (Number(message?.cryptoVersion || 0) !== 2) {
      throw new Error('chat_e2ee_message_required');
    }

    if (message.decryptFailed || message.deletedAt) {
      throw new Error('chat_message_not_editable');
    }

    const reactions = {
      ...(message.reactions || {})
    };
    const me = this.identity.friendId;
    const value = safe(emoji).slice(0, 8);

    let mine = Array.isArray(reactions[me])
      ? [...reactions[me]]
      : (reactions[me] ? [reactions[me]] : []);

    mine = mine.includes(value)
      ? mine.filter(item => item !== value)
      : [...mine, value].slice(-3);

    if (mine.length) reactions[me] = mine;
    else delete reactions[me];

    const cryptoPack = await this.crypto.encryptPayload({
      friendId,
      kind: 'reaction',
      subjectMsgId: msgId,
      payload: {
        type: 'message',
        text: safe(message.text).slice(0, 1000),
        replyToMsgId: safe(message.replyToMsgId),
        replyText: safe(message.replyText).slice(0, 160),
        reactions
      }
    });

    const result = await this._req('chat_update_v2', {
      friendId: safe(friendId),
      msgId: safe(msgId),
      crypto: cryptoPack
    });

    return {
      ...result,
      reactions
    };
  }

  async deleteChatMessage({
    friendId,
    msgId,
    message = null
  }) {
    if (Number(message?.cryptoVersion || 0) !== 2) {
      throw new Error('chat_e2ee_message_required');
    }

    const deletedAt = Date.now();
    const cryptoPack = await this.crypto.encryptPayload({
      friendId,
      kind: 'tombstone',
      subjectMsgId: msgId,
      payload: {
        type: 'tombstone',
        deletedAt
      }
    });

    return this._req('chat_delete_v2', {
      friendId: safe(friendId),
      msgId: safe(msgId),
      expectedRevision: Number(message?.revision || 1),
      deletedAt,
      crypto: cryptoPack
    });
  }

  async getChatMessages({ friendId, after = 0 } = {}) {
    const result = await this._req('chat_poll', {
      friendId: safe(friendId),
      after: Number(after || 0)
    });

    const items = Array.isArray(result.items)
      ? result.items
      : [];

    return this.crypto.decryptMessages(items);
  }

  async getChatMessage({ friendId, msgId } = {}) {
    const result = await this._req('chat_message_get', {
      friendId: safe(friendId),
      msgId: safe(msgId)
    });

    if (!result.message) return null;
    return this.crypto.decryptMessage(result.message);
  }
  
  async decryptChatMessage(message) {
    return this.crypto.decryptMessage(message);
  }

  async getOwnCryptoDevices() {
    const result = await this._req('crypto_device_self_list', {});
    return Array.isArray(result.items) ? result.items : [];
  }

  async getCryptoDevices(friendId) {
    return this.crypto.listDevices(friendId);
  }

  async getLocalCryptoDevice() {
    return this.crypto.getLocalDeviceInfo();
  }

  async revokeCryptoDevice(deviceId) {
    const local = await this.crypto.getLocalDeviceInfo();
    const result = await this._req('crypto_device_revoke', {
      deviceId: safe(deviceId)
    });

    if (local?.deviceId === safe(deviceId)) {
      await this.crypto.resetLocalDevice();
    }

    return result;
  }

  async resetCryptoDevices() {
    const result = await this._req('crypto_device_reset', {});
    await this.crypto.resetLocalDevice();
    await this.crypto.ensureDevice();
    return result;
  }

  async getSafetyNumber(friendId) {
    return this.crypto.buildSafetyNumber(friendId);
  }

  getSafetyVerification(friendId) {
    return this.crypto.getSafetyVerification(friendId);
  }

  setSafetyVerified(friendId, safety) {
    return this.crypto.setSafetyVerified(friendId, safety);
  }

  async clearChat(friendId) {
    return this._req('chat_clear', { friendId: safe(friendId) });
  }

  async getChatSettings(friendId) {
    const res = await this._req('chat_settings_get', {
      friendId: safe(friendId)
    });
    return res.settings || { retentionDays: 30, clearedBefore: 0 };
  }

  async setChatRetention(friendId, retentionDays) {
    return this._req('chat_settings_set', {
      friendId: safe(friendId),
      retentionDays: Number(retentionDays)
    });
  }

  async purgeChatForBoth(friendId) {
    return this._req('chat_purge_both', {
      friendId: safe(friendId)
    });
  }
  
  async markChatDelivered({ friendId, msgId = '' } = {}) {
    return this._req('chat_delivery', {
      friendId: safe(friendId),
      msgId: safe(msgId)
    });
  }

  async markChatRead({ friendId, msgId = '' } = {}) {
    return this._req('chat_read', {
      friendId: safe(friendId),
      msgId: safe(msgId)
    });
  }

  async getRtcConfig() {
    return this._req('rtc_config', {});
  }

  async getVoiceHistory(friendId) {
    const res = await this._req('voice_history', { friendId: safe(friendId) });
    return Array.isArray(res.items) ? res.items : [];
  }

  async createVoiceCall({ toFriendId, peerId } = {}) {
    return this._req('voice_call_create', {
      toFriendId: safe(toFriendId),
      peerId: safe(peerId)
    });
  }

  async joinVoiceCall({ friendId, callId = '', roomId, roomSecret, peerId } = {}) {
    return this._req('voice_call_join', {
      friendId: safe(friendId),
      callId: safe(callId),
      roomId: safe(roomId),
      roomSecret: safe(roomSecret),
      peerId: safe(peerId)
    });
  }

  async endVoiceCall({
    friendId,
    callId = '',
    roomId = '',
    roomSecret = '',
    status = 'ended',
    durationSec = 0
  } = {}) {
    return this._req('voice_call_end', {
      friendId: safe(friendId),
      callId: safe(callId),
      roomId: safe(roomId),
      roomSecret: safe(roomSecret),
      status: safe(status),
      durationSec: Number(durationSec || 0)
    });
  }

  async getRoom(roomId, roomSecret = '') {
    return this._req('room_get', {
      roomId: safe(roomId),
      roomSecret: safe(roomSecret)
    });
  }

  async sendVoiceSignal({ roomId, roomSecret, fromPeerId, toPeerId, type, data } = {}) {
    return this._req('signal_send', {
      roomId: safe(roomId),
      roomSecret: safe(roomSecret),
      fromPeerId: safe(fromPeerId),
      toPeerId: safe(toPeerId),
      type: safe(type),
      payload: data
    });
  }

  async pollVoiceSignals({ roomId, roomSecret, peerId } = {}) {
    const res = await this._req('signal_poll', {
      roomId: safe(roomId),
      roomSecret: safe(roomSecret),
      peerId: safe(peerId)
    });
    return Array.isArray(res.messages) ? res.messages : [];
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

  async sendPush({ toFriendId, kind = 'GENERIC', text = '', gameId = '', roomId = '', roomSecret = '' } = {}) {
    return this._req('push_send', {
      toFriendId: safe(toFriendId),
      kind: safe(kind || 'GENERIC').slice(0, 40),
      text: safe(text).slice(0, 300),
      gameId: safe(gameId),
      roomId: safe(roomId),
      roomSecret: safe(roomSecret)
    });
  }

  async getPushes() {
    const res = await this._req('push_poll', {});
    return Array.isArray(res.items) ? res.items : [];
  }

  async ackPushes(pushIds = []) {
    const ids = [...new Set(
      (Array.isArray(pushIds) ? pushIds : [pushIds])
        .map(safe)
        .filter(Boolean)
    )].slice(0, 100);

    if (!ids.length) return { ok: true, acked: 0 };
    return this._req('push_ack', { pushIds: ids });
  }
  
  async getProfile(targetId) {
    const res = await this._req('profile_get', { targetId: safe(targetId) });
    return res.profile || null;
  }

  async getWebPushConfig() {
    return this._req('webpush_config', {});
  }

  async subscribeWebPush(subscription) {
    return this._req('webpush_subscribe', {
      subscription,
      userAgent: navigator.userAgent || ''
    });
  }

  async unsubscribeWebPush(subscriptionOrEndpoint) {
    const endpoint = typeof subscriptionOrEndpoint === 'string'
      ? subscriptionOrEndpoint
      : subscriptionOrEndpoint?.endpoint || '';
    return this._req('webpush_unsubscribe', { endpoint });
  }

  async createNearbyFriendCode() {
    return this._req('nearby_friend_create', {});
  }

  async joinNearbyFriendCode(code) {
    this._cache.at = 0;
    return this._req('nearby_friend_join', {
      code: safe(code).replace(/\D/g, '').slice(0, 6)
    });
  }

  async ackVoiceSignals({ roomId, roomSecret, peerId, seqs = [] } = {}) {
    return this._req('signal_ack', {
      roomId: safe(roomId),
      roomSecret: safe(roomSecret),
      peerId: safe(peerId),
      seqs: [...new Set(
        (Array.isArray(seqs) ? seqs : [])
          .map(safe)
          .filter(Boolean)
      )].slice(0, 200)
    });
  }
}

const shortCode = inviteId => safe(inviteId)
  .replace(/[^a-z0-9]/gi, '')
  .slice(-6)
  .toUpperCase();

export default FriendsCore;
