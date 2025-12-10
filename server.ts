import express, { Express, Request, Response } from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { mediasoupService } from "./src/mediasoup/mediasoupService";
import { Room } from "./src/mediasoup/room";
import { inviteManager } from "./src/mediasoup/inviteManager";
import type { Peer } from "./src/types/index";

dotenv.config();

const app: Express = express();
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: { origin: "*" },
});

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const frontendDistPath = path.join(__dirname, "../frontend/dist");
app.use(express.static(frontendDistPath));

const rooms = new Map<string, Room>();

async function ensureRoom(
  roomId: string,
  hostSocketId: string,
  hostName: string = "Host"
): Promise<Room> {
  let room = rooms.get(roomId);
  if (!room) {
    room = await Room.create(roomId, hostSocketId);
    rooms.set(roomId, room);
    inviteManager.createRoomSession(roomId, hostSocketId, hostName);
    console.log(`[ROOM] Created new room: ${roomId}`);
  }
  return room;
}

app.post("/api/rooms", async (req: Request, res: Response) => {
  try {
    const { hostName = "Host" } = req.body;
    const roomId = `room-${Date.now()}`;
    const inviteLink = inviteManager.generateInviteLink(roomId);

    res.json({
      roomId,
      inviteLink,
      hostName,
    });
  } catch (error) {
    console.error("Error creating room:", error);
    res.status(500).json({ error: "Failed to create room" });
  }
});

app.get("/api/rooms/:roomId", (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;
    const room = rooms.get(roomId);
    const session = inviteManager.getRoomSession(roomId);

    if (!room || !session) {
      return res.status(404).json({ error: "Room not found" });
    }

    res.json({
      roomId,
      hostName: session.hostName,
      participantCount: room.getPeerCount(),
      createdAt: session.createdAt,
    });
  } catch (error) {
    console.error("Error getting room info:", error);
    res.status(500).json({ error: "Failed to get room info" });
  }
});

app.get("/api/rooms/:roomId/participants", (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;
    const room = rooms.get(roomId);

    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    const participants = Array.from(room.peers.values()).map((peer) => ({
      id: peer.id,
      displayName: peer.displayName,
      hasAudio: Array.from(peer.producers.values()).some(
        (p) => p.kind === "audio"
      ),
      hasVideo: Array.from(peer.producers.values()).some(
        (p) => p.kind === "video"
      ),
    }));

    res.json({ participants });
  } catch (error) {
    console.error("Error getting participants:", error);
    res.status(500).json({ error: "Failed to get participants" });
  }
});

