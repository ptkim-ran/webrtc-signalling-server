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

let cctvChannels = {};
let activeCctvCount = 0;

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

  // CCTV grid 초기화
  initializeCctvGrid();

  // button event listener 설정
  document.querySelector("#refreshBtn").addEventListener("click", refreshAllStreams);
  document.querySelector("#fullscreenBtn").addEventListener("click", toggleFullscreen)

  // 방 이름 고정 (CCTV 모니터링용)
  room = "cctv-monitoring-room";

  // TURN 서버 credentials 요청 (local이 아닐 경우)
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    requestTurnCredentials().then(() => {
      // TURN 서버 설정 후에 서버에 연결
      socket.emit('create or join', room);
      console.log('Connecting to CCTV monitoring room', room);
    })
  } 
  else {
    turnReady = true;
    console.log('Local development, using STUN only');
    // STUN만 사용할 경우 바로 연결
    socket.emit('create or join', room);
    console.log('Connecting to CCTV monitoring room', room);
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

  // peer-left event 연결 종료 알림
  socket.on("peer-left", function(data) {
    const peerId = data.socketId;
    console.log(`Peer left:`, data);

    if (peerConnections[peerId]) {
      peerConnections[peerId].close();
      delete peerConnections[peerId];
    }

    // CCTV channel 해제
    releaseCctvChannel(data.socketId);

    // stream 도 제거
    if (peerStreams && peerStreams[peerId]) {
      delete peerStreams[data.socketId];
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
          urls: turnConfig.urls,
          username: turnConfig.username,
          credential: turnConfig.credential
        }
      ];

      pcConfig.iceServers.push(...turnServers);

      console.log('TURN servers added to config:', pcConfig.iceServers);

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
      return true;
    }
    catch (error) {
      console.warn(`TURN server setup failed, using STUN only: ${error}`);
      turnReady = true;
      return false;
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
        
        // 각 peer별로 stream 저장
        if(!peerStreams) {
          peerStreams = {};
        }
        const stream = event.streams[0];
        if (!peerStreams[targetSocketId]) {
          peerStreams[targetSocketId] = stream;
          // CCTV channel 에 할담 및 표시
          const channel = assignCctvChannel(targetSocketId);
          if (channel !== -1) {
            updateCctvVideoDisplay(targetSocketId, event.streams[0]);
          }
        }
        else {
          console.log(`duplicated track ignore for ${targetSocketId}`);
        }

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

  // 스트림 상태 확인 함수
  function checkStreamStatus() {
    console.log('=== Stream Status ===');
    
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

  function hangup() {
    console.log('Hanging up all connections');
    
    // all peerconnection 종료
    Object.values(peerConnections).forEach(pc => {
      pc.close();
    });
    peerConnections = {};

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

// CCTV grid 초기화 함수
function initializeCctvGrid() {
  const grid = document.querySelector("#cctvGrid");
  grid.innerHTML = "";

  // CCTV channel 생성
  for (let i = 1; i <= 9; i++) {
    const cctvContainer = document.createElement("div");
    cctvContainer.className = "cctv-container";
    cctvContainer.id = `cctv-${i}`;

    const cctvLabel = document.createElement("div");
    cctvLabel.className = "cctv-label";
    cctvLabel.textContent = `Camera ${i}`;

    const cctvVideo = document.createElement("video");
    cctvVideo.id = `cctvVideo-${i}`;
    cctvVideo.autoplay = true;
    cctvVideo.playsInline = true;
    cctvVideo.muted = true; // for some browser policy, audio will be muted for play. 
    cctvVideo.style.width = "100%";
    cctvVideo.style.height = "100%";

    const cctvStatus = document.createElement("div");
    cctvStatus.className = "cctv-status status-disconnected";
    cctvStatus.id = `cctvStatus-${i}`;
    cctvStatus.textContent = "DISCONNECTED";

    cctvContainer.appendChild(cctvVideo);
    cctvContainer.appendChild(cctvLabel);
    cctvContainer.appendChild(cctvStatus);
    grid.appendChild(cctvContainer);

    // CCTV channel information 저장
    cctvChannels[i] = {
      element: cctvVideo,
      status: cctvStatus,
      connected: false,
      peerId: null
    };
  }
}

// peer 연결시 CCTV channel 할당
function assignCctvChannel(peerId) {
  //사용 가능한 CCTV channel 찾기
  for (let i=1; i <= 9; i++) {
    if(!cctvChannels[i].connected) {
      cctvChannels[i].connected = true;
      cctvChannels[i].peerId = peerId;
      cctvChannels[i].status.textContent = "CONNECTED";
      cctvChannels[i].status.className = "cctv-status status-connected"
      activeCctvCount++;
      console.log(`Assigned CCTV channel ${i} to peer ${peerId}`);
      return i;
    }
  }

  console.log("no available CCTV channels");
  return -1;
}

// peer 연결 해제시 CCTV channel 해제
function releaseCctvChannel(peerId) {
  //released CCTV channel 찾기
  for (let i=1; i <= 9; i++) {
    if(cctvChannels[i].peerId === peerId) {
      cctvChannels[i].connected = false;
      cctvChannels[i].peerId = null;
      cctvChannels[i].element.srcObject = null;
      cctvChannels[i].status.textContent = "DISCONNECTED";
      cctvChannels[i].status.className = "cctv-status status-disconnected"
      activeCctvCount--;
      console.log(`Released CCTV channel ${i} from peer ${peerId}`);
      return ;
    }
  }
}

// 원격 video 표시 update (CCTV 전용)
function updateCctvVideoDisplay(peerId, stream) {

  for (let i=1; i <= 9; i++) {
    if(cctvChannels[i].peerId === peerId) {
      console.log(`updating CCTV channel ${i} with stream from peer ${peerId}`);
      if (cctvChannels[i].element.srcObject !== stream) {
        cctvChannels[i].element.srcObject = stream;
      }
      
      cctvChannels[i].element.muted = true; // 자동재생 정책 회피
      cctvChannels[i].element.play()
        .then(() => console.log(`CCTV ${i} started playing`))
        .catch(error => console.error(`CCTV ${i} play error:`, error));
      cctvChannels[i].status.className = "cctv-status status-connected"
      cctvChannels[i].status.textContent = "CONNECTED"

      return ;
    }
  }
}

// all stream update
function refreshAllStreams() {
  console.log("refreshing all CCTV streams");

  Object.values(peerConnections).forEach(pc => {
    pc.close();
  });

  peerConnections = {};
  peerStreams = {};

  // 모든 CCTV 채널 상태 초기화
  for (let i = 1; i <= 9; i++) {
    cctvChannels[i].connected = false;
    cctvChannels[i].peerId = null;
    cctvChannels[i].element.srcObject = null;
    cctvChannels[i].status.textContent = 'DISCONNECTED';
    cctvChannels[i].status.className = 'cctv-status status-disconnected';
  }

  activeCctvCount = 0;
  
  // 서버에 재연결 요청
  socket.emit('create or join', room);
}

// 전체 화면 전환
function toggleFullscreen() {
  const elem = document.documentElement;

  if (!document.fullscreenElement) {
    if (elem.requestFullscreen) {
      elem.requestFullscreen();
    }
    else if (elem.webkitRequestFullscreen) {
      elem.webkitRequestFullscreen();
    } 
    else if (elem.msRequestFullscreen) {
      elem.msRequestFullscreen();
    }
  }
  else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } 
    else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } 
    else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    }
  }
}