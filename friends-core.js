// /Friends/friends-core.js
// Data + identity + network для модуля Друзья. Без DOM.
import { FriendsCrypto } from './friends-crypto.js?v=9.3.1';
const SIGNALING_URL = 'https://functions.yandexcloud.net/d4e2epg33mkshjoar6av';
export const CHAT_E2EE_V2 = true;
const safe = v => String(v == null ? '' : v).trim();
const encoder = new TextEncoder();
const byteLength = value => encoder.encode(typeof value === 'string' ? value : JSON.stringify(value ?? null)).byteLength;
const jsonParse = raw => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
const sha256Hex = async text => {
  if (!crypto?.subtle) {
    let h = 0x811c9dc5;
    const s = safe(text);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
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
    this._snapshot = { revision: '', friends: [], presence: {}, at: 0, pending: null };
    this._profiles = new Map();
    this.onError = () => {};
    this.chatE2eeV2 = CHAT_E2EE_V2;
    this.crypto = new FriendsCrypto({ request: (action, data) => this._req(action, data) });
  }
  // Identity приходит только от основного приложения.
  setIdentity(identity = {}) {
    const previousFriendId = safe(this.identity?.friendId);
    const previousSession = safe(this.identity?.socialSession);
    this.identity = {
      friendId: safe(identity.friendId),
      displayName: safe(identity.displayName || 'Слушатель'),
      avatar: safe(identity.avatar || ''),
      yandexLinked: !!identity.yandexLinked,
      deviceStableId: safe(identity.deviceStableId || ''),
      socialSession: safe(identity.socialSession || ''),
      sessionExpiresAt: Number(identity.sessionExpiresAt || 0)
    };
    if (previousFriendId !== this.identity.friendId || previousSession !== this.identity.socialSession) {
      this.invalidateFriendsSnapshot('identity_changed');
    }
    this.crypto.setIdentity(this.identity);
    return this.identity;
  }
  isReady() {
    return !!(this.identity?.friendId && this.identity?.yandexLinked && this.identity?.socialSession && Number(this.identity?.sessionExpiresAt || 0) > Date.now());
  }
  async _fetch(action, data = {}, { signed = true } = {}) {
    const requestBody = JSON.stringify({
      action,
      ...(signed ? { displayName: this.identity.displayName, avatarUrl: this.identity.avatar } : {}),
      ...data
    });
    const startedAt = performance.now();
    let status = 0;
    let responseText = '';

    try {
      const response = await fetch(this.signalingUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(signed ? { 'X-Vi3-Session': this.identity.socialSession } : {})
        },
        credentials: 'omit',
        mode: 'cors',
        body: requestBody
      });
      status = response.status;
      responseText = await response.text();
      const result = jsonParse(responseText) || {};

      globalThis.CloudUsageMeter?.record?.({
        service: 'cloud_functions',
        operation: 'invoke',
        action,
        host: new URL(this.signalingUrl).host,
        status,
        requestBytes: byteLength(requestBody),
        responseBytes: byteLength(responseText),
        durationMs: performance.now() - startedAt,
        serverUsage: result.usage,
        exact: true
      });

      if (!response.ok || result.ok === false) {
        const error = new Error(`${action}: ${result.error || result.reason || `http_${response.status}`}`);
        error.status = response.status;
        error.action = action;
        this.onError(error);
        throw error;
      }
      return result;
    } catch (error) {
      if (!status) {
        globalThis.CloudUsageMeter?.record?.({
          service: 'cloud_functions',
          operation: 'invoke',
          action,
          host: new URL(this.signalingUrl).host,
          status: 0,
          requestBytes: byteLength(requestBody),
          responseBytes: byteLength(responseText),
          durationMs: performance.now() - startedAt,
          exact: true
        });
        this.onError(error);
        throw new Error('network_unreachable');
      }
      throw error;
    }
  }
  async _req(action, data = {}) {
    if (!this.isReady()) throw new Error('friends_identity_required');
    return this._fetch(action, data, { signed: true });
  }
  async register() {
    await this.crypto.ensureDevice();
    return true;
  }
  invalidateFriendsSnapshot(reason = 'manual') {
    this._snapshot = { revision: '', friends: [], presence: {}, at: 0, pending: null, reason };
    this._profiles.clear();
    return true;
  }
  async getFriendsSnapshot({ force = false } = {}) {
    if (!force && this._snapshot.at > 0) {
      return {
        version: 1,
        revision: this._snapshot.revision,
        items: this._snapshot.friends,
        presence: { ...this._snapshot.presence },
        generatedAt: this._snapshot.at,
        cached: true
      };
    }
    if (this._snapshot.pending) return this._snapshot.pending;

    this._snapshot.pending = this._req('friends_snapshot', {})
      .then(result => {
        const snapshot = result?.snapshot || {};
        const friends = Array.isArray(snapshot.items) ? snapshot.items : [];
        const presence = snapshot.presence && typeof snapshot.presence === 'object' ? snapshot.presence : {};
        friends.forEach(item => {
          if (item?.friendId && item?.profile) this._profiles.set(item.friendId, item.profile);
        });
        this._snapshot = {
          revision: safe(snapshot.revision),
          friends,
          presence,
          at: Number(snapshot.generatedAt || Date.now()),
          pending: null
        };
        return {
          version: 1,
          revision: this._snapshot.revision,
          items: friends,
          presence: { ...presence },
          generatedAt: this._snapshot.at,
          cached: false
        };
      })
      .finally(() => {
        this._snapshot.pending = null;
      });

    return this._snapshot.pending;
  }
  async getFriendList({ force = false } = {}) {
    return (await this.getFriendsSnapshot({ force })).items;
  }
  async heartbeat({ gameId = '', roomId = '' } = {}) {
    return this._req('presence_heartbeat', { deviceId: this.identity.deviceStableId || 'web', gameId: safe(gameId), roomId: safe(roomId) });
  }
  async getPresence(friendIds = [], { force = false } = {}) {
    const ids = [...new Set(friendIds.map(safe).filter(Boolean))].slice(0, 50);
    if (!ids.length) return {};
    const snapshot = await this.getFriendsSnapshot({ force });
    return Object.fromEntries(ids.map(id => [id, snapshot.presence[id] || { online: false }]));
  }
  async sendChatMessage({ toFriendId, text, replyToMsgId = '', replyText = '', clientMsgId = '' }) {
    const cryptoPack = await this.crypto.encryptPayload({ friendId: toFriendId, clientMsgId, kind: 'message', payload: { type: 'message', text: safe(text).slice(0, 1000), replyToMsgId: safe(replyToMsgId), replyText: safe(replyText).slice(0, 160), reactions: {} } });
    return this._req('chat_send_v2', { toFriendId: safe(toFriendId), clientMsgId: cryptoPack.clientMsgId, crypto: cryptoPack });
  }
  async reactChatMessage({ friendId, msgId, emoji, message = null }) {
    if (Number(message?.cryptoVersion || 0) !== 2) {
      throw new Error('chat_e2ee_message_required');
    }
    let current = message;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (current.decryptFailed || current.deletedAt) {
        throw new Error('chat_message_not_editable');
      }
      const reactions = { ...(current.reactions || {}) };
      const me = this.identity.friendId;
      const value = safe(emoji).slice(0, 8);
      let mine = Array.isArray(reactions[me]) ? [...reactions[me]] : reactions[me] ? [reactions[me]] : [];
      mine = mine.includes(value) ? mine.filter(item => item !== value) : [...mine, value].slice(-3);
      if (mine.length) reactions[me] = mine;
      else delete reactions[me];
      const cryptoPack = await this.crypto.encryptPayload({ friendId, kind: 'reaction', subjectMsgId: msgId, payload: { type: 'message', text: safe(current.text).slice(0, 1000), replyToMsgId: safe(current.replyToMsgId), replyText: safe(current.replyText).slice(0, 160), reactions } });
      try {
        const result = await this._req('chat_update_v2', { friendId: safe(friendId), msgId: safe(msgId), expectedRevision: Number(current.revision || 1), crypto: cryptoPack });
        return { ...result, reactions };
      } catch (error) {
        if (!String(error?.message || '').includes('chat_revision_conflict') || attempt >= 2) {
          throw error;
        }
        current = await this.getChatMessage({ friendId, msgId });
        if (!current) throw new Error('chat_message_not_found');
      }
    }
    throw new Error('chat_revision_conflict');
  }
  async deleteChatMessage({ friendId, msgId, message = null }) {
    if (Number(message?.cryptoVersion || 0) !== 2) {
      throw new Error('chat_e2ee_message_required');
    }
    const deletedAt = Date.now();
    const cryptoPack = await this.crypto.encryptPayload({ friendId, kind: 'tombstone', subjectMsgId: msgId, payload: { type: 'tombstone', deletedAt } });
    return this._req('chat_delete_v2', { friendId: safe(friendId), msgId: safe(msgId), expectedRevision: Number(message?.revision || 1), deletedAt, crypto: cryptoPack });
  }
  async getChatMessages({ friendId, after = 0 } = {}) {
    const result = await this._req('chat_poll', { friendId: safe(friendId), after: Number(after || 0) });
    const items = Array.isArray(result.items) ? result.items : [];
    return this.crypto.decryptMessages(items);
  }
  async getChatMessage({ friendId, msgId } = {}) {
    const result = await this._req('chat_message_get', { friendId: safe(friendId), msgId: safe(msgId) });
    if (!result.message) return null;
    return this.crypto.decryptMessage(result.message);
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
    const result = await this._req('crypto_device_revoke', { deviceId: safe(deviceId) });
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
    const res = await this._req('chat_settings_get', { friendId: safe(friendId) });
    return res.settings || { retentionDays: 30, clearedBefore: 0 };
  }
  async setChatRetention(friendId, retentionDays) {
    return this._req('chat_settings_set', { friendId: safe(friendId), retentionDays: Number(retentionDays) });
  }
  async purgeChatForBoth(friendId) {
    return this._req('chat_purge_both', { friendId: safe(friendId) });
  }
  async markChatDelivered({ friendId, msgId = '' } = {}) {
    return this._req('chat_delivery', { friendId: safe(friendId), msgId: safe(msgId) });
  }
  async markChatRead({ friendId, msgId = '' } = {}) {
    return this._req('chat_read', { friendId: safe(friendId), msgId: safe(msgId) });
  }
  async getRtcConfig() {
    return this._req('rtc_config', {});
  }
  async getVoiceHistory(friendId) {
    const res = await this._req('voice_history', { friendId: safe(friendId) });
    return Array.isArray(res.items) ? res.items : [];
  }
  async createVoiceCall({ toFriendId, peerId } = {}) {
    return this._req('voice_call_create', { toFriendId: safe(toFriendId), peerId: safe(peerId) });
  }
  async joinVoiceCall({ friendId, callId = '', roomId, roomSecret, peerId } = {}) {
    return this._req('voice_call_join', { friendId: safe(friendId), callId: safe(callId), roomId: safe(roomId), roomSecret: safe(roomSecret), peerId: safe(peerId) });
  }
  async endVoiceCall({ friendId, callId = '', roomId = '', roomSecret = '', status = 'ended', durationSec = 0 } = {}) {
    return this._req('voice_call_end', { friendId: safe(friendId), callId: safe(callId), roomId: safe(roomId), roomSecret: safe(roomSecret), status: safe(status), durationSec: Number(durationSec || 0) });
  }
  async getRoom(roomId, roomSecret = '') {
    return this._req('room_get', { roomId: safe(roomId), roomSecret: safe(roomSecret) });
  }
  async sendVoiceSignal({ roomId, roomSecret, fromPeerId, toPeerId, type, data } = {}) {
    return this._req('signal_send', { roomId: safe(roomId), roomSecret: safe(roomSecret), fromPeerId: safe(fromPeerId), toPeerId: safe(toPeerId), type: safe(type), payload: data });
  }
  async pollVoiceSignals({ roomId, roomSecret, peerId } = {}) {
    const res = await this._req('signal_poll', { roomId: safe(roomId), roomSecret: safe(roomSecret), peerId: safe(peerId) });
    return Array.isArray(res.messages) ? res.messages : [];
  }
  async removeFriend(friendId) {
    const result = await this._req('friend_remove', { targetId: safe(friendId) });
    this.invalidateFriendsSnapshot('friend_removed');
    return result;
  }
  async createInvite() {
    const res = await this._req('friend_invite_create', {});
    const url = `${location.origin}/?addFriend=${encodeURIComponent(res.inviteId)}&key=${encodeURIComponent(res.secret)}`;
    return { ...res, url, code: shortCode(res.inviteId) };
  }
  async acceptInvite({ inviteId, secret }) {
    const result = await this._req('friend_invite_accept', { inviteId: safe(inviteId), secret: safe(secret) });
    this.invalidateFriendsSnapshot('friend_invite_accepted');
    return result;
  }
  async getInviteInfo(inviteId, secret) {
    const result = await this._fetch('friend_invite_get', {
      inviteId: safe(inviteId),
      secret: safe(secret)
    }, { signed: false });
    return result.invite;
  }
  async sendPush({ toFriendId, kind = 'GENERIC', text = '', gameId = '' } = {}) {
    return this._req('push_send', { toFriendId: safe(toFriendId), kind: safe(kind || 'GENERIC').slice(0, 40), text: safe(text).slice(0, 300), gameId: safe(gameId) });
  }
  async getPushes() {
    const device = await this.crypto.ensureDevice();
    const res = await this._req('push_poll', { deviceId: device.deviceId });
    return Array.isArray(res.items) ? res.items : [];
  }
  async ackPushes(pushIds = []) {
    const ids = [...new Set((Array.isArray(pushIds) ? pushIds : [pushIds]).map(safe).filter(Boolean))].slice(0, 100);
    if (!ids.length) return { ok: true, acked: 0 };
    const device = await this.crypto.ensureDevice();
    return this._req('push_ack', { deviceId: device.deviceId, pushIds: ids });
  }
  async getProfile(targetId) {
    const id = safe(targetId);
    if (!id) return null;
    if (this._profiles.has(id)) return this._profiles.get(id);
    const res = await this._req('profile_get', { targetId: id });
    if (res.profile) this._profiles.set(id, res.profile);
    return res.profile || null;
  }
  async getWebPushConfig() {
    return this._req('webpush_config', {});
  }
  async subscribeWebPush(subscription) {
    return this._req('webpush_subscribe', { subscription, userAgent: navigator.userAgent || '' });
  }
  async unsubscribeWebPush(subscriptionOrEndpoint) {
    const endpoint = typeof subscriptionOrEndpoint === 'string' ? subscriptionOrEndpoint : subscriptionOrEndpoint?.endpoint || '';
    return this._req('webpush_unsubscribe', { endpoint });
  }
  async createNearbyFriendCode() {
    return this._req('nearby_friend_create', {});
  }
  async joinNearbyFriendCode(code) {
    const result = await this._req('nearby_friend_join', { code: safe(code).replace(/\D/g, '').slice(0, 6) });
    this.invalidateFriendsSnapshot('nearby_friend_joined');
    return result;
  }
  async ackVoiceSignals({ roomId, roomSecret, peerId, seqs = [] } = {}) {
    return this._req('signal_ack', { roomId: safe(roomId), roomSecret: safe(roomSecret), peerId: safe(peerId), seqs: [...new Set((Array.isArray(seqs) ? seqs : []).map(safe).filter(Boolean))].slice(0, 200) });
  }
}
const shortCode = inviteId =>
  safe(inviteId)
    .replace(/[^a-z0-9]/gi, '')
    .slice(-6)
    .toUpperCase();
export default FriendsCore;
