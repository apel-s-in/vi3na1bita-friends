// /Friends/voice-call-ui.js
// Голосовой звонок (WebRTC) вынесен из friends-ui.js 1:1, без изменения логики.

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

export const openVoiceCallUi = ({
  friendId,
  name = 'Друг',
  incoming = null,
  core,
  openModal,
  toast,
  onVoiceOpened = null
} = {}) => {
  if (!friendId || !core || typeof openModal !== 'function') return false;

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
  `, { closeOnBackdrop: false });

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
    } catch {
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
        await core.ackVoiceSignals({
          roomId,
          roomSecret,
          peerId: myPeerId,
          seqs: items.map(x => x.seq).filter(Boolean)
        }).catch(() => null);
      } catch {
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
      } catch {
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
  ov.querySelector('#vf-voice-info').onclick = () => toast?.('Для стабильной связи в мобильных сетях нужен TURN-сервер');
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

export default { openVoiceCallUi };
