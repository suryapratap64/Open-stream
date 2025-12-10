import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import type { InviteToken } from "../types/index";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-prod";
const INVITE_TOKEN_EXPIRY = 24 * 60 * 60 * 1000; 

export class InviteManager {
  private tokens = new Map<string, InviteToken>();
  private roomSessions = new Map<
    string,
    { hostSocketId: string; hostName: string; createdAt: Date }
  >();

 
  generateInviteToken(roomId: string, hostName: string): string {
    const token = jwt.sign(
      {
        roomId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + INVITE_TOKEN_EXPIRY / 1000,
      },
      JWT_SECRET
    );

    return token;
  }

  verifyInviteToken(token: string): { roomId: string; valid: boolean } {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      return { roomId: decoded.roomId, valid: true };
    } catch (err) {
      return { roomId: "", valid: false };
    }
  }
  createRoomSession(
    roomId: string,
    hostSocketId: string,
    hostName: string
  ): { roomId: string; inviteToken: string } {
    this.roomSessions.set(roomId, {
      hostSocketId,
      hostName,
      createdAt: new Date(),
    });

    const inviteToken = this.generateInviteToken(roomId, hostName);
    return { roomId, inviteToken };
  }

  getRoomSession(roomId: string) {
    return this.roomSessions.get(roomId);
  }


  removeRoomSession(roomId: string) {
    this.roomSessions.delete(roomId);
  }

  generateInviteLink(
    roomId: string,
    baseUrl: string = "http://localhost:3000"
  ): string {
    const token = this.generateInviteToken(roomId, "host");
    return `${baseUrl}/join?room=${roomId}&token=${token}`;
  }
}

export const inviteManager = new InviteManager();
