// /Friends/voice-call-ui.js
// Голосовой чат вынесен из friends-ui.js без изменения поведения.

export const openVoiceCallUi = ({
  friendId,
  name = 'Друг',
  incoming = null,
  core,
  openModal,
  toast,
  onVoiceOpened = null
} = {}) => {
  // Сюда переносится текущий openVoiceCallModal из friends-ui.js 1:1.
  // Логика не меняется: только вынос в отдельный файл.
  // Важно: оставить те же callbacks, те же состояния, те же DOM-классы.
};
