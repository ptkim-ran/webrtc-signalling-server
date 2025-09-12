/* global io */
(() => {
  const logEl = document.getElementById('log');
  function log(...args) {
    //  const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    // circular-safe stringify
    function safeStringify(obj) {
      const seen = new WeakSet();
      return JSON.stringify(obj, (key, value) => {
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return "[Circular]";
          seen.add(value);
        }
        return value;
      });
    }

    const line = args
    .map(a => (typeof a === 'object' ? safeStringify(a) : String(a)))
    .join(' ');

    const div = document.createElement('div');
    div.textContent = line;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    console.log('[dummy-camera]', ...args);
  }

  const room = 'cctv-monitoring-room';
  let socket;
  let pcs = {}; // key: remote socket id
  let stream; // MediaStream to publish
  let canvas, ctx, animHandle;
  let mirrorVideo = document.getElementById('mirror');

  // draw SMPTE‑ish bars + moving text
  function startPattern({w, h, fps, label}) {
    canvas = document.getElementById('preview');
    canvas.width = w; canvas.height = h;
    ctx = canvas.getContext('2d');
    let t = 0;

    function frame() {
      // background bars
      const bars = [
        '#FF0000', '#FFFF00', '#00FF00', '#00FFFF', '#0000FF', '#FF00FF', '#FFFFFF'
      ];
      const bw = Math.ceil(w / bars.length);
      for (let i = 0; i < bars.length; i++) {
        ctx.fillStyle = bars[i];
        ctx.fillRect(i * bw, 0, bw, h);
      }

      // moving box
      const boxW = Math.max(40, Math.floor(w * 0.08));
      const boxH = Math.max(40, Math.floor(h * 0.08));
      const x = Math.floor((w - boxW) * (0.5 + 0.5 * Math.sin(t / 23)));
      const y = Math.floor((h - boxH) * (0.5 + 0.5 * Math.cos(t / 19)));
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(x, y, boxW, boxH);

      // overlay text
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 260, 70);
      ctx.fillStyle = '#0f0';
      ctx.font = `bold ${Math.floor(h/20)}px system-ui, sans-serif`;
      ctx.fillText(label, 20, 40);
      ctx.font = `bold ${Math.floor(h/28)}px system-ui, sans-serif`;
      const ts = new Date().toLocaleString();
      ctx.fillText(ts, 20, 70);

      t++;
      animHandle = setTimeout(frame, 1000 / fps);
    }
    frame();
  }

  async function startPublisher() {
    const camId = document.getElementById('camId').value || 'cam-1';
    const [w, h] = document.getElementById('res').value.split('x').map(x => parseInt(x, 10));
    const fps = parseInt(document.getElementById('fps').value, 10);

    // build stream from canvas + (optional) oscillator audio
    startPattern({w, h, fps, label: camId});
    const canvasStream = canvas.captureStream(fps);

    // Create a silent audio track to keep pipeline consistent
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0.0001; // almost silent
    osc.frequency.value = 440 + Math.random()*10;
    osc.connect(gain).connect(ac.destination);
    osc.start();
    const dest = ac.createMediaStreamDestination();
    gain.disconnect();
    gain.connect(dest);

    stream = new MediaStream([...canvasStream.getTracks(), ...dest.stream.getTracks()]);
    mirrorVideo.srcObject = stream;

    // connect socket
    const target = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? `http://${location.hostname}:3000`
      : `http://webrtc-local.com:3000`;

    // 새 연결 전 기존 socket cleanup
    if (socket) {
      stopPublisher();
    }

    socket = io(target, { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      log('socket connected', socket.id);
      socket.emit('create or join', room, { camId });
    });

    socket.on('room-info', (data) => {
      log('room-info', data);

      data.clients.forEach(remoteId => {
        if (pcs[remoteId]) {
          cleanupPeer(remoteId); // 기존 연결 정리
        }
        if (data.isInitiator) {
          createPeer(remoteId, true);
        }
      });
    });

    socket.on('peer-joined', (data) => {
      log('peer-joined', data);
      // if we are initiator, call the newcomer
      // whether or not, ensure we have a pc ready
      if (!pcs[data.socketId]) {
        createPeer(data.socketId, true);
      }
    });

    socket.on('peer-left', (data) => {
      log('peer-left', data);
      cleanupPeer(data.socketId); // cleanup 함수 호출
    });

    socket.on('message', async ({ from, message }) => {
      const pc = pcs[from] || await createPeer(from, false);
      if (message.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(message));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('message', { targetId: from, message: pc.localDescription, room });
      } else if (message.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(message));
      } else if (message.type === 'candidate') {
        try {
          await pc.addIceCandidate({ candidate: message.candidate, sdpMLineIndex: message.label, sdpMid: message.id });
        } catch (e) {
          log('addIceCandidate error', e);
        }
      }
    });
  }

  function stopPublisher() {
    if (animHandle) clearTimeout(animHandle);
    if (stream) stream.getTracks().forEach(t => t.stop());

    Object.values(pcs).forEach(pc => pc.close());
    pcs = {};

    if (socket) {
      const camId = document.getElementById('camId').value || 'cam-1';
      socket.emit('cleanup-cam', { camId, room });
      socket.disconnect();
      socket = null;
    }

    log('stopPublisher socket disconnected');
  }

  // peer cleanup.
  function cleanupPeer(remoteId) {
    log('Cleaning up peer:', remoteId);
    const pc = pcs[remoteId];
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.close();
      delete pcs[remoteId];
    }
  }

  // peer connection 생성.
  async function createPeer(remoteId, makeOffer) {
    log('createPeer ->', remoteId, 'offer?', makeOffer);
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
    pcs[remoteId] = pc;


    // TURN credential fetch
    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      try {
        const response = await fetch("http://webrtc-local.com:3000/api/turn-credentials");
        if (response.ok) {
          const turnConfig = await response.json();
          log("Got TURN server credentials:", turnConfig);

          // RTCPeerConnection은 iceServers를 직접 push 못 함
          // → getConfiguration() / setConfiguration() 사용해야 함
          const cfg = pc.getConfiguration();
          cfg.iceServers.push({
            urls: turnConfig.urls,
            username: turnConfig.username,
            credential: turnConfig.credential
          });
          pc.setConfiguration(cfg);

          log('TURN server added to RTCPeerConnection:', cfg.iceServers);
        }
      } catch (err) {
        console.warn('TURN setup failed, using STUN only', err);
      }
    }

    // publish our tracks
    if (stream) {
      stream.getTracks().forEach(tr => pc.addTrack(tr, stream));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('message', {
          targetId: remoteId,
          room,
          camId,
          message: {
            type: 'candidate',
            label: e.candidate.sdpMLineIndex,
            id: e.candidate.sdpMid,
            candidate: e.candidate.candidate
          }
        });
      }
    };

    pc.onconnectionstatechange = () => log('pc state', remoteId, pc.connectionState);
    pc.oniceconnectionstatechange = () => {
      log('ice state', remoteId, pc.iceConnectionState);

      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
        // 일정 시간 후 회복되지 않으면 정리
        setTimeout(() => {
          if (pcs[remoteId] && (pcs[remoteId].iceConnectionState === 'failed' || pcs[remoteId].iceConnectionState === 'disconnected')) {
            log(`Connection ${pc.iceConnectionState} for ${remoteId}, cleaning up.`);
            cleanupPeer(remoteId);
          }
        }, 3000);
      }
    }

    (async () => {
      if (makeOffer) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('message', { targetId: remoteId, room, message: offer });
      }
    })();

    return pc;
  }

  document.getElementById('startBtn').addEventListener('click', startPublisher);
  document.getElementById('stopBtn').addEventListener('click', stopPublisher);
})();