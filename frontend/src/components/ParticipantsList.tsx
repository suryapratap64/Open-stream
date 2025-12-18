import type { PeerInfo, PeerRole } from "../hooks/useRoomPermission";

interface ParticipantsListProps {
  participants: PeerInfo[];
  yourRole: PeerRole | null;
  isHost: boolean;
  onRevokeSpeaker: (peerId: string) => void;
}

/**
 * Component showing list of participants with their roles
 * Host can revoke speaking permissions from here
 */
export function ParticipantsList({
  participants,
  yourRole,
  isHost,
  onRevokeSpeaker,
}: ParticipantsListProps) {
  const getRoleColor = (role: PeerRole) => {
    switch (role) {
      case "host":
        return "bg-red-100 text-red-800";
      case "producer":
        return "bg-green-100 text-green-800";
      case "consumer":
        return "bg-gray-100 text-gray-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getRoleLabel = (role: PeerRole) => {
    switch (role) {
      case "host":
        return "👑 Host";
      case "producer":
        return "🎤 Speaker";
      case "consumer":
        return "👁️ Listening";
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Participants</h2>
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {participants.length === 0 ? (
          <p className="text-gray-500 text-center py-4">No participants yet</p>
        ) : (
          participants.map((peer) => (
            <div
              key={peer.id}
              className="flex items-center justify-between p-2 bg-gray-50 rounded hover:bg-gray-100 transition-colors"
            >
              <div className="flex-1">
                <p className="font-medium text-gray-900">
                  {peer.displayName}
                  {yourRole === peer.role &&
                    peer.displayName === peer.displayName &&
                    " (You)"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`px-2 py-1 text-xs font-medium rounded ${getRoleColor(
                    peer.role
                  )}`}
                >
                  {getRoleLabel(peer.role)}
                </span>
                {isHost && peer.role === "producer" && (
                  <button
                    onClick={() => onRevokeSpeaker(peer.id)}
                    className="px-2 py-1 bg-red-500 hover:bg-red-600 text-white text-xs rounded transition-colors"
                    title="Revoke speaking permission"
                  >
                    Revoke
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
