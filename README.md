# Mediasoup SFU - RMM (Remote Meeting Manager)

A production-minded, TypeScript-based Selective Forwarding Unit (SFU) using mediasoup with room-based invite links and participant management.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser Clients                           │
│  (mediasoup-client + Socket.IO)                              │
└─────────────────────────────────────────────────────────────┘
                           │
                    WebRTC + Signaling
                           │
┌─────────────────────────────────────────────────────────────┐
│                    Node.js Server                            │
│  ┌─────────────────────────────────────────────────────────┐
│  │  Express + Socket.IO (Signaling)                        │
│  │  - Room management                                       │
│  │  - Invite token generation (JWT)                        │
│  │  - Participant tracking                                 │
│  └─────────────────────────────────────────────────────────┘
│  ┌─────────────────────────────────────────────────────────┐
│  │  Mediasoup Service                                      │
│  │  - Worker pool (4 workers, 1 per CPU core)             │
│  │  - Router per room                                      │
│  │  - WebRTC transports, producers, consumers             │
│  │  - RTP/UDP media forwarding                            │
│  └─────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────┘
```

## Features

✅ **Multi-room support** - Multiple concurrent rooms with isolated routers  
✅ **Invite system** - JWT-based token invites with shareable links  
✅ **Participant management** - Display active participants, audio/video status  
✅ **Simple UI** - HTML5 grid layout for video feeds, participant sidebar  
✅ **Scalable workers** - Multiple mediasoup workers for CPU load distribution  
✅ **Type-safe** - Full TypeScript implementation  
✅ **Production patterns** - Error handling, graceful shutdown, worker restart

## Installation

### Prerequisites

- **Node.js** 14+
- **npm** or **yarn**
- For TURN: Install **coturn** (optional, for NAT traversal)

### Setup

```bash
# Install dependencies
npm install

# Create environment file
cp .env.example .env

# Update PUBLIC_IP in .env to your server's public IP
# For development: PUBLIC_IP=127.0.0.1

# Build TypeScript
npm run build

# Start server (with ts-node in dev)
npm run dev

# Or in production
npm start
```

The server runs on `http://localhost:3000` by default.

## API Endpoints

### REST API

#### Create a new room

```http
POST /api/rooms
Content-Type: application/json

{ "hostName": "Alice" }

Response:
{
  "roomId": "room-1702156800000",
  "inviteLink": "http://localhost:3000/join?room=room-1702156800000&token=eyJ...",
  "hostName": "Alice"
}
```

#### Get room info

```http
GET /api/rooms/:roomId

Response:
{
  "roomId": "room-123",
  "hostName": "Alice",
  "participantCount": 3,
  "createdAt": "2024-12-09T10:00:00Z"
}
```

#### Get room participants

```http
GET /api/rooms/:roomId/participants

Response:
{
  "participants": [
    {
      "id": "socket-1",
      "displayName": "Alice",
      "hasAudio": true,
      "hasVideo": true
    },
    {
      "id": "socket-2",
      "displayName": "Bob",
      "hasAudio": true,
      "hasVideo": false
    }
  ]
}
```

### Socket.IO Events

#### Client → Server

- **join** - Join a room (emits device RTP capabilities, receives router capabilities + existing producers)
- **createTransport** - Request a WebRTC transport creation
- **connectTransport** - Connect transport with DTLS parameters
- **produce** - Send media (audio/video) with RTP parameters
- **consume** - Request to receive media from a producer
- **resumeConsumer** - Resume a paused consumer

#### Server → Client

- **peerJoined** - Notification when a peer joins the room
- **peerLeft** - Notification when a peer leaves
- **newProducer** - Announcement of a new producer (audio/video from another peer)

## UI Usage

### Landing Page

- **Create New Room** - Host creates a room, gets an invite link
- **Join Room** - Guest joins via room ID or invite link

### Room View

- **Video grid** - Local video (top-left) + remote videos
- **Sidebar** - Invite link (copy button), participant list with media status
- **Controls** - Toggle audio/video, leave room

### Invite Flow

1. Host creates room → receives invite link
2. Host shares link with guests
3. Guests click link → auto-fills room ID in join modal
4. Guests enter name and join
5. All peers exchange media via SFU

## Configuration

### Environment Variables (`.env`)

```env
PORT=3000                                  # Server port
PUBLIC_IP=127.0.0.1                       # Public IP announced to peers (CRITICAL)
JWT_SECRET=your-secret-key-change         # Secret for invite tokens
```

**Important:** Set `PUBLIC_IP` to your server's actual public IP in production, or behind a load balancer. If incorrect, remote peers cannot connect (ICE failure).

## Scaling & Deployment

### Single Machine

