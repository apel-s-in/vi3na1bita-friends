// /Friends/friends-crypto.js
// E2EE V2: non-extractable ECDH P-256 private key в IndexedDB,
// AES-256-GCM payload и отдельный envelope для каждого активного устройства.

const DB_NAME = 'Vi3FriendsCrypto';
const DB_VERSION = 1;
const STORE = 'deviceKeys';
const te = new TextEncoder();
const td = new TextDecoder();
const safe = value => String(value == null ? '' : value).trim();

const b64url = value => {
  const bytes = value instanceof Uint8Array
    ? value
    : new Uint8Array(value);
  let raw = '';
  bytes.forEach(byte => { raw += String.fromCharCode(byte); });
  return btoa(raw)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
};

const unb64url = value => {
  const raw = safe(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
};

const randomBytes = length => crypto.getRandomValues(new Uint8Array(length));

const openDb = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, DB_VERSION);

  request.onupgradeneeded = event => {
    const db = event.target.result;
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: 'ownerId' });
    }
  };

  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const dbGet = async ownerId => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(STORE, 'readonly')
      .objectStore(STORE)
      .get(ownerId);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
};

const dbPut = async row => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(row);
    tx.oncomplete = () => resolve(row);
    tx.onerror = () => reject(tx.error);
  });
};

const sha256 = async value =>
  new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    value instanceof Uint8Array ? value : te.encode(String(value))
  ));

const fingerprintOf = async publicJwk =>
  b64url(await sha256(
    `${safe(publicJwk?.crv)}:${safe(publicJwk?.x)}:${safe(publicJwk?.y)}`
  ));

const generateDeviceKey = async ownerId => {
  // Экспортируемый keypair существует только во время создания.
  // В IndexedDB сохраняется повторно импортированный extractable:false private key.
  const temporary = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const [privateJwk, publicJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', temporary.privateKey),
    crypto.subtle.exportKey('jwk', temporary.publicKey)
  ]);

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );

  const deviceId = `ecd_${crypto.randomUUID().replace(/-/g, '')}`;
  const fingerprint = await fingerprintOf(publicJwk);

  return dbPut({
    ownerId,
    deviceId,
    privateKey,
    publicJwk,
    fingerprint,
    createdAt: Date.now()
  });
};
const dbDelete = async ownerId => {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(ownerId);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
};
const importPublicKey = publicJwk =>
  crypto.subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

const deriveWrapKey = async ({
  privateKey,
  publicJwk,
  salt,
  info
}) => {
  const publicKey = await importPublicKey(publicJwk);
  const secret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  );
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    secret,
    'HKDF',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: te.encode(info)
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
};

const roomIdOf = (a, b) => [safe(a), safe(b)].sort().join(':');

const makeAad = ({
  kind,
  room,
  fromFriendId,
  toFriendId,
  clientMsgId,
  subjectMsgId,
  senderDeviceId
}) => b64url(te.encode(JSON.stringify({
  v: 2,
  kind,
  room,
  fromFriendId,
  toFriendId,
  clientMsgId,
  subjectMsgId,
  senderDeviceId
})));

export class FriendsCrypto {
  constructor({ request = null } = {}) {
    this.request = request;
    this.identity = null;
    this.device = null;
  }

  setIdentity(identity = {}) {
    this.identity = {
      friendId: safe(identity.friendId),
      displayName: safe(identity.displayName || ''),
      deviceStableId: safe(identity.deviceStableId || '')
    };
    this.device = null;
  }

  isSupported() {
    return !!(
      crypto?.subtle &&
      indexedDB &&
      this.identity?.friendId &&
      typeof this.request === 'function'
    );
  }

  async ensureDevice() {
    if (!this.isSupported()) throw new Error('crypto_not_supported');
    if (this.device) return this.device;

    const ownerId = this.identity.friendId;
    this.device = await dbGet(ownerId) || await generateDeviceKey(ownerId);

    const result = await this.request('crypto_device_register', {
      deviceId: this.device.deviceId,
      publicJwk: this.device.publicJwk,
      fingerprint: this.device.fingerprint,
      label: this.identity.displayName || 'Устройство',
      deviceStableId: this.identity.deviceStableId
    });

    if (!result?.ok) throw new Error('crypto_device_register_failed');
    return this.device;
  }

  async listDevices(friendId) {
    const result = await this.request('crypto_device_list', {
      friendId: safe(friendId)
    });
    return Array.isArray(result?.items) ? result.items : [];
  }

