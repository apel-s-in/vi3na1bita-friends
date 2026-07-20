// /Friends/embedded-rpc-contract.js
// Единый контракт Friends RPC для sandbox iframe и основного host.

const define = (
  route,
  methods,
  extra = {}
) => methods.map(name => Object.freeze({
  name,
  route,
  dangerous: false,
  ...extra[name]
}));

const HOST_METHODS = [
  'getEmbeddedIdentity',
  'getEmbeddedWebPushEnabled',
  'enableEmbeddedWebPush',
  'setEmbeddedFriendsActive'
];

const CORE_METHODS = [
  'register',
  'getFriendList',
  'getPresence',
  'getProfile',
  'removeFriend',
  'createInvite',
  'acceptInvite',
  'createNearbyFriendCode',
  'joinNearbyFriendCode',
  'sendPush',
  'sendChatMessage',
  'reactChatMessage',
  'deleteChatMessage',
  'getChatMessages',
  'getChatMessage',
  'clearChat',
  'getChatSettings',
  'setChatRetention',
  'purgeChatForBoth',
  'markChatDelivered',
  'markChatRead',
  'getOwnCryptoDevices',
  'getCryptoDevices',
  'getLocalCryptoDevice',
  'revokeCryptoDevice',
  'resetCryptoDevices',
  'getSafetyNumber',
  'getSafetyVerification',
  'setSafetyVerified',
  'getRtcConfig',
  'getVoiceHistory',
  'createVoiceCall',
  'joinVoiceCall',
  'endVoiceCall',
  'getRoom',
  'sendVoiceSignal',
  'pollVoiceSignals',
  'ackVoiceSignals'
];

const DANGEROUS = Object.freeze({
  purgeChatForBoth: Object.freeze({
    dangerous: true,
    confirmation: Object.freeze({
      title: 'Удалить переписку у обоих?',
      text: 'Все сообщения этого диалога будут безвозвратно удалены у вас и у собеседника.',
      confirmText: 'Удалить у обоих'
    })
  }),
  revokeCryptoDevice: Object.freeze({
    dangerous: true,
    confirmation: Object.freeze({
      title: 'Отозвать ключ устройства?',
      text: 'Устройство потеряет доступ к новым сообщениям. История без подходящего ключа может стать недоступна.',
      confirmText: 'Отозвать устройство'
    })
  }),
  resetCryptoDevices: Object.freeze({
    dangerous: true,
    confirmation: Object.freeze({
      title: 'Полностью сбросить E2EE-ключи?',
      text: 'Все текущие ключи будут отозваны. Часть старой переписки может стать недоступна без возможности восстановления.',
      confirmText: 'Сбросить ключи'
    })
  })
});

export const EMBEDDED_FRIENDS_RPC_VERSION = 1;

export const EMBEDDED_FRIENDS_RPC = Object.freeze([
  ...define('host', HOST_METHODS),
  ...define('core', CORE_METHODS, DANGEROUS)
]);

const byName = new Map(
  EMBEDDED_FRIENDS_RPC.map(item => [item.name, item])
);

export const getEmbeddedFriendsRpcMethod = name =>
  byName.get(String(name || '').trim()) || null;

export const hasEmbeddedFriendsRpcMethod = name =>
  byName.has(String(name || '').trim());

export const attachEmbeddedFriendsCoreMethods = (
  target,
  request
) => {
  if (!target || typeof request !== 'function') {
    throw new Error('friends_rpc_proxy_invalid');
  }

  EMBEDDED_FRIENDS_RPC
    .filter(item => item.route === 'core')
    .forEach(item => {
      if (typeof target[item.name] === 'function') return;

      Object.defineProperty(target, item.name, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: (...args) => request(item.name, args)
      });
    });

  return target;
};

export default EMBEDDED_FRIENDS_RPC;