- Mediasoup automatically creates N workers (1 per CPU core, max 4)
- Each worker handles multiple rooms
- Suitable for ~50–200 concurrent participants across multiple rooms

### Multiple Machines

**Option 1: Stateless Signaling + Redis**

1. Run multiple signaling nodes (Node.js)
2. Store room → router node mapping in Redis
3. When client connects, lookup which node hosts their room
4. Signaling nodes forward messages between clients

**Option 2: SFU Cluster**

1. Keep one SFU per room (simple sharding)
2. Use DNS round-robin or load balancer to distribute room creation
3. More isolation, but needs per-room routing

### Docker Deployment

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN npm run build
EXPOSE 3000
ENV PUBLIC_IP=your-public-ip
CMD ["npm", "start"]
```

Run with:

```bash
docker run -e PUBLIC_IP=your-ip -p 3000:3000 mediasoup-sfu
```

### Kubernetes

Mediasoup requires UDP ports for RTP. Expose via:

- **NodePort** - Direct UDP to worker nodes
- **LoadBalancer** with UDP support (AWS NLB, GCP UDP LB)

## Common Pitfalls

### 1. **"cannot consume" error**

- **Cause:** Device RTP capabilities mismatch
- **Fix:** Ensure client calls `device.load(routerRtpCapabilities)` after join

### 2. **Remote peers can't connect**

- **Cause:** Incorrect `PUBLIC_IP`
- **Fix:** Set `PUBLIC_IP` env var to actual public IP or LB IP

### 3. **NAT/Firewall issues**

- **Solution:** Deploy TURN server (coturn) and configure ICE servers in client
- **Edit `client.js`:** Add `iceServers` to Socket.IO config

### 4. **High CPU usage**

- **Cause:** Too many RTP forwarding operations or transcoding
- **Fix:** Reduce room size, use selective forwarding, increase workers

### 5. **Memory leaks**

- **Cause:** Unclosed transports/producers/consumers
- **Fix:** Ensure cleanup on disconnect (code already does this)

## Monitoring & Debugging

### Logs

Enable verbose logging by setting `WORKER_LOG_LEVEL`:

```bash
LOG_LEVEL=debug npm run dev
```

**Key log patterns:**

- `[ROOM]` - Room lifecycle events
- `[SOCKET]` - Socket connection/disconnection
- `[TRANSPORT]` - Transport creation/connection
- `[PRODUCE]` - Producer creation
- `[CONSUME]` - Consumer creation

### Metrics (Future Enhancement)

Add Prometheus metrics:

```typescript
// In mediasoupService.ts
const workerStats = await worker.getResourceUsage();
console.log(
  `Worker CPU: ${workerStats.ru_utime}, Memory: ${workerStats.ru_maxrss}`
);
```

### Browser DevTools

Check **WebRTC statistics** in Chrome DevTools → WebRTC in chrome://webrtc-internals

## Performance Notes

- **Bitrate:** Default 1 Mbps per peer (set in `createWebRtcTransport`)
- **Codec:** VP8 (video) + Opus (audio)
- **Latency:** ~100–200ms (depends on network)
- **Max peers per room:** ~20–50 (SFU, not peer-to-peer)

## Next Steps

### Add Features

1. **Screen sharing** - Additional producer with screen media
2. **Recording** - Create PlainRtpTransport + pipe to FFmpeg
3. **Simulcast** - Send multiple quality layers from producer
4. **Selective forwarding** - Forward only high-bitrate sources
5. **Chat** - Add text messaging via Socket.IO

### Production Hardening

1. **Authentication** - Require login before creating rooms
2. **Rate limiting** - Limit room creation per user
3. **TLS/HTTPS** - Enable in `server.ts` with cert/key paths
4. **Bandwidth management** - Set per-peer bitrate limits
5. **Monitoring** - Integrate Prometheus + Grafana

### Scale to 1000+ participants

Use Redis pub/sub + multiple SFU nodes, or convert to livestream mode (RTMP + CDN).

## Troubleshooting

### "Worker died" error

```
Solution: Check system resources (disk space, file descriptors)
ulimit -n 65536  # Increase file descriptor limit
```

### Ports in use

```bash
# Kill process on port 3000
npx kill-port 3000
```

### Permissions denied

```bash
# May need sudo if binding ports < 1024
sudo PORT=80 npm start
```

## References

- [mediasoup Docs](https://mediasoup.org/)
- [Socket.IO](https://socket.io/)
- [WebRTC Concepts](https://webrtc.org/)
- [TURN Server Setup (coturn)](https://github.com/coturn/coturn)

## License

ISC

---

**Built with ❤️ using mediasoup, Node.js, and TypeScript**
#   O p e n - s t r e a m  
 