io.on("connection", (socket) => {
  console.log(`[SOCKET] Client connected: ${socket.id}`);

  socket.on(
    "join",
    async (
      data: {
        roomId: string;
        displayName: string;
        rtpCapabilities: any;
        inviteToken?: string;
      },
      callback
    ) => {
      try {
        const { roomId, displayName, rtpCapabilities, inviteToken } = data;

        if (inviteToken) {
          const validation = inviteManager.verifyInviteToken(inviteToken);
          if (!validation.valid || validation.roomId !== roomId) {
            return callback({ error: "Invalid invite token" });
          }
        }

        const room = await ensureRoom(roomId, socket.id, displayName);
        room.addPeer(socket.id, displayName);
        const peer = room.getPeer(socket.id);
        peer!.rtpCapabilities = rtpCapabilities;

        socket.join(roomId);

        socket.to(roomId).emit("peerJoined", {
          peerId: socket.id,
          displayName,
        });

        // Send ALL producers (both audio and video) to new peer
        const allProducers = room.getAllProducersForPeer(socket.id);

        callback({
          rtpCapabilitiesRouter: room.getRtpCapabilities(),
          existingProducers: allProducers,
          participants: Array.from(room.peers.values()).map((p) => ({
            id: p.id,
            displayName: p.displayName,
          })),
        });

        console.log(
          `[ROOM ${roomId}] ${displayName} joined (total: ${room.getPeerCount()}), sending ${
            allProducers.length
          } existing producers`
        );
      } catch (error) {
        console.error("[JOIN] Error:", error);
        callback({ error: "Failed to join room" });
      }
    }
  );

  socket.on(
    "createTransport",
    async (data: { roomId: string; kind?: "send" | "recv" }, callback) => {
      try {
        const { roomId, kind = "send" } = data;
        const room = rooms.get(roomId);

        if (!room) {
          return callback({ error: "Room not found" });
        }

        const peer = room.getPeer(socket.id);
        if (!peer) {
          return callback({ error: "Peer not found" });
        }

        let transport;

        if (kind === "send") {
          if (!peer.sendTransport) {
            peer.sendTransport = await room.createWebRtcTransport();
            console.log(`[TRANSPORT] Created SEND transport for ${socket.id}`);
          }
          transport = peer.sendTransport;
        } else {
          if (!peer.recvTransport) {
            peer.recvTransport = await room.createWebRtcTransport();
            console.log(`[TRANSPORT] Created RECV transport for ${socket.id}`);
          }
          transport = peer.recvTransport;
        }

        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });

        console.log(
          `[TRANSPORT] ${kind.toUpperCase()} transport ${transport.id} for ${
            socket.id
          }`
        );
      } catch (error) {
        console.error("[CREATE_TRANSPORT] Error:", error);
        callback({ error: "Failed to create transport" });
      }
    }
  );

  socket.on(
    "connectTransport",
    async (
      data: { roomId: string; transportId: string; dtlsParameters: any },
      callback
    ) => {
      try {
        const { roomId, transportId, dtlsParameters } = data;
        const room = rooms.get(roomId);

        if (!room) {
          return callback({ error: "Room not found" });
        }

        const peer = room.getPeer(socket.id);
        if (!peer) {
          return callback({ error: "Peer not found" });
        }

        let transport = peer.sendTransport;
        if (transport?.id !== transportId) {
          transport = peer.recvTransport;
        }

        if (!transport || transport.id !== transportId) {
          return callback({ error: "Transport not found" });
        }

        await transport.connect({ dtlsParameters });
        callback({ connected: true });

        console.log(`[DTLS] Connected for ${socket.id}`);
      } catch (error) {
        console.error("[CONNECT_TRANSPORT] Error:", error);
        callback({ error: "Failed to connect transport" });
      }
    }
  );

  socket.on(
    "produce",
    async (
      data: {
        roomId: string;
        transportId: string;
        kind: "audio" | "video";
        rtpParameters: any;
      },
      callback
    ) => {
      try {
        const { roomId, transportId, kind, rtpParameters } = data;
        const room = rooms.get(roomId);

        if (!room) {
          return callback({ error: "Room not found" });
        }

        const peer = room.getPeer(socket.id);
        if (!peer) {
          return callback({ error: "Peer not found" });
        }

        const transport = peer.sendTransport;
        if (!transport || transport.id !== transportId) {
          return callback({ error: "Send transport not found" });
        }

        const producer = await transport.produce({ kind, rtpParameters });
        peer.producers.set(producer.id, producer);

        // Emit newProducer event for both audio and video producers
        socket.to(roomId).emit("newProducer", {
          producerId: producer.id,
          producerSocketId: socket.id,
          kind,
          producerDisplayName: peer.displayName,
        });

        callback({ id: producer.id });

        console.log(
          `[PRODUCE] ${socket.id} produced ${kind} in room ${roomId}`
        );
      } catch (error) {
        console.error("[PRODUCE] Error:", error);
        callback({ error: "Failed to produce" });
      }
    }
  );

  socket.on(
    "consume",
    async (
      data: { roomId: string; producerId: string; rtpCapabilities: any },
      callback
    ) => {
      try {
        const { roomId, producerId, rtpCapabilities } = data;
        const room = rooms.get(roomId);

        if (!room) {
          return callback({ error: "Room not found" });
        }

        const peer = room.getPeer(socket.id);
        if (!peer) {
          return callback({ error: "Peer not found" });
        }

        if (!room.router.canConsume({ producerId, rtpCapabilities })) {
          return callback({ error: "Cannot consume" });
        }

        if (!peer.recvTransport) {
          peer.recvTransport = await room.createWebRtcTransport();
          console.log(`[TRANSPORT] Created RECV transport for ${socket.id}`);
        }

        const transport = peer.recvTransport;

        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: false,
        });

        // Store consumer
        if (!peer.consumers) peer.consumers = new Map();
        peer.consumers.set(consumer.id, consumer);

        callback({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          transportId: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });

        console.log(
          `[CONSUME] ${socket.id} consuming ${consumer.kind} from ${producerId}`
        );
      } catch (error) {
        console.error("[CONSUME] Error:", error);
        callback({ error: "Failed to consume" });
      }
    }
  );

  /**
   * Resume consumer
   */
  socket.on(
    "resumeConsumer",
    async (data: { roomId: string; consumerId: string }, callback) => {
      try {
        const { roomId, consumerId } = data;
        const room = rooms.get(roomId);

        if (!room) {
          return callback({ error: "Room not found" });
        }

        const peer = room.getPeer(socket.id);
        if (!peer) {
          return callback({ error: "Peer not found" });
        }

        // Note: In this simple implementation, we'd need to store consumers
        // For now, just confirm
        callback({ resumed: true });
      } catch (error) {
        console.error("[RESUME_CONSUMER] Error:", error);
        callback({ error: "Failed to resume consumer" });
      }
    }
  );

  /**
   * Disconnect handler
   */
  socket.on("disconnect", () => {
    console.log(`[SOCKET] Client disconnected: ${socket.id}`);

    // Clean up: remove peer from all rooms
    for (const [roomId, room] of rooms) {
      if (room.peers.has(socket.id)) {
        const peer = room.getPeer(socket.id);

        // Close all producers
        for (const producer of peer.producers.values()) {
          producer.close();
        }

        // Close all consumers
        if (peer.consumers) {
          for (const consumer of peer.consumers.values()) {
            consumer.close();
          }
        }

        // Close transports
        if (peer.sendTransport) {
          peer.sendTransport.close();
        }
        if (peer.recvTransport) {
          peer.recvTransport.close();
        }

        room.removePeer(socket.id);

        // Notify others
        socket.to(roomId).emit("peerLeft", {
          peerId: socket.id,
          displayName: peer?.displayName || "Unknown",
        });

        console.log(
          `[ROOM ${roomId}] Peer ${
            socket.id
          } left (remaining: ${room.getPeerCount()})`
        );

        // If room is empty, close it
        if (room.isEmpty()) {
          room.close();
          rooms.delete(roomId);
          inviteManager.removeRoomSession(roomId);
          console.log(`[ROOM] Closed empty room: ${roomId}`);
        }
      }
    }
  });
});

app.use((req: Request, res: Response) => {
  res.sendFile(path.join(frontendDistPath, "index.html"));
});

async function start() {
  try {
    await mediasoupService.createWorkers();

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`\n✓ Server running on http://localhost:${PORT}`);
      console.log(`✓ Socket.IO listening for WebRTC signalling`);
      console.log(
        `✓ Public IP set to: ${process.env.PUBLIC_IP || "localhost"}\n`
      );
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[SHUTDOWN] Closing mediasoup workers...");
  await mediasoupService.closeAll();
  process.exit(0);
});

start();

export { app, io };
