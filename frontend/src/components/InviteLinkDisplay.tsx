import { useState } from "react";

interface InviteLinkDisplayProps {
  roomId: string;
  inviteLink: string;
  isHost: boolean;
}

/**
 * Component displaying the invite link that the host can share
 * Includes copy-to-clipboard functionality
 */
export function InviteLinkDisplay({
  roomId,
  inviteLink,
  isHost,
}: InviteLinkDisplayProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyLink = () => {
    navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isHost) {
    return null;
  }

  return (
    <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
      <h3 className="text-lg font-semibold text-purple-900 mb-3">
        Invite Participants
      </h3>
      <p className="text-sm text-purple-700 mb-3">
        Share this link with others to invite them to join as listeners. They
        can request speaking permission once they join.
      </p>
      <div className="flex gap-2">
        <div className="flex-1 bg-white border border-purple-300 rounded p-2">
          <p className="text-xs text-gray-500 mb-1">Invite Link:</p>
          <p className="text-sm font-mono break-all text-gray-700">
            {inviteLink}
          </p>
        </div>
        <button
          onClick={handleCopyLink}
          className={`px-4 py-2 font-medium rounded transition-colors whitespace-nowrap ${
            copied
              ? "bg-green-500 text-white"
              : "bg-purple-500 hover:bg-purple-600 text-white"
          }`}
        >
          {copied ? "✓ Copied" : "Copy Link"}
        </button>
      </div>
      <p className="text-xs text-purple-600 mt-2">
        Room ID:{" "}
        <code className="bg-purple-100 px-2 py-1 rounded">{roomId}</code>
      </p>
    </div>
  );
}
