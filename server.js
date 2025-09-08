const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  cors: {
    origin: "*", // 모s든 domain 에서 acces 허용
    methods: ["GET", "POST"],
    credentials: true
  }
});
const path = require("path");

// static file 서빙(window client에서 js, css file 접근 가능하도록)
app.use(express.static(path.join(__dirname)));

// CORS 미들웨어 header path (추가 보안)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// TURN server proxy endpoint (fetch 사용)
app.get("/api/turn-server", async (req, res) => {
  try {
    // 외부 TURN server 대신 coturn server 정보 반환
    const turnServer = {
      username: "your-username",
      credential: "your-password",
      urls: "turn:your-coturn-server-ip:3478"
    };

    res.json(turnServer);
  }
  catch (error) {
    console.error(`TURN server error: ${error}`);
  }
});

// coturn server 자격증명 생성 endpoint (시간 기반)
app.get("/api/turn-credentials", (req, res) => {
  const crypto = require("crypto");

  // coturn에서 사용하는 시간 기반 자격 증명 생성
  const generateTurnCredentials = () => {
    const timestamp = Math.floor(Date.now() / 1000) + 24 *3600 // 24 시간 유효

    // realm을 ip 주소로 사용 
    // -> 추후 /etc/turnserver.cong 에서 domain이 있으면 변경 or ip을 넣어주어야 하고 아래 realm을 지움.
    const realm = "112.169.164.202";
    const username = `${timestamp}:your-username`;
    const secret = "your-super-secure-very-log-random-key-1245673456abcdef1234641234abcdefse";
    
    const hmac = crypto.createHmac("sha1", secret);
    hmac.update(username);
    const password = hmac.digest("base64");
    
    return {
      username, 
      credential:password,
      urls: [
        `turn:${realm}:3478?transport=udp`,
        `turn:${realm}:3478?transport=tcp`
      ]
    };
  };

  const credentials = generateTurnCredentials();
  res.json(credentials);
});

// 기본 경로
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// room 관리 객체
const roomManager = {
  rooms: new Map(),

  getRoom(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        clients: new Set(),
        maxClients: 10
      });
    }
    return this.rooms.get(roomId);
  },

  addClient(roomId, socketId) {
    const room = this.getRoom(roomId);
    room.clients.add(socketId);
    return room.clients.size;
  },

  removeClient(roomId, socketId) {
    const room = this.getRoom(roomId);
    room.clients.delete(socketId);
    if (room.clients.size === 0) {
      this.rooms.delete(roomId); // 빈 방 정리
    }
    return room.clients.size;
  },

  getClientCount(roomId) {
    const room = this.rooms.get(roomId);
    return room ? room.clients.size : 0;
  }
};

// socket.io 연결 처리
io.on("connection", (socket) => {
  console.log(`client connected from: ${socket.handshake.headers.origin}`);

  socket.on("create or join", (room) => {
    console.log(`Socket ${socket.id} attempting to join room: ${room}`);

    const currentCount = roomManager.getClientCount(room);
    const roomInfo = roomManager.getRoom(room);

    console.log(`Room ${room} has ${currentCount}/${roomInfo.maxClients} clients`);

    if (currentCount >= roomInfo.maxClients) {
      // 방이 가득 찼을때
      socket.emit("full", room);
      console.log(`Room ${room} is full, rejecting ${socket.id}`);
      return;
    }

    // 방에 참가
    const newCount = roomManager.addClient(room, socket.id);
    socket.join(room);

    // 기존 client들에게 new peer 알림
    socket.to(room).emit("peer-joined", {
      socketId: socket.id,
      room: room,
      totalClients: newCount
    });

    const roomClients = Array.from(roomInfo.clients).filter(id => id !== socket.id);
    socket.emit("room-info", {
      room: room,
      clients: roomClients,
      totalClients: newCount,
      isInitiator: currentCount === 0
    });


    if (currentCount === 0) {
      socket.emit("created", room);
      console.log(`Room ${room} created by ${socket.id}`);
    }
    else {
      socket.emit("joined", room);
      console.log(`Socket ${socket.id} joined room ${room}`);
    }

    console.log(`Room ${room} now has ${newCount} client(s)`);
  });

  socket.on("message", (data) => {
    const { targetId, message} = data;

    console.log(`Message from ${socket.id} to ${targetId}:`, message);
    
    if (targetId === "broadcast") {
      // 방 전체 broadcast
      socket.to(data.room).emit("message", {
        from: socket.id,
        message: message
      });
    }
    else {
      // 특정 client에게 전송
      socket.to(targetId).emit("message", {
        from: socket.id,
        message: message
      });
    }
  });

  socket.on("disconnect", (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);

    // 모든 방에서 client 제거
    roomManager.rooms.forEach((roomInfo, roomId) => {
      if (roomInfo.clients.has(socket.id)) {
        const remainingCount = roomManager.removeClient(roomId, socket.id);

        // 남은 client(s)에게 연결 종료 알림
        socket.to(roomId).emit("peer-left", {
          socketId: socket.id,
          room: roomId,
          totalClients: remainingCount
        });
        console.log(`Socket ${socket.id} removed from room ${roomId}, ${remainingCount} clients remain`);
      }
    });
  });

  // ICE candidate 교환
  socket.on("ice-candidate", (data) => {
    const { targetId, candidate} = data;
    socket.to(targetId).emit("ice-candidate", {
      from: socket.id,
      candidate: candidate
    });
  });

  socket.on("offer", (data) => {
    const { targetId, offer } = data;
    socket.to(targetId).emit("offer", {
      from: socket.id,
      offer: offer
    });
  });

  socket.on("answer", (data) => {
    const { targetId, answer } = data;
    socket.to(targetId).emit("answer", {
      from: socket.id,
      answer: answer
    });
  });
});

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0"; // 모든 network interface에서 listen

http.listen(PORT, HOST, () => {
  console.log(`server running on: 
                - local: http://localhost:${PORT}
                - network: http://${getLocalIpAddress()}:${PORT}`);
});

// local ip address 가져오기 함수
function getLocalIpAddress() {
  const interfaces = require("os").networkInterfaces();
  for (const interfaceName in interfaces) {
    for (const iface of interfaces[interfaceName]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}