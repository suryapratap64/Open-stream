import { useState } from "react";
import type { PeerRole } from "../hooks/useRoomPermission";

interface SpeakingPermissionButtonProps {
  role: PeerRole | null;
  onRequest: () => void;
}

/**
 * Component showing speaking permission button for consumers
 * Allows consumers to request microphone/camera access from the host
 */
export function SpeakingPermissionButton({
  role,
  onRequest,
}: SpeakingPermissionButtonProps) {
  const [requested, setRequested] = useState(false);

  const handleRequest = () => {
    onRequest();
    setRequested(true);
    // Reset after 3 seconds to allow retry if needed
    setTimeout(() => setRequested(false), 3000);
  };

  // Only show for consumers without speaking permission
  if (role === "producer" || role === "host") {
    return null;
  }

  if (role === "consumer") {
    return (
      <div className="flex items-center gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <div className="flex-1">
          <p className="text-sm font-medium text-yellow-900">
            🎤 Request Speaking Permission
          </p>
          <p className="text-xs text-yellow-700">
            Click below to ask the host for permission to share audio/video
          </p>
        </div>
        <button
          onClick={handleRequest}
          disabled={requested}
          className={`px-4 py-2 font-medium rounded transition-colors whitespace-nowrap ${
            requested
              ? "bg-gray-400 text-white cursor-not-allowed"
              : "bg-yellow-500 hover:bg-yellow-600 text-white"
          }`}
        >
          {requested ? "✓ Requested" : "Request"}
        </button>
      </div>
    );
  }

  return null;
}
