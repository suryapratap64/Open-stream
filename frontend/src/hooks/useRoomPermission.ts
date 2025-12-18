import { useEffect, useState, useRef, useCallback } from "react";
import type { Socket } from "socket.io-client";
import { UserIdentityManager } from "../utils/userIdentityManager";

export type PeerRole = "host" | "producer" | "consumer" | "waiting";

export interface PeerInfo {
  id: string;
  userId: string;
  displayName: string;
  role: PeerRole;
}

export interface PermissionRequest {
  peerId: string;
  userId: string;
  displayName: string;
}

export interface UseRoomPermissionResult {
  userId: string;
  yourRole: PeerRole | null;
  participants: PeerInfo[];
  permissionRequests: PermissionRequest[];
  isHost: boolean;
  requestSpeakingPermission: () => void;
  approveSpeaker: (peerId: string) => void;
  revokeSpeakerPermission: (peerId: string) => void;
  hasPermissionToSpeak: boolean;
}

/**
 * Hook to manage room permissions and role-based access
 */
export function useRoomPermission(
  socket: Socket | null,
  roomId: string
): UseRoomPermissionResult {
  const [userId] = useState(() => UserIdentityManager.getUserId());
  const [yourRole, setYourRole] = useState<PeerRole | null>(null);
  const [participants, setParticipants] = useState<PeerInfo[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<
    PermissionRequest[]
  >([]);
  const processedRequestsRef = useRef<Set<string>>(new Set());

  // Listen for role updates from server
  useEffect(() => {
    if (!socket) return;

    const handlePeerJoined = (data: any) => {
      setParticipants((prev) => {
        const exists = prev.find((p) => p.id === data.peerId);
        if (!exists) {
          return [
            ...prev,
            {
              id: data.peerId,
              userId: data.userId,
              displayName: data.displayName,
              role: data.role,
            },
          ];
        }
        return prev;
      });
    };

    const handlePeerLeft = (data: any) => {
      setParticipants((prev) => prev.filter((p) => p.id !== data.peerId));
      setPermissionRequests((prev) =>
        prev.filter((r) => r.peerId !== data.peerId)
      );
    };

    const handlePromotedToProducer = () => {
      setYourRole("producer");
    };

    const handleDemotedToConsumer = () => {
      setYourRole("consumer");
    };

    const handlePeerPromoted = (data: any) => {
      setParticipants((prev) =>
        prev.map((p) => (p.id === data.peerId ? { ...p, role: "producer" } : p))
      );
    };

    const handlePeerDemoted = (data: any) => {
      setParticipants((prev) =>
        prev.map((p) => (p.id === data.peerId ? { ...p, role: "consumer" } : p))
      );
    };

    const handleSpeakingPermissionRequest = (data: PermissionRequest) => {
      const requestKey = `${data.peerId}-${data.userId}`;
      if (!processedRequestsRef.current.has(requestKey)) {
        processedRequestsRef.current.add(requestKey);
        setPermissionRequests((prev) => {
          const exists = prev.find((r) => r.peerId === data.peerId);
          return exists ? prev : [...prev, data];
        });
      }
    };

    socket.on("peerJoined", handlePeerJoined);
    socket.on("peerLeft", handlePeerLeft);
    socket.on("promotedToProducer", handlePromotedToProducer);
    socket.on("demotedToConsumer", handleDemotedToConsumer);
    socket.on("peerPromoted", handlePeerPromoted);
    socket.on("peerDemoted", handlePeerDemoted);
    socket.on("speakingPermissionRequest", handleSpeakingPermissionRequest);

    return () => {
      socket.off("peerJoined", handlePeerJoined);
      socket.off("peerLeft", handlePeerLeft);
      socket.off("promotedToProducer", handlePromotedToProducer);
      socket.off("demotedToConsumer", handleDemotedToConsumer);
      socket.off("peerPromoted", handlePeerPromoted);
      socket.off("peerDemoted", handlePeerDemoted);
      socket.off("speakingPermissionRequest", handleSpeakingPermissionRequest);
    };
  }, [socket]);

  const requestSpeakingPermission = useCallback(() => {
    if (socket) {
      socket.emit("requestSpeakingPermission", { roomId }, (response: any) => {
        if (response.error) {
          console.error("Failed to request permission:", response.error);
        }
      });
    }
  }, [socket, roomId]);

  const approveSpeaker = useCallback(
    (peerId: string) => {
      if (socket) {
        socket.emit(
          "promoteToProducer",
          { roomId, peerId },
          (response: any) => {
            if (response.error) {
              console.error("Failed to approve speaker:", response.error);
            } else {
              // Remove from requests
              setPermissionRequests((prev) =>
                prev.filter((r) => r.peerId !== peerId)
              );
            }
          }
        );
      }
    },
    [socket, roomId]
  );

  const revokeSpeakerPermission = useCallback(
    (peerId: string) => {
      if (socket) {
        socket.emit("demoteToConsumer", { roomId, peerId }, (response: any) => {
          if (response.error) {
            console.error("Failed to revoke permission:", response.error);
          }
        });
      }
    },
    [socket, roomId]
  );

  return {
    userId,
    yourRole,
    participants,
    permissionRequests,
    isHost: yourRole === "host",
    requestSpeakingPermission,
    approveSpeaker,
    revokeSpeakerPermission,
    hasPermissionToSpeak: yourRole === "producer" || yourRole === "host",
  };
}
