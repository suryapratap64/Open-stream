import type { PermissionRequest } from "../hooks/useRoomPermission";

interface PermissionRequestNotificationProps {
  requests: Array<PermissionRequest & { message?: string }>;
  onApprove: (peerId: string) => void;
  onDeny: (peerId: string) => void;
}

/**
 * Component showing pending permission requests for the host
 * Displays in a notification area with approve/deny buttons
 */
export function PermissionRequestNotification({
  requests,
  onApprove,
  onDeny,
}: PermissionRequestNotificationProps) {
  if (requests.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 space-y-2 max-w-sm z-50">
      {requests.map((request) => (
        <div
          key={request.peerId}
          className="bg-blue-50 border border-blue-200 rounded-lg p-4 shadow-lg"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <p className="font-medium text-blue-900">{request.displayName}</p>
              <p className="text-sm text-blue-700">
                {request.message && request.message.length > 0
                  ? request.message
                  : `${request.displayName} requests to join`}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={(e) => {
                  console.log(
                    "[NOTIFICATION] Allow clicked for peerId:",
                    request.peerId
                  );
                  e.stopPropagation();
                  onApprove(request.peerId);
                }}
                className="px-3 py-1 bg-green-500 hover:bg-green-600 text-white text-sm rounded transition-colors"
              >
                Allow
              </button>
              <button
                type="button"
                onClick={(e) => {
                  console.log(
                    "[NOTIFICATION] Deny clicked for peerId:",
                    request.peerId
                  );
                  e.stopPropagation();
                  onDeny(request.peerId);
                }}
                className="px-3 py-1 bg-gray-500 hover:bg-gray-600 text-white text-sm rounded transition-colors"
              >
                Deny
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
