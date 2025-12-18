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
    // Pre-create a room session and invite token so the invite link
    // returned here is valid before the host actually connects.
    const { inviteToken } = inviteManager.createRoomSession(
      roomId,
      "",
      hostName
    );

    const baseUrl = req.protocol + "://" + req.get("host");
    const inviteLink = inviteManager.generateInviteLink(roomId, baseUrl);

    res.json({
      roomId,
      inviteLink,
      inviteToken,
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
      role: peer.role,
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
        userId: string;
        displayName: string;
        rtpCapabilities: any;
        inviteToken?: string;
      },
      callback
    ) => {
      try {
        const { roomId, userId, displayName, rtpCapabilities, inviteToken } =
          data;

        console.log(
          `[JOIN] User ${displayName} (${userId}) attempting to join ${roomId}${
            inviteToken ? " with invite token" : " without token"
          }`
        );

        // Verify invite token if provided
        if (inviteToken) {
          const validation = inviteManager.verifyInviteToken(inviteToken);
          if (!validation.valid || validation.roomId !== roomId) {
            console.log(`[JOIN] Invalid token for room ${roomId}`);
            return callback({ error: "Invalid or expired invite token" });
          }
          console.log(`[JOIN] Token validated for ${roomId}`);
        }

        const room = await ensureRoom(roomId, socket.id, displayName);

        // Check if same user already in room (same tab scenario)
        const existingPeer = room.getPeerByUserId(userId);
        if (existingPeer && existingPeer.id !== socket.id) {
          console.log(
            `[ROOM ${roomId}] User ${userId} already in room from ${existingPeer.id}`
          );
        }

        // Determine role based on context
        // First user creating room -> host
        // Otherwise new participants are 'waiting' by default
        // Host must explicitly approve their join (promote to 'consumer')
        let role: "host" | "producer" | "consumer" | "waiting" = "waiting";

        if (room.getPeerCount() === 0) {
          role = "host";
          console.log(
            `[JOIN] ${displayName} is FIRST peer - assigning HOST role`
          );
        } else {
          console.log(`
            [JOIN] ${displayName} joining room - assigning WAITING role
          `);
        }

        // Add peer with appropriate role
        room.addPeer(socket.id, userId, displayName, role);
        const peer = room.getPeer(socket.id);
        if (!peer) {
          console.error(`[JOIN] Failed to add peer ${socket.id}`);
          return callback({ error: "Failed to add peer to room" });
        }
        peer.rtpCapabilities = rtpCapabilities;

        socket.join(roomId);

        // Notify others about new peer
        socket.to(roomId).emit("peerJoined", {
          peerId: socket.id,
          userId,
          displayName,
          role,
        });

        // Do NOT create transports for waiting peers. Hosts/producers
        // will request them when needed. Clients in 'waiting' state
        // must be approved by host before receiving media.

        // Send ALL producers to new peer only if they are allowed to consume
        const allProducers =
          role === "waiting" ? [] : room.getAllProducersForPeer(socket.id);

        callback({
          rtpCapabilitiesRouter: room.getRtpCapabilities(),
          existingProducers: allProducers,
          participants: Array.from(room.peers.values()).map((p) => ({
            id: p.id,
            userId: p.userId,
            displayName: p.displayName,
            role: p.role,
          })),
          yourRole: role,
          yourSocketId: socket.id,
        });

        console.log(
          `[ROOM ${roomId}] ${displayName} joined as ${role} (total: ${room.getPeerCount()})`
        );

        // If peer is waiting, notify host for approval
        if (role === "waiting") {
          const host = Array.from(room.peers.values()).find(
            (p) => p.role === "host" || p.id === room.hostSocketId
          );
          if (host) {
            const joinRequestData = {
              peerId: socket.id,
              userId,
              displayName,
              message: `${displayName} requests to join`,
            };
            console.log(
              "[JOIN] Emitting joinRequest to host",
              host.id,
              "with data:",
              JSON.stringify(joinRequestData)
            );
            io.to(host.id).emit("joinRequest", joinRequestData);
          } else {
            console.warn(
              "[JOIN] No host found to send join request to for room:",
              roomId
            );
          }
        }
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

        // Permission check: only producers and hosts can request send transport
        if (kind === "send" && !room.canPeerProduce(socket.id)) {
          return callback({
            error:
              "Permission denied: You do not have permission to produce media. Wait for host approval.",
          });
        }

        // Waiting peers cannot create recv transports either
        if (kind === "recv") {
          const peer = room.getPeer(socket.id);
          if (peer && peer.role === "waiting") {
            return callback({
              error: "Permission denied: waiting for host approval.",
            });
          }
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
          } (role: ${peer.role})`
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

        // CRITICAL: Verify peer has permission to produce
        if (!room.canPeerProduce(socket.id)) {
          return callback({
            error:
              "Permission denied: You do not have permission to produce media",
          });
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
          `[PRODUCE] ${socket.id} (${peer.role}) produced ${kind} in room ${roomId}`
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
   * Promote consumer to producer
   * Host-only action
   */
  socket.on(
    "promoteToProducer",
    async (data: { roomId: string; peerId: string }, callback) => {
      try {
        const { roomId, peerId } = data;
        const room = rooms.get(roomId);

        if (!room) {
          return callback({ error: "Room not found" });
        }

        // Only host can promote
        if (!room.isHost(socket.id)) {
          return callback({ error: "Only host can approve permissions" });
        }

        const targetPeer = room.getPeer(peerId);
        if (!targetPeer) {
          return callback({ error: "Peer not found" });
        }

        // Promote peer to producer
        const success = room.promotePeerToProducer(peerId);
        if (!success) {
          return callback({ error: "Peer is already a producer or host" });
        }

        // Notify target peer of promotion
        io.to(peerId).emit("promotedToProducer", {
          message: "You have been approved to speak",
        });

        // Notify room
        socket.to(roomId).emit("peerPromoted", {
          peerId,
          displayName: targetPeer.displayName,
          role: "producer",
        });

        callback({ promoted: true });

        console.log(
          `[PERMISSION] ${socket.id} promoted ${peerId} to producer in ${roomId}`
        );
      } catch (error) {
        console.error("[PROMOTE_TO_PRODUCER] Error:", error);
        callback({ error: "Failed to promote peer" });
      }
    }
  );

  /**
   * Approve waiting peer to become consumer (allow them to consume media)
   * Host-only action
   */
  socket.on(
    "approveJoin",
    async (
      data: { roomId: string; peerId: string; promote?: boolean },
      callback
    ) => {
      try {
        const { roomId, peerId } = data;
        console.log("[APPROVE_JOIN] Received:", {
          roomId,
          peerId,
          promote: (data as any).promote,
        });
        const room = rooms.get(roomId);

        if (!room) {
          console.error("[APPROVE_JOIN] Room not found:", roomId);
          return callback({ error: "Room not found" });
        }

        console.log(
          "[APPROVE_JOIN] Checking host privilege for socket:",
          socket.id
        );
        if (!room.isHost(socket.id)) {
          console.error(
            "[APPROVE_JOIN] Only host can approve, but requester is:",
            socket.id
          );
          return callback({ error: "Only host can approve joining" });
        }

        const targetPeer = room.getPeer(peerId);
        if (!targetPeer) {
          console.error("[APPROVE_JOIN] Peer not found:", peerId);
          return callback({ error: "Peer not found" });
        }

        console.log(
          "[APPROVE_JOIN] Target peer found:",
          targetPeer.displayName,
          "current role:",
          targetPeer.role
        );

        const success = room.approvePeerJoin(peerId);
        if (!success) {
          console.error("[APPROVE_JOIN] Peer is not in waiting state:", peerId);
          return callback({ error: "Peer is not waiting" });
        }

        console.log(
          "[APPROVE_JOIN] Peer approved to join, role changed to consumer"
        );

        // If host requested, also promote to producer (single-step admit+allow)
        const promote = !!(data as any).promote;
        if (promote) {
          room.promotePeerToProducer(peerId);
          console.log("[APPROVE_JOIN] Peer promoted to producer:", peerId);
        }

        // Notify the target peer that they are approved and include producers to consume
        const existingProducers = room.getAllProducersForPeer(peerId);
        const rtpCaps = room.getRtpCapabilities();
        console.log(
          "[APPROVE_JOIN] Emitting joinApproved to",
          peerId,
          "with producers:",
          existingProducers.length,
          "promote:",
          promote
        );
        io.to(peerId).emit("joinApproved", {
          message: "You are approved to join",
          promote,
          existingProducers,
          rtpCapabilitiesRouter: rtpCaps,
        });

        // Notify others about role change
        socket.to(roomId).emit("peerApproved", {
          peerId,
          displayName: targetPeer.displayName,
          role: promote ? "producer" : "consumer",
        });

        console.log("[APPROVE_JOIN] Calling callback with success");
        callback({ approved: true, promoted: promote });

        console.log(
          `[PERMISSION] ${socket.id} approved ${peerId} to join ${roomId} (promote=${promote})`
        );
      } catch (error) {
        console.error("[APPROVE_JOIN] Error:", error);
        callback({ error: "Failed to approve join" });
      }
    }
  );

  /**
   * Demote producer to consumer
   * Host-only action (revoke permissions)
   */
  socket.on(
    "demoteToConsumer",
    async (data: { roomId: string; peerId: string }, callback) => {
      try {
        const { roomId, peerId } = data;
        const room = rooms.get(roomId);

        if (!room) {
          return callback({ error: "Room not found" });
        }

        // Only host can demote
        if (!room.isHost(socket.id)) {
          return callback({ error: "Only host can revoke permissions" });
        }

        const targetPeer = room.getPeer(peerId);
        if (!targetPeer) {
          return callback({ error: "Peer not found" });
        }

        // Don't demote host
        if (targetPeer.role === "host") {
          return callback({ error: "Cannot demote host" });
        }

        // Demote peer to consumer
        room.demotePeerToConsumer(peerId);

        // Notify target peer
        io.to(peerId).emit("demotedToConsumer", {
          message: "Your speaking permission has been revoked",
        });

        // Notify room
        socket.to(roomId).emit("peerDemoted", {
          peerId,
          displayName: targetPeer.displayName,
          role: "consumer",
        });

        callback({ demoted: true });

        console.log(
          `[PERMISSION] ${socket.id} demoted ${peerId} to consumer in ${roomId}`
        );
      } catch (error) {
        console.error("[DEMOTE_TO_CONSUMER] Error:", error);
        callback({ error: "Failed to demote peer" });
      }
    }
  );

  /**
   * Request speaking permission
   * Consumer can request to become producer
   */
  socket.on(
    "requestSpeakingPermission",
    async (data: { roomId: string }, callback) => {
      try {
        const { roomId } = data;
        const room = rooms.get(roomId);

        if (!room) {
          return callback({ error: "Room not found" });
        }

        const peer = room.getPeer(socket.id);
        if (!peer) {
          return callback({ error: "Peer not found" });
        }

        if (peer.role === "producer" || peer.role === "host") {
          return callback({ error: "Already have speaking permission" });
        }

        // Notify host
        const host = Array.from(room.peers.values()).find(
          (p) => p.role === "host" || p.id === room.hostSocketId
        );
        if (host) {
          io.to(host.id).emit("speakingPermissionRequest", {
            peerId: socket.id,
            userId: peer.userId,
            displayName: peer.displayName,
          });
        }

        callback({ requested: true });

        console.log(
          `[PERMISSION] ${peer.displayName} requested speaking permission in ${roomId}`
        );
      } catch (error) {
        console.error("[REQUEST_SPEAKING_PERMISSION] Error:", error);
        callback({ error: "Failed to request permission" });
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
