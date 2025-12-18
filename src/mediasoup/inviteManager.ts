import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import type { InviteToken } from "../types/index";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-prod";
const INVITE_TOKEN_EXPIRY = 24 * 60 * 60 * 1000;

export class InviteManager {
  private tokens = new Map<string, InviteToken>();
  private roomSessions = new Map<
    string,
    {
      hostSocketId: string;
      hostName: string;
      createdAt: Date;
      inviteToken?: string;
    }
  >();

  /**
   * Generate JWT invite token
   * Token contains roomId and expires after 24 hours
   */
  generateInviteToken(roomId: string, hostName: string): string {
    const token = jwt.sign(
      {
        roomId,
        hostName,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + INVITE_TOKEN_EXPIRY / 1000,
      },
      JWT_SECRET
    );

    return token;
  }

  /**
   * Verify invite token validity and extract roomId
   */
  verifyInviteToken(token: string): { roomId: string; valid: boolean } {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      return { roomId: decoded.roomId, valid: true };
    } catch (err) {
      return { roomId: "", valid: false };
    }
  }

  /**
   * Create room session with host info
   * Called when host creates a room
   */
  createRoomSession(
    roomId: string,
    hostSocketId: string,
    hostName: string
  ): { roomId: string; inviteToken: string } {
    const inviteToken = this.generateInviteToken(roomId, hostName);

    this.roomSessions.set(roomId, {
      hostSocketId,
      hostName,
      createdAt: new Date(),
      inviteToken,
    });

    return { roomId, inviteToken };
  }

  getRoomSession(roomId: string) {
    return this.roomSessions.get(roomId);
  }

  removeRoomSession(roomId: string) {
    this.roomSessions.delete(roomId);
  }

  /**
   * Generate invite link in format: /room/roomId?inviteToken=xyz
   * This is the URL users can share to invite others
   */
  generateInviteLink(
    roomId: string,
    baseUrl: string = "http://localhost:3000"
  ): string {
    const session = this.roomSessions.get(roomId);
    const token =
      session?.inviteToken || this.generateInviteToken(roomId, "host");
    return `${baseUrl}/room/${roomId}?inviteToken=${token}`;
  }

  /**
   * Get all active room sessions
   */
  getAllRoomSessions() {
    return Array.from(this.roomSessions.entries()).map(([roomId, session]) => ({
      roomId,
      ...session,
    }));
  }
}

export const inviteManager = new InviteManager();
