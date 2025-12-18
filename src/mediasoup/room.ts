import {
  Router,
  Transport,
  Producer,
  Consumer,
  RtpCapabilities,
  WebRtcTransportOptions,
} from "mediasoup/node/lib/types";
import { mediasoupService } from "./mediasoupService";
import type { Worker } from "mediasoup/node/lib/WorkerTypes";
import { v4 as uuidv4 } from "uuid";
import type { Peer, PeerRole } from "../types/index";

export class Room {
  id: string;
  router: Router;
  peers = new Map<string, Peer>();
  worker: Worker;
  hostSocketId: string;
  createdAt: Date;

  constructor(
    id: string,
    router: Router,
    worker: Worker,
    hostSocketId: string
  ) {
    this.id = id;
    this.router = router;
    this.worker = worker;
    this.hostSocketId = hostSocketId;
    this.createdAt = new Date();
  }

  static async create(id: string, hostSocketId: string) {
    const worker = mediasoupService.getWorker();
    const mediaCodecs = [
      {
        kind: "audio" as const,
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: "video" as const,
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {},
      },
    ];

    const router = await worker.createRouter({ mediaCodecs });
    return new Room(id, router, worker, hostSocketId);
  }

  getRtpCapabilities(): RtpCapabilities {
    return this.router.rtpCapabilities;
  }

  /**
   * Add peer to room with specified role
   * Host: Full permissions (produce, consume, approve others)
   * Producer: Can produce and consume media
   * Consumer: Can only consume media (default for invited users)
   */
  addPeer(
    socketId: string,
    userId: string,
    displayName: string = "Anonymous",
    role: PeerRole = "consumer"
  ) {
    const peer: Peer = {
      id: socketId,
      userId,
      displayName,
      role,
      producers: new Map(),
      consumers: new Map(),
    };
    this.peers.set(socketId, peer);
    return peer;
  }

  getPeer(socketId: string) {
    return this.peers.get(socketId);
  }

  /**
   * Get peer by userId (useful for checking if same user already in room)
   */
  getPeerByUserId(userId: string) {
    for (const peer of this.peers.values()) {
      if (peer.userId === userId) {
        return peer;
      }
    }
    return null;
  }

  /**
   * Promote peer from consumer to producer
   * Host-controlled action
   */
  promotePeerToProducer(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) return false;

    if (peer.role === "consumer") {
      peer.role = "producer";
      return true;
    }
    return false;
  }

  /**
   * Approve a waiting peer to become a consumer (allow join to start consuming)
   */
  approvePeerJoin(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) return false;

    if (peer.role === "waiting") {
      peer.role = "consumer";
      return true;
    }
    return false;
  }

  /**
   * Demote peer from producer to consumer
   * Host-controlled action (revoke permission)
   */
  demotePeerToConsumer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    peer.role = "consumer";

    // Close send transport if exists
    if (peer.sendTransport) {
      peer.sendTransport.close();
      peer.sendTransport = undefined;
    }

    // Close all producers (clean media streams)
    for (const producer of peer.producers.values()) {
      producer.close();
    }
    peer.producers.clear();
  }

  /**
   * Check if peer can produce media based on role
   */
  canPeerProduce(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    return peer.role === "producer" || peer.role === "host";
  }

  /**
   * Check if peer is the host
   */
  isHost(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    return peer.role === "host" || peerId === this.hostSocketId;
  }

  removePeer(socketId: string) {
    const peer = this.peers.get(socketId);
    if (!peer) return;

    for (const p of peer.producers.values()) {
      p.close();
    }

    for (const c of peer.consumers.values()) {
      c.close();
    }

    if (peer.sendTransport) {
      peer.sendTransport.close();
    }

    if (peer.recvTransport) {
      peer.recvTransport.close();
    }

    this.peers.delete(socketId);
  }

  async createWebRtcTransport(): Promise<Transport> {
    const transport = await this.router.createWebRtcTransport({
      listenIps: [
        { ip: "0.0.0.0", announcedIp: process.env.PUBLIC_IP || "127.0.0.1" },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000,
    } as WebRtcTransportOptions);

    return transport;
  }

  getAllProducers(): Array<{
    peerId: string;
    producerId: string;
    kind: "audio" | "video";
  }> {
    const producers: Array<{
      peerId: string;
      producerId: string;
      kind: "audio" | "video";
    }> = [];

    for (const [peerId, peer] of this.peers) {
      for (const [producerId, producer] of peer.producers) {
        producers.push({
          peerId,
          producerId,
          kind: producer.kind,
        });
      }
    }

    return producers;
  }

  getVideoProducers(): Array<{
    peerId: string;
    producerId: string;
    producerDisplayName: string;
  }> {
    const videoProducers: Array<{
      peerId: string;
      producerId: string;
      producerDisplayName: string;
    }> = [];

    for (const [peerId, peer] of this.peers) {
      for (const [producerId, producer] of peer.producers) {
        if (producer.kind === "video") {
          videoProducers.push({
            peerId,
            producerId,
            producerDisplayName: peer.displayName,
          });
        }
      }
    }

    return videoProducers;
  }

  getAllProducersForPeer(excludePeerId?: string): Array<{
    peerId: string;
    producerId: string;
    kind: "audio" | "video";
    producerDisplayName: string;
  }> {
    const allProducers: Array<{
      peerId: string;
      producerId: string;
      kind: "audio" | "video";
      producerDisplayName: string;
    }> = [];

    for (const [peerId, peer] of this.peers) {
      if (excludePeerId && peerId === excludePeerId) {
        continue;
      }

      for (const [producerId, producer] of peer.producers) {
        allProducers.push({
          peerId,
          producerId,
          kind: producer.kind,
          producerDisplayName: peer.displayName,
        });
      }
    }

    return allProducers;
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  isEmpty(): boolean {
    return this.peers.size === 0;
  }

  async close() {
    for (const peer of this.peers.values()) {
      this.removePeer(peer.id);
    }
    await this.router.close();
  }
}
