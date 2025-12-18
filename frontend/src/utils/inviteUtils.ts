/**
 * Utility functions for handling invite URLs and tokens
 */

export interface InviteURLParams {
  roomId: string;
  inviteToken?: string;
}

/**
 * Parse invite URL to extract roomId and token
 * Supports formats:
 * - /room/room-123?inviteToken=xyz (new format)
 * - /join?room=room-123&token=xyz (legacy format)
 */
export function parseInviteURL(
  pathname: string,
  search: string
): InviteURLParams | null {
  // Try new format: /room/roomId?inviteToken=token
  const roomMatch = pathname.match(/\/room\/([^\/]+)/);
  if (roomMatch) {
    const roomId = roomMatch[1];
    const params = new URLSearchParams(search);
    const inviteToken = params.get("inviteToken") || undefined;
    return { roomId, inviteToken };
  }

  // Try legacy format: /join?room=roomId&token=token
  const params = new URLSearchParams(search);
  const roomId = params.get("room") || params.get("roomId");
  const token = params.get("token") || params.get("inviteToken");

  if (roomId) {
    return { roomId, inviteToken: token || undefined };
  }

  return null;
}

/**
 * Check if current URL contains invite parameters
 */
export function isInviteURL(): boolean {
  const params = parseInviteURL(
    window.location.pathname,
    window.location.search
  );
  return params !== null && params.inviteToken !== undefined;
}

/**
 * Get room ID and token from current URL
 */
export function getInviteParams(): InviteURLParams | null {
  return parseInviteURL(window.location.pathname, window.location.search);
}

/**
 * Generate invite link URL
 */
export function generateInviteLink(
  baseUrl: string,
  roomId: string,
  inviteToken: string
): string {
  return `${baseUrl}/room/${roomId}?inviteToken=${inviteToken}`;
}
