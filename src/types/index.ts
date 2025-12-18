import { RtpCapabilities } from "mediasoup/node/lib/types";

export type PeerRole = "host" | "producer" | "consumer";

export interface Peer {
  id: string;
  userId: string; // Persistent user ID across tabs
  displayName: string;
  role: PeerRole; // Role-based permissions
  rtcMinPort?: number;
  rtcMaxPort?: number;
  sendTransport?: any;
  recvTransport?: any; // ONE recv transport (reused for all consumers)
  producers: Map<string, any>;
  consumers: Map<string, any>;
  rtpCapabilities?: RtpCapabilities;
}

export interface RoomSession {
  id: string;
  hostSocketId: string;
  hostName: string;
  createdAt: Date;
  participants: Map<string, Peer>;
}

export interface InviteToken {
  roomId: string;
  token: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface ServerToClientEvents {
  notification: (msg: string) => void;
  peerJoined: (data: {
    peerId: string;
    displayName: string;
    producerId?: string;
  }) => void;
  peerLeft: (data: { peerId: string }) => void;
  newProducer: (data: {
    producerId: string;
    producerSocketId: string;
    kind: "audio" | "video";
  }) => void;
  consumerCreated: (data: any) => void;
}

export interface ClientToServerEvents {
  join: (
    data: {
      roomId: string;
      displayName: string;
      rtpCapabilities: RtpCapabilities;
    },
    cb: (res: any) => void
  ) => void;
  createTransport: (data: { roomId: string }, cb: (res: any) => void) => void;
  connectTransport: (
    data: { roomId: string; transportId: string; dtlsParameters: any },
    cb: (res: any) => void
  ) => void;
  produce: (
    data: {
      roomId: string;
      transportId: string;
      kind: "audio" | "video";
      rtpParameters: any;
    },
    cb: (res: any) => void
  ) => void;
  consume: (
    data: {
      roomId: string;
      producerId: string;
      rtpCapabilities: RtpCapabilities;
    },
    cb: (res: any) => void
  ) => void;
  resumeConsumer: (
    data: { roomId: string; consumerId: string },
    cb: (res: any) => void
  ) => void;
  joinRoom: (data: { roomId: string }) => void;
}