  async encryptPayload({
    friendId,
    payload,
    kind = 'message',
    clientMsgId = '',
    subjectMsgId = ''
  } = {}) {
    const device = await this.ensureDevice();
    const fromFriendId = this.identity.friendId;
    const toFriendId = safe(friendId);
    if (!toFriendId) throw new Error('crypto_friend_required');

    const devices = await this.listDevices(toFriendId);
    const participantIds = new Set([fromFriendId, toFriendId]);
    const uniqueDevices = [...new Map(
      devices
        .filter(item =>
          participantIds.has(safe(item?.ownerId)) &&
          safe(item?.deviceId) &&
          item?.publicJwk
        )
        .map(item => [
          `${safe(item.ownerId)}:${safe(item.deviceId)}`,
          item
        ])
    ).values()];

    const myDevices = uniqueDevices.filter(item =>
      safe(item.ownerId) === fromFriendId
    );
    const peerDevices = uniqueDevices.filter(item =>
      safe(item.ownerId) === toFriendId
    );

    if (!myDevices.length) {
      throw new Error('crypto_sender_devices_missing');
    }

    if (!peerDevices.length) {
      throw new Error('crypto_peer_not_ready');
    }

    const room = roomIdOf(fromFriendId, toFriendId);
    const normalizedClientId = safe(clientMsgId) ||
      `e2e_${crypto.randomUUID().replace(/-/g, '')}`;

    const aad = makeAad({
      kind,
      room,
      fromFriendId,
      toFriendId,
      clientMsgId: normalizedClientId,
      subjectMsgId: safe(subjectMsgId),
      senderDeviceId: device.deviceId
    });

    const messageKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    const rawMessageKey = new Uint8Array(
      await crypto.subtle.exportKey('raw', messageKey)
    );
    const iv = randomBytes(12);
    const kdfSalt = randomBytes(32);

    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: unb64url(aad)
      },
      messageKey,
      te.encode(JSON.stringify(payload || {}))
    );

    const envelopes = [];

    for (const target of uniqueDevices) {
      const ownerId = safe(target.ownerId);
      const targetDeviceId = safe(target.deviceId);
      if (!ownerId || !targetDeviceId || !target.publicJwk) continue;

      const info =
        `vi3-chat-envelope-v2|${normalizedClientId}|` +
        `${device.deviceId}|${ownerId}|${targetDeviceId}`;

      const wrapKey = await deriveWrapKey({
        privateKey: device.privateKey,
        publicJwk: target.publicJwk,
        salt: kdfSalt,
        info
      });

      const wrapIv = randomBytes(12);
      const wrappedKey = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: wrapIv,
          additionalData: unb64url(aad)
        },
        wrapKey,
        rawMessageKey
      );

      envelopes.push({
        ownerId,
        deviceId: targetDeviceId,
        wrapIv: b64url(wrapIv),
        wrappedKey: b64url(wrappedKey)
      });
    }

    if (!envelopes.length) throw new Error('crypto_envelopes_missing');

    return {
      version: 2,
      algorithm: 'ECDH-P256+HKDF-SHA256+AES-256-GCM',
      senderDeviceId: device.deviceId,
      senderPublicJwk: device.publicJwk,
      senderFingerprint: device.fingerprint,
      aad,
      iv: b64url(iv),
      kdfSalt: b64url(kdfSalt),
      ciphertext: b64url(ciphertext),
      envelopes,
      clientMsgId: normalizedClientId
    };
  }

  async decryptMessage(message = {}) {
    if (Number(message.cryptoVersion || message.crypto?.version) !== 2) {
      return message;
    }

    const device = await this.ensureDevice();
    const pack = message.crypto || {};
    const envelope = (pack.envelopes || []).find(item =>
      safe(item.ownerId) === this.identity.friendId &&
      safe(item.deviceId) === device.deviceId
    );

    if (!envelope) throw new Error('crypto_envelope_not_found');

    const info =
      `vi3-chat-envelope-v2|${safe(pack.clientMsgId)}|` +
      `${safe(pack.senderDeviceId)}|${this.identity.friendId}|${device.deviceId}`;

    const wrapKey = await deriveWrapKey({
      privateKey: device.privateKey,
      publicJwk: pack.senderPublicJwk,
      salt: unb64url(pack.kdfSalt),
      info
    });

    const rawMessageKey = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: unb64url(envelope.wrapIv),
        additionalData: unb64url(pack.aad)
      },
      wrapKey,
      unb64url(envelope.wrappedKey)
    );

    const messageKey = await crypto.subtle.importKey(
      'raw',
      rawMessageKey,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: unb64url(pack.iv),
        additionalData: unb64url(pack.aad)
      },
      messageKey,
      unb64url(pack.ciphertext)
    );

    const data = JSON.parse(td.decode(plaintext));
    const tombstone = data?.type === 'tombstone';

    return {
      ...message,
      text: tombstone ? 'Сообщение удалено' : safe(data?.text),
      replyToMsgId: tombstone ? '' : safe(data?.replyToMsgId),
      replyText: tombstone ? '' : safe(data?.replyText),
      reactions: tombstone ? {} : (data?.reactions || {}),
      deletedAt: tombstone
        ? Number(data?.deletedAt || message.deletedAt || Date.now())
        : Number(message.deletedAt || 0),
      cryptoVersion: 2,
      encrypted: true,
      decryptFailed: false
    };
  }

  async decryptMessages(items = []) {
    return Promise.all((Array.isArray(items) ? items : []).map(async item => {
      if (Number(item?.cryptoVersion || item?.crypto?.version) !== 2) {
        return item;
      }

      try {
        return await this.decryptMessage(item);
      } catch {
        return {
          ...item,
          text: '🔒 Не удалось расшифровать сообщение на этом устройстве',
          replyText: '',
          reactions: {},
          encrypted: true,
          decryptFailed: true
        };
      }
    }));
  }

  async getLocalDeviceInfo() {
    const ownerId = this.identity?.friendId;
    if (!ownerId) return null;

    const device = this.device || await dbGet(ownerId);
    if (!device) return null;

    return {
      ownerId,
      deviceId: device.deviceId,
      publicJwk: device.publicJwk,
      fingerprint: device.fingerprint,
      createdAt: device.createdAt,
      privateKeyPresent: !!device.privateKey,
      privateKeyExtractable: !!device.privateKey?.extractable
    };
  }

  async resetLocalDevice() {
    const ownerId = this.identity?.friendId;
    if (!ownerId) throw new Error('crypto_identity_required');

    await dbDelete(ownerId);
    this.device = null;
    return true;
  }

  async buildSafetyNumber(friendId) {
    const targetId = safe(friendId);
    const ownerId = this.identity?.friendId;

    if (!ownerId || !targetId) {
      throw new Error('crypto_friend_required');
    }

    const items = await this.listDevices(targetId);
    const participants = new Set([ownerId, targetId]);
    const rows = items
      .filter(item =>
        participants.has(safe(item.ownerId)) &&
        safe(item.deviceId) &&
        safe(item.fingerprint)
      )
      .map(item => ({
        ownerId: safe(item.ownerId),
        deviceId: safe(item.deviceId),
        fingerprint: safe(item.fingerprint)
      }))
      .sort((a, b) =>
        `${a.ownerId}:${a.deviceId}`.localeCompare(
          `${b.ownerId}:${b.deviceId}`
        )
      );

    if (
      !rows.some(item => item.ownerId === ownerId) ||
      !rows.some(item => item.ownerId === targetId)
    ) {
      throw new Error('crypto_peer_not_ready');
    }

    const canonical = JSON.stringify({
      v: 2,
      participants: [ownerId, targetId].sort(),
      devices: rows
    });

    const digest = await sha256(canonical);
    const digits = [...digest]
      .map(byte => String(byte).padStart(3, '0'))
      .join('')
      .slice(0, 60);

    const groups = digits.match(/.{1,5}/g) || [];

    return {
      version: 2,
      friendId: targetId,
      safetyId: b64url(digest),
      display: groups.join(' '),
      groups,
      devices: rows,
      uri: `vi3friends://verify?v=2&a=${encodeURIComponent(ownerId)}&b=${encodeURIComponent(targetId)}&s=${encodeURIComponent(b64url(digest))}`
    };
  }

  getSafetyVerification(friendId) {
    const key = `vf:safety:v2:${safe(this.identity?.friendId)}:${safe(friendId)}`;

    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
      return null;
    }
  }

  setSafetyVerified(friendId, safety) {
    const key = `vf:safety:v2:${safe(this.identity?.friendId)}:${safe(friendId)}`;
    const row = {
      safetyId: safe(safety?.safetyId),
      verifiedAt: Date.now()
    };

    localStorage.setItem(key, JSON.stringify(row));
    return row;
  }
  
  async revokeCurrentDevice() {
    const device = await this.ensureDevice();
    const result = await this.request('crypto_device_revoke', {
      deviceId: device.deviceId
    });

    await this.resetLocalDevice();
    return result;
  }
}

export default FriendsCrypto;
