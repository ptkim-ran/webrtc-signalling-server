# Dummy CCTV Media Server / Publisher

## Option A) Browser-based dummy camera (easiest)
1) Start your existing signaling server (server.js).
2) Open this URL in Chrome: /public/dummy-camera.html (serve it from the same host/port as server.js).
3) Click "시뮬레이터 시작". A synthetic video + silent audio stream will be published into room `cctv-monitoring-room`.

## Option B) Node.js headless publisher (advanced)
Requires Node 18+. Install deps, then run:

```bash
npm i wrtc socket.io-client minimist
node dummy_publisher_node.js --count 1 --fps 30 --size 1280x720
```

The script connects to `http://localhost:3000` by default. Override with `SIGNAL_URL` env if needed.

Both options speak the same Socket.IO signalling protocol your client uses.
