'use strict';

let socket = io.connect("http://webrtc-local.com:3000", {
  transports: ["websocket", "polling"]
});

let isChannelReady = false;
let isInitiator = false;
let isStarted = false;
let localStream;
let peerConnections = {}; // 다중 peer connection 관리
let remoteStream;
let peerStreams;
let turnReady = false;
let room = "";

let pcConfig = {
  'iceServers': [
    {
      'urls': 'stun:stun.l.google.com:19302'
    },
    {
      'urls': 'stun:stun1.l.google.com:19302'
    },
  ]
};

// coturn server만 동작시키기 위해서 dynamic하게 받도록 변경.
//let pcConfig = {
//  "iceServers": []
//}

// Set up audio and video regardless of what devices are present.
let sdpConstraints = {
  offerToReceiveVideo: true,
  offerToReceiveAudio: true
};

// 나머지 코드는 동일하게 유지하지만, DOM 로드 후 실행되도록 수정
document.addEventListener('DOMContentLoaded', function() {
  let localVideo = document.querySelector('#localVideo');
  let remoteVideo = document.querySelector('#remoteVideo');

  // button event listener 설정
  document.querySelector("#muteBtn").addEventListener("click", toggleMute);
  document.querySelector("#videoBtn").addEventListener("click", toggleVideo);
  document.querySelector("#playOtherBtn").addEventListener("click", addPlayButton);

  // 방 이름 입력
  room = prompt('Enter room name:') || "room-" + Math.random().toString(36).substr(2, 5);


  if (room !== '') {
    socket.emit('create or join', room);
    console.log('Attempted to create or  join room', room);
  }

  // socket event listener
  socket.on('created', function(room) {
    console.log('Created room ' + room);
    isInitiator = true;
  });

  socket.on('full', function(room) {
    console.log('Room ' + room + ' is full');
  });

  socket.on('join', function (room){
    console.log('Another peer made a request to join room ' + room);
    console.log('This peer is the initiator of room ' + room + '!');
    isChannelReady = true;
  });

  socket.on('joined', function(room) {
    console.log('joined: ' + room);
    isChannelReady = true;
  });

  socket.on('log', function(array) {
    console.log.apply(console, array);
  });

  ////////////////////////////////////////////////
  // message 전송 함수
  function sendMessage(targetId, message) {
    console.log(`Client sending message to ${targetId}: ${message}`);
    socket.emit("message", {
      targetId: targetId,
      message: message,
      room: room
    });
  }

  // 방 정보 수신
  socket.on("room-info", function(data) {
    console.log(`Room info:`, data);
    isInitiator = data.isInitiator;

    // 기존 peer(s)에게 offer 보내기.
    data.clients.forEach(clientId => {
      if (isInitiator && clientId !== socket.id) {
        createPeerConnection(clientId);
        doCall(clientId);
      }
    });
  });

  // new peer 참가 알림
  socket.on("peer-joined", function(data) {
    console.log(`New peer joined:`, data);

    if (data.socketId !== socket.id) {
      createPeerConnection(data.socketId);
      if (isInitiator) {
        doCall(data.socketId);
      }
    }
  });

  // peer 연결 종료 알림
  socket.on("peer-left", function(data) {
    console.log(`Peer left:`, data);
    if (peerConnections[data.socketId]) {
      peerConnections[data.socketId].close();
      delete peerConnections[data.socketId];
    }

    // stream 도 제거
    if (peerStreams && peerStreams[data.socketId]) {
      delete peerStreams[data.socketId];
      updateRemoteVideoDisplay();
    }
  });

  // 메세지 수신 함수
  socket.on('message', function(data) {
    console.log("Client received message from:", data.from, "type:", 
            data.message.type || typeof data.message, data.message);

    // offer를 받으면 즉시 PeerConnection 생성
    if (data.message.type === "offer" && !peerConnections[data.from]) {
      console.log('Creating PeerConnection for offer from:', data.from);
      createPeerConnection(data.from);
    }

    const pc = peerConnections[data.from];
    if (!pc) {
      console.log('No PeerConnection for:', data.from);
      return;
    }

    const message = data.message;

    if (message === 'got user media') {
      // 다중 peer에서는 별도 처리 없음
    } else if (message.type === "offer") {
      pc.setRemoteDescription(new RTCSessionDescription(message))
        .then(() => {
          console.log("offer set, sending answer")
          doAnswer(data.from);
        })
        .catch(error => console.error('offer error:', error));
    } 
    else if (message.type === "answer") {
      pc.setRemoteDescription(new RTCSessionDescription(message))
        .then(() => {
          console.log("Answer set successfully")
          // Answer 설정 후 트랙 확인
          console.log("Current receivers:", pc.getReceivers().length);
          pc.getReceivers().forEach((receiver, index) => {
            console.log(`Receiver ${index}:`, receiver.track ? receiver.track.kind : 'no track');
          })
        })
        .catch(error => console.error('answer error:', error));
    } 
    else if (message.type === "candidate") {
      const candidate = new RTCIceCandidate({
        sdpMLineIndex: message.label,
        candidate: message.candidate
      });
      pc.addIceCandidate(candidate)
        .then(() => console.log("Candidate added"))
        .catch(error => console.error('candidate error:', error));
    } 
    else if (message === 'bye') {
      if (peerConnections[data.from]) {
        peerConnections[data.from].close();
        delete peerConnections[data.from];
      }
    }
  });

  ////////////////////////////////////////////////////
  navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true
  })
  .then(gotStream)
  .catch(function(e) {
    console.error(`getUserMedia() error: ${e}`);
    alert(`Camera access error: ${e.name}`);
  });

  function gotStream(stream) {
    console.log('Adding local stream.');
    localStream = stream;
    localVideo.srcObject = stream;

    // 모든 peer들에게 미디어 준비 완료 알림
    socket.emit("message", {
      targetId: "broadcast",
      message: "got user media",
      room: room
    });

    // TURN 서버 credentials 요청 (local이 아닐 경우)
    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      requestTurnCredentials();
    } 
    else {
      turnReady = true;
      console.log('Local development, using STUN only');
    }
  }

  // TURN 자격증명 요청 함수
  async function requestTurnCredentials() {
    try {
      console.log('Requesting TURN server credentials...');
      
      const response = await fetch("http://webrtc-local.com:3000/api/turn-credentials");
      if (!response.ok) {
        throw new Error(`TURN error! status: ${response.status}`);
      }

      const turnConfig = await response.json();
      console.log("Got TURN server credentials:", turnConfig);
      
      const turnServers = [
        {
//          urls: `turn:112.169.164.202:3478?transport=udp`,
          urls: turnConfig.urls[0], // udp
          username: turnConfig.username,
          credential: turnConfig.credential
        },
        {
//          urls: `turn:112.169.164.202:3478?transport=tcp`,
          urls: turnConfig.urls[1], // tcp
          username: turnConfig.username,
          credential: turnConfig.credential
        }
      ];
    
      pcConfig.iceServers.push(...turnServers);
      console.log('TURN servers added to config:', turnServers);

      // coturn 만 동작하도록 했을때 config.
//      pcConfig.iceServers = [
//        {
//          urls: turnConfig.urls,
//          username: turnConfig.username,
//          credential: turnConfig.credential
//        }
//      ];
//      pcConfig.iceTransportPolicy = 'relay';
//      console.log('TURN servers added to config:', pcConfig.iceServers);

      turnReady = true;
    }
    catch (error) {
      console.warn(`TURN server setup failed, using STUN only: ${error}`);
      turnReady = true;
    }
  }

  window.onbeforeunload = function() {
    sendMessage('bye');
  };

  /////////////////////////////////////////////////////////
  // PeerConnection 생성
  function createPeerConnection(targetSocketId) {
    try {
      const pc = new RTCPeerConnection(pcConfig);
      peerConnections[targetSocketId] = pc;

      // local stream 추가
      if (localStream) {
        localStream.getTracks().forEach(track => {
          pc.addTrack(track, localStream);
        });
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('Candidate type:', event.candidate.type, 
            event.candidate.protocol, event.candidate.address);

            // relay candidate가 있는지 확인
          if (event.candidate.type === 'relay') {
            console.log('✅ TURN server is being used!');
          }

          socket.emit("message", {
            targetId: targetSocketId,
            message: {
              type: "candidate",
              label: event.candidate.sdpMLineIndex,
              id: event.candidate.sdpMid,
              candidate: event.candidate.candidate
            },
            room: room
          });
        }
      };
      
      // ontrack 핸들러 - 반드시 ADD_TRACK 이벤트 전에 설정
      pc.ontrack = (event) => {
        console.log(`Remote stream received from ${targetSocketId}`);
        console.log('Remote stream tracks:', event.streams[0].getTracks());
        //peerStreams = event.streams[0];
        // 각 peer별로 stream 저장
        if(!peerStreams) {
          peerStreams = {};
        }
        peerStreams[targetSocketId] = event.streams[0];

        console.log('Remote stream tracks:', event.streams[0].getTracks());
        // video 요소를 stream에 할당
        updateRemoteVideoDisplay();

      };

      pc.oniceconnectionstatechange = () => {
        console.log(`ICE state with ${targetSocketId}: ${pc.iceConnectionState}`);
        updateConnectionStatus(pc.iceConnectionState);
        if (pc.iceConnectionState === "connected") {
          console.log('🎉 WebRTC connection established!');
        } else if (pc.iceConnectionState === "failed") {
          console.log('❌ WebRTC connection failed');
        }
      };

      pc.onsignalingstatechange = () => {
        console.log(`Signalling state with ${targetSocketId}: ${pc.signalingState}`);
      }

      console.log('PeerConnection created for:', targetSocketId);
      return pc;
    } 
    catch (e) {
      console.error("Failed to create PeerConnection:", e);
    }
  }

  function doCall(targetSocketId) {
    console.log('Sending offer to peer');
    const pc = peerConnections[targetSocketId];
    if (!pc) {
      console.log(`no related pc for ${targetSocketId}`);
      return;
    }

    pc.createOffer(sdpConstraints)
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        socket.emit("message", {
          targetId: targetSocketId,
          message: pc.localDescription,
          room: room
        });
      })
      .catch(error => console.error('Create offer error:', error));
  }

  function doAnswer(targetSocketId) {
    console.log('Sending answer to peer.');

    const pc = peerConnections[targetSocketId];
    if (!pc) {
      console.log(`no related pc for ${targetSocketId}`);
      return;
    }

    pc.createAnswer()
      .then(answer => pc.setLocalDescription(answer))
      .then(() => {
        socket.emit("message", {
          targetId: targetSocketId,
          message: pc.localDescription,
          room: room
        });
      })
      .catch(error => console.error('Create answer error:', error));
  }

  function updateRemoteVideoDisplay() {
    // all remote stream을 하나로 합치거나 
    // 가장 최근의 stream만 표시하는 방식 선택

    if (Object.keys(peerStreams).length > 0) {
      // 가장 최근의 stream 표시
      const lastPeerId = Object.keys(peerStreams).pop();
      const stream = peerStreams[lastPeerId];
    
      console.log('Setting remote video srcObject with stream:', stream);
      console.log('Stream has video tracks:', stream.getVideoTracks().length);
      console.log('Stream has audio tracks:', stream.getAudioTracks().length);
      
      remoteVideo.srcObject = peerStreams[lastPeerId];

    } else {
      console.log('No remote streams available');
      remoteVideo.srcObject = null;
    }
  }

  // 스트림 상태 확인 함수
  function checkStreamStatus() {
    console.log('=== Stream Status ===');
    console.log('Local stream:', localStream ? '있음' : '없음');
    console.log('Local video srcObject:', document.getElementById('localVideo').srcObject);
    console.log('Remote video srcObject:', document.getElementById('remoteVideo').srcObject);
    
    if (localStream) {
      console.log('Local audio tracks:', localStream.getAudioTracks().length);
      console.log('Local video tracks:', localStream.getVideoTracks().length);
      localStream.getTracks().forEach((track, index) => {
        console.log(`Local track ${index}:`, track.kind, track.readyState, track.enabled);
      });
    }
    
    if (peerStreams) {
      Object.keys(peerStreams).forEach(peerId => {
        const stream = peerStreams[peerId];
        console.log(`Peer ${peerId} stream:`, stream.getTracks().length, 'tracks');
        stream.getTracks().forEach((track, index) => {
          console.log(`  Track ${index}:`, track.kind, track.readyState, track.enabled);
        });
      });
    }
    
    console.log('Peer connections:', Object.keys(peerConnections).length);
    console.log('Peer streams:', peerStreams ? Object.keys(peerStreams).length : 0);
  }

  // 3초마다 상태 확인
  //setInterval(checkStreamStatus, 3000);

  // 수동으로 확인할 수 있도록 전역 함수로 노출
  window.checkStreams = checkStreamStatus;

  // 비디오 재생 상태 모니터링
  function monitorVideoPlayback() {
    const videos = document.querySelectorAll('video');
    videos.forEach(video => {
      video.addEventListener('playing', function() {
        console.log(`${video.id} is playing`);
        video.classList.add('playing');
      });
      
      video.addEventListener('pause', function() {
        console.log(`${video.id} is paused`);
        video.classList.remove('playing');
      });
      
      video.addEventListener('error', function(e) {
        console.error(`${video.id} error:`, e);
      });
    });
  }

  // DOM 로드 후 모니터링 시작
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(monitorVideoPlayback, 1000);
  });

  // UI 관련 함수들
  function updateConnectionStatus(status) {
    const statusElement = document.querySelector("#connection-status") || createStatusElement();
    statusElement.textContent = `status: ${status}`;
  }

  function createStatusElement() {
    const statusEl = document.createElement('div');
    statusEl.id = "connection-status";
    statusEl.style.cssText = "position: fixed; top: 10px; right: 10px; padding: 10px; background: rgba(0,0,0,0.7); color: white;";
    document.body.appendChild(statusEl);
    return statusEl;
  }

  // later, 화면 공유 추가를 위한 준비
  function shareScreen() {
    navigator.mediaDevices.getDisplayMedia({ vide: true})
      .then(screenStream => {

      });
  }

  function toggleMute() {
    if (localStream) {
      const audioTracks = localStream.getAudioTracks();
      if (audioTracks.length > 0) {
        audioTracks[0].enabled = !audioTracks[0].enabled;
        const button = document.querySelector("#muteBtn");
        button.textContent = audioTracks[0].enabled ? 'Mute' : 'Unmute';
        button.style.background = audioTracks[0].enabled ? '' : '#ff4444';
        console.log("Audio: ", audioTracks[0].enabled ? "unmute" : "muted");
      }
    }
  }

  function toggleVideo() {
    try {
      if (localStream && localStream.getVideoTracks().length > 0) {
        const videoTrack = localStream.getVideoTracks()[0];
        videoTrack.enabled = !videoTrack.enabled;
        console.log("Video: ", videoTrack.enabled ? "enabled" : "disabled");
      }
    }
    catch (error) {
      console.error('Toggle video error:', error);
    }
  }

  // 또는 버튼 추가로 재생 시작
  function addPlayButton() {
    const playBtn = document.querySelector("#playOtherBtn");
    playBtn.textContent = 'Start Video';

    playBtn.onclick = function() {
      const videos = document.querySelectorAll('video');
      videos.forEach(video => {
        if (video.srcObject) {
          video.play()
            .then(() => console.log(`${video.id} started playing`))
            .catch(error => console.error(`${video.id} play error:`, error));
        }
      });
    };
  }

  function hangup() {
    console.log('Hanging up all connections');
    
    // all peerconnection 종료
    Object.values(peerConnections).forEach(pc => {
      pc.close();
    });
    peerConnections = {};

    // localStream 정리
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }

    // other peer(s) 에게 연결 종료 알림
    socket.emit("message", {
      targetId: "broadcast",
      message: "bye",
      room: room
    });
  }

  // 페이지 언로드 시 정리
  window.addEventListener('beforeunload', function() {
    hangup();
  });
});