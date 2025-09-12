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
// camId와 cctv 채널 매핑을 위한 추가 객체 필요
let camIdToChannelMap = {}; // camId -> channelIndex 매핑

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

let sdpConstraints = { offerToReceiveVideo: true, offerToReceiveAudio: true };

// DOMContentLoaded 이후 초기화
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
    const camId = data.camId || data.socketId;
    console.log(`New peer joined: camId=${camId}, socketId=${data.socketId}`);

    // camId 기준으로 기존 매핑 확인

    if (camIdToChannelMap.hasOwnProperty(camId)) {
      // ✅ camId 이미 등록된 경우 → 기존 peer 정리 후 새 연결 생성
      const channelIndex = camIdToChannelMap[camId];
      console.log(`CamId ${camId} is already mapped to channel ${channelIndex}`);

      const oldSocketId = cctvChannels[channelIndex].peerId;
      
      // ✅ 기존 연결이 있고 새 socketId와 다를 때만 정리
      if (oldSocketId && oldSocketId !== data.socketId && peerConnections[oldSocketId]) {
        console.log(`Cleaning up old connection for camId=${camId}, socketId=${oldSocketId}`);
        cleanupPeer(oldSocketId);
      }

      // ✅ peerConnection이 없을 때만 생성
      if (!peerConnections[data.socketId]) {
        createPeerConnection(data.socketId);
      }

      cctvChannels[channelIndex].peerId = data.socketId;
      cctvChannels[channelIndex].connected = true;
      cctvChannels[channelIndex].status.textContent = "CONNECTED";
      cctvChannels[channelIndex].status.className = "cctv-status status-connected";

      // initiator면 offer 보내기
      if (isInitiator && peerConnections[data.socketId]) {
        doCall(data.socketId);
      }
    }
    else {
      // 새 camId인 경우 채널 할당
      const channelIndex = assignCctvChannel(data.socketId, camId);

      if (channelIndex !== -1) {
        console.log(`Created new peer for camId: ${camId}, channel: ${channelIndex}`);

        // ✅ 채널 상태 명시적으로 업데이트
        cctvChannels[channelIndex].peerId = data.socketId;
        cctvChannels[channelIndex].connected = true;
        cctvChannels[channelIndex].status.textContent = "CONNECTED";
        cctvChannels[channelIndex].status.className = "cctv-status status-connected";

        // PeerConnection 생성 및 offer 전송
        if (!peerConnections[data.socketId]) {
          createPeerConnection(data.socketId);
        }
        if (isInitiator && peerConnections[data.socketId]) {
          doCall(data.socketId);
        }
      }
      else {
        console.log(`No available channels for camId: ${camId}`);
      }
    }
  });

  // peer-left event 연결 종료 알림
  socket.on("peer-left", function(data) {
    const peerId = data.socketId;
    const camId = data.comId || null;
    console.log(`Peer left: socketId=${peerId}, camId=${camId}, room=${data.room}`);

    cleanupPeer(peerId);
  });

  // ✅ camId 매핑 업데이트 함수 추가
  function updateCamIdMapping(oldCamId, newCamId) {
    if (camIdToChannelMap.hasOwnProperty(oldCamId)) {
      const channelIndex = camIdToChannelMap[oldCamId];
      camIdToChannelMap[newCamId] = channelIndex;
      delete camIdToChannelMap[oldCamId];
      console.log(`Updated camId mapping: ${oldCamId} -> ${newCamId} (channel ${channelIndex})`);
    }
  }

  // 메세지 수신 함수
  socket.on('message', function(data) {
    const camId = data.camId || data.from;
    const socketId = data.from;
    console.log(`Client received message from camId=${camId}, socket=${socketId}`);

    // camId가 변경된 경우 매핑 업데이트
    if (camIdToChannelMap.hasOwnProperty(socketId) && camId !== socketId) {
      updateCamIdMapping(socketId, camId);
    }

    // camId -> socketId 매핑 갱신
    if (camIdToChannelMap.hasOwnProperty(camId)) {
      const channelIndex = camIdToChannelMap[camId];
      if (cctvChannels[channelIndex].peerId !== socketId) {
        console.log(`Updating mapping: camId=${camId}, old=${cctvChannels[channelIndex].peerId}, new=${socketId}`);
        cctvChannels[channelIndex].peerId = socketId;        
      }
    }

    // offer를 받으면 즉시 PeerConnection 생성
    if (data.message.type === "offer" && !peerConnections[data.from]) {
      console.log('Creating PeerConnection for offer from:', data.from);
      createPeerConnection(data.from);

      // ✅ 여기서도 camId 매핑 확인 및 업데이트 필요
      const camId = data.camId || data.from;
      if (camId !== data.from && camIdToChannelMap.hasOwnProperty(camId)) {
        const channelIndex = camIdToChannelMap[camId];
        cctvChannels[channelIndex].peerId = data.from;
      }
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
      // coturn 만 동작하도록 하는 경우 relay 추가 해야 함.
      // pcConfig.iceTransportPolicy = 'relay';

      pcConfig.iceServers.push(...turnServers);

      console.log('TURN servers added to config:', pcConfig.iceServers);

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
  // 기존 peer cleanup
  function cleanupPeer(peerId) {
    const pc = peerConnections[peerId];

    if (pc) {
      console.log(`Cleaning up peer: ${peerId}`);
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.close();

      delete peerConnections[peerId];
    }
    else {
      console.log(`> No PeerConnection found for ${peerId} to clean up.`);
    }

    // 2. CCTV channel 해제
    releaseCctvChannel(peerId);

    // 3. peerStreams에서도 제거
    if (peerStreams && peerStreams[peerId]) {
      console.log(`> Removing stream reference for ${peerId} from peerStreams`);
      delete peerStreams[peerId];
    }
    else {
      console.log(`> No stream found for ${peerId} in peerStreams.`);
    }

    console.log(`Finished cleanup for peer: ${peerId}`);
  }
  // PeerConnection 생성
  function createPeerConnection(socketId) {
    // ✅ 이미 존재하는지 확인
    if (peerConnections[socketId]) {
      console.log(`PeerConnection for ${socketId} already exists`);
      return peerConnections[socketId];
    }

    try {
      const pc = new RTCPeerConnection(pcConfig);
      peerConnections[socketId] = pc;

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('Candidate type:', event.candidate.type, 
            event.candidate.protocol, event.candidate.address);

            // relay candidate가 있는지 확인
          if (event.candidate.type === 'relay') {
            console.log('✅ TURN server is being used!');
          }

          socket.emit("message", {
            targetId: socketId,
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
        console.log(`Remote stream received from ${socketId}`);
        
        // 각 peer별로 stream 저장
        if(!peerStreams) {
          peerStreams = {};
        }
        const stream = event.streams[0];
        if (!peerStreams[socketId]) {
          peerStreams[socketId] = stream;

          // ✅ 이미 할당된 채널 찾기 (camId 또는 socketId로)
          let channelIndex = -1;
          
          // 1. camId로 먼저 찾기
          for (const [camId, chanIdx] of Object.entries(camIdToChannelMap)) {
            if (cctvChannels[chanIdx].peerId === socketId) {
              channelIndex = chanIdx;
              break;
            }
          }
          
          // 2. 없으면 socketId로 임시 매핑된 것 찾기
          if (channelIndex === -1 && camIdToChannelMap.hasOwnProperty(socketId)) {
            channelIndex = camIdToChannelMap[socketId];
          }
          
          // 3. 그래도 없으면 새로 할당 (임시로 socketId 사용)
          if (channelIndex === -1) {
            channelIndex = assignCctvChannel(socketId, socketId);
          }
          
          if (channelIndex !== -1) {
            updateCctvVideoDisplay(socketId, event.streams[0]);
          }
        }
        else {
          console.log(`duplicated track ignore for ${socketId}`);
        }

      };

      pc.oniceconnectionstatechange = () => {
        console.log(`ICE state with ${socketId}: ${pc.iceConnectionState}`);
        updateConnectionStatus(pc.iceConnectionState);

        if (pc.iceConnectionState === "connected") {
          console.log('🎉 WebRTC connection established!');
        } else if (pc.iceConnectionState === "failed") {
          console.log('❌ WebRTC connection failed');
        }
      };

      pc.onsignalingstatechange = () => {
        console.log(`Signalling state with ${socketId}: ${pc.signalingState}`);
      }

      console.log('PeerConnection created for:', socketId);
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

  // ✅ 서버에게도 cleanup-cam 전송 (dummy-camera stop/start와 동일한 흐름)
  socket.emit("cleanup-cam", {
    room: room,
    camId: null   // 모니터링은 camId 대신 room 전체 기준 정리
  });

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
function assignCctvChannel(peerId, camId = null) {
  //사용 가능한 CCTV channel 찾기
  for (let i=1; i <= 9; i++) {
    if(!cctvChannels[i].connected) {
      cctvChannels[i].connected = true;
      cctvChannels[i].peerId = peerId;
      cctvChannels[i].status.textContent = "CONNECTED";
      cctvChannels[i].status.className = "cctv-status status-connected"
      activeCctvCount++;

      // camId 매핑 저장
      if (camId) {
        camIdToChannelMap[camId] = i;
      }

      console.log(`Assigned CCTV channel ${i} to peer ${peerId}${camId ? ` (camId: ${camId})` : ''}`);
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
      if (cctvChannels[i].element) {
        cctvChannels[i].element.srcObject = null;
      }
      cctvChannels[i].status.textContent = "DISCONNECTED";
      cctvChannels[i].status.className = "cctv-status status-disconnected"
      activeCctvCount--;

      // camId 매핑에서도 제거
      for (const [camId, channelIndex] of Object.entries(camIdToChannelMap)) {
        if (channelIndex === i) {
          delete camIdToChannelMap[camId];
          break;
        }
      }

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
      
      // ✅ 이미 재생 중인지 확인
      if (cctvChannels[i].element.paused) {
        cctvChannels[i].element.muted = true; // 자동재생 정책 회피
        cctvChannels[i].element.play()
          .then(() => console.log(`CCTV ${i} started playing`))
          .catch(error => console.error(`CCTV ${i} play error:`, error));
      }
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

  // camId 매핑도 초기화
  camIdToChannelMap = {};

  // 서버에 재연결 요청
  socket.emit('create or join', room);
  // room 정보 다시 요청해서 offer/answer trigger
  socket.emit("getRoomInfo", {room: room}, (data) => {
    console.log("🔄 Refreshed Room info:", data);

    isInitiator = data.isInitiator;

    data.clients.forEach(clientId => {
      if (isInitiator && clientId !== socket.id) {
        console.log(`reconnecting to peer: ${clientId}`);

        createPeerConnection(clientId);
        doCall(clientId);
      }
    });
  });
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