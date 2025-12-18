import { useState, useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import * as mediasoupClient from "mediasoup-client";
import { UserIdentityManager } from "./utils/userIdentityManager";
import { getInviteParams } from "./utils/inviteUtils";
import { PermissionRequestNotification } from "./components/PermissionRequestNotification";
import { SpeakingPermissionButton } from "./components/SpeakingPermissionButton";

interface Participant {
  id: string;
  displayName: string;
  hasAudio: boolean;
  hasVideo: boolean;
}

interface RemoteVideo {
  peerId: string;
  displayName: string;
  stream: MediaStream;
  audioStream?: MediaStream;
}

function App() {
  const [view, setView] = useState<"landing" | "room">("landing");
  const [displayName, setDisplayName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [remoteVideos, setRemoteVideos] = useState<RemoteVideo[]>([]);
  const [inviteLink, setInviteLink] = useState("");
  const [error, setError] = useState("");
  const [permissionRequests, setPermissionRequests] = useState<
    { peerId: string; userId: string; displayName: string }[]
  >([]);
  const [yourRole, setYourRole] = useState<
    "host" | "producer" | "consumer" | "waiting" | null
  >(null);

  const socketRef = useRef<Socket | null>(null);
  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const sendTransportRef = useRef<any | null>(null);
  const recvTransportRef = useRef<any | null>(null);
  const consumedProducersRef = useRef<Set<string>>(new Set());
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  useEffect(() => {
    if (view === "room" && localStreamRef.current && localVideoRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
      // Ensure autoplay policies don't block playback
      try {
        localVideoRef.current.muted = true;
        localVideoRef.current.play().catch((err) => {
          console.warn("Local video play() blocked:", err);
        });
      } catch (err) {
        console.warn("Error attaching local stream:", err);
      }
    }
  }, [view]);

  const createRoom = async () => {
    if (!displayName.trim()) {
      setError("Please enter your name");
      return;
    }

    try {
      setError("");
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostName: displayName }),
      });

      if (!response.ok) throw new Error("Failed to create room");

      const { roomId: newRoomId, inviteLink: link } = await response.json();
      setRoomId(newRoomId);
      await enterRoom(newRoomId, displayName, link);
    } catch (error) {
      console.error("Error creating room:", error);
      setError("Failed to create room: " + (error as Error).message);
    }
  };

  const joinRoom = async () => {
    if (!displayName.trim()) {
      setError("Please enter your name");
      return;
    }
    if (!roomId.trim()) {
      setError("Please enter room ID");
      return;
    }

    try {
      setError("");
      const response = await fetch(`/api/rooms/${roomId}`);
      if (!response.ok) throw new Error("Room not found");

      await enterRoom(roomId, displayName);
    } catch (error) {
      console.error("Error joining room:", error);
      setError("Room not found or invalid");
    }
  };

  const enterRoom = async (rid: string, name: string, _link = "") => {
    try {
      setError("");

      const socket = io(window.location.origin, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5,
      });

      socketRef.current = socket;

      socket.on("connect", () => {
        console.log("Connected:", socket.id);
      });

      socket.on("peerJoined", (data) => {
        console.log("Peer joined:", data);
        updateParticipants(rid);
      });

      socket.on("speakingPermissionRequest", (data) => {
        console.log("speakingPermissionRequest:", data);
        setPermissionRequests((prev) => {
          if (prev.find((p) => p.peerId === data.peerId)) return prev;
          return [...prev, data];
        });
      });

      socket.on("joinRequest", (data) => {
        console.log("[JOIN_REQUEST] === RECEIVED ===");
        console.log("[JOIN_REQUEST] Raw data:", JSON.stringify(data));
        console.log("[JOIN_REQUEST] Has message field:", !!data.message);
        console.log("[JOIN_REQUEST] Message value:", data.message);

        // Ensure message is set, default to "{displayName} requests to join"
        const requestData = {
          ...data,
          message: data.message || `${data.displayName} requests to join`,
        };
        console.log(
          "[JOIN_REQUEST] Final request data with message:",
          JSON.stringify(requestData)
        );

        setPermissionRequests((prev) => {
          if (prev.find((p) => p.peerId === requestData.peerId)) {
            console.log(
              "[JOIN_REQUEST] Request already exists for peerId:",
              requestData.peerId
            );
            return prev;
          }
          const updated = [...prev, requestData];
          console.log(
            "[JOIN_REQUEST] Added request, now have",
            updated.length,
            "requests"
          );
          console.log(
            "[JOIN_REQUEST] Updated requests:",
            JSON.stringify(updated)
          );
          return updated;
        });
      });

      socket.on("peerLeft", (data) => {
        console.log("Peer left:", data.peerId);
        removeRemoteVideo(data.peerId);
        updateParticipants(rid);
      });

      socket.on("newProducer", async (data) => {
        console.log("New producer:", data.producerId, data.kind);
        const consumeKey = `${data.producerSocketId}-${data.producerId}`;
        if (!consumedProducersRef.current.has(consumeKey)) {
          await consumeProducer(
            rid,
            data.producerId,
            data.producerDisplayName,
            data.producerSocketId
          );
        }
      });

      // Get persistent userId and invite token if available
      const userId = UserIdentityManager.getUserId();
      const inviteParams = getInviteParams();

      console.log(
        `[FRONTEND] Joining room with userId: ${userId}, inviteToken: ${
          inviteParams?.inviteToken ? "yes" : "no"
        }`
      );

      // Join the room FIRST - before getting media stream
      const joinRes = await new Promise<any>((resolve, reject) => {
        socket.emit(
          "join",
          {
            roomId: rid,
            userId,
            displayName: name,
            rtpCapabilities: {},
            inviteToken: inviteParams?.inviteToken,
          },
          (res: any) => {
            if (res.error) reject(new Error(res.error));
            else resolve(res);
          }
        );
      });

      console.log(`[FRONTEND] Join successful, your role: ${joinRes.yourRole}`);

      const device = new mediasoupClient.Device();
      deviceRef.current = device;

      try {
        await device.load({
          routerRtpCapabilities: joinRes.rtpCapabilitiesRouter,
        });
      } catch (err) {
        console.warn("Device.load() failed, continuing anyway:", err);
      }

      // Get your role from server response
      const roleFromServer = joinRes.yourRole;
      setYourRole(roleFromServer);

      console.log(`[ENTER_ROOM] You have role: ${roleFromServer}`);

      // Only get media stream if you have permission to produce (not waiting or consumer)
      let stream: MediaStream | null = null;
      if (roleFromServer === "producer" || roleFromServer === "host") {
        console.log(
          `[ENTER_ROOM] Getting media stream for ${roleFromServer} role...`
        );
        try {
          // Log permission state (if supported)
          try {
            const micPerm = await (navigator as any).permissions?.query?.({
              name: "microphone",
            });
            const camPerm = await (navigator as any).permissions?.query?.({
              name: "camera",
            });
            console.log(
              "[ENTER_ROOM] Permission states - mic:",
              micPerm?.state,
              "cam:",
              camPerm?.state
            );
          } catch (permErr) {
            // permissions API may not support these names in all browsers
          }

          stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: { width: 1280, height: 720 },
          });
          console.log("[ENTER_ROOM] getUserMedia succeeded");
        } catch (getErr) {
          console.error("[ENTER_ROOM] getUserMedia failed:", getErr);
          setError("Camera/microphone access denied or unavailable");
          // don't rethrow - allow consumer flow to continue
        }

        localStreamRef.current = stream;

        if (localVideoRef.current && stream) {
          localVideoRef.current.srcObject = stream;
          try {
            // local video should be muted to allow autoplay
            localVideoRef.current.muted = true;
            localVideoRef.current
              .play()
              .catch((err) =>
                console.warn("[ENTER_ROOM] Local video play() blocked:", err)
              );
          } catch (err) {
            console.warn("[ENTER_ROOM] Error playing local video:", err);
          }
        }
      } else if (roleFromServer === "waiting") {
        console.log(
          `[ENTER_ROOM] You are in WAITING state - NOT requesting media until host approves`
        );
      } else {
        console.log(
          `[ENTER_ROOM] You are a consumer - NOT requesting media until promoted`
        );
      }

      // If server says you're host or already a producer, start producing
      if (roleFromServer === "producer" || roleFromServer === "host") {
        try {
          console.log("[ENTER_ROOM] Starting production...");
          await startProducing(rid);
          console.log("[ENTER_ROOM] Production started");
        } catch (err) {
          console.error("[ENTER_ROOM] Failed to start producing on join:", err);
        }
      } else if (roleFromServer === "waiting") {
        console.log(
          `[ENTER_ROOM] Waiting for host approval - not producing yet`
        );
      } else {
        console.log(
          `[ENTER_ROOM] You are a consumer - not producing until promoted`
        );
      }

      // Listen for promotion/demotion events so consumers can be upgraded later
      socket.on("promotedToProducer", async () => {
        console.log("[EVENT] promotedToProducer received");
        setYourRole("producer");
        // If not already producing, start producing now
        try {
          await startProducing(roomId);
        } catch (err) {
          console.error(
            "[EVENT] Error starting producing after promotion:",
            err
          );
        }
      });

      socket.on("demotedToConsumer", () => {
        console.log("[EVENT] demotedToConsumer received");
        setYourRole("consumer");
        stopProducing();
      });

      // Host notifications for consumer join (older code uses consumerJoinedNotification)
      socket.on("consumerJoinedNotification", (data) => {
        console.log("consumerJoinedNotification:", data);
        // Add a permission request automatically for host convenience
        setPermissionRequests((prev) => {
          if (prev.find((p) => p.peerId === data.peerId)) return prev;
          return [
            ...prev,
            {
              peerId: data.peerId,
              userId: data.userId,
              displayName: data.displayName,
            },
          ];
        });
      });

      // Listen for join approval from host
      socket.on("joinApproved", async (data: any) => {
        console.log("[JOIN_APPROVED] === EVENT RECEIVED ===");
        console.log("[JOIN_APPROVED] Full data:", JSON.stringify(data));
        console.log("[JOIN_APPROVED] promote flag:", data?.promote);
        console.log("[JOIN_APPROVED] Current role before change:", yourRole);

        // update role to consumer (or producer if promoted)
        if (data?.promote) {
          console.log(
            "[JOIN_APPROVED] Setting role to PRODUCER (promote=true)"
          );
          setYourRole("producer");
        } else {
          console.log(
            "[JOIN_APPROVED] Setting role to CONSUMER (promote=false)"
          );
          setYourRole("consumer");
        }

        // create recv transport and consume existing producers provided by server
        try {
          if (!deviceRef.current) {
            console.error("[JOIN_APPROVED] No device ref!");
            return;
          }
          const device = deviceRef.current;
          console.log(
            "[JOIN_APPROVED] Creating recv transport for roomId:",
            rid
          );
          const recvTransportRes = await new Promise<any>((resolve, reject) => {
            socket.emit(
              "createTransport",
              { roomId: rid, kind: "recv" },
              (res: any) => {
                if (res.error) {
                  console.error(
                    "[JOIN_APPROVED] createTransport error:",
                    res.error
                  );
                  reject(new Error(res.error));
                } else {
                  console.log("[JOIN_APPROVED] recv transport response OK");
                  resolve(res);
                }
              }
            );
          });

          const recvTransport = device.createRecvTransport(recvTransportRes);
          recvTransportRef.current = recvTransport;
          console.log(
            "[JOIN_APPROVED] recv transport created:",
            recvTransport.id
          );

          recvTransport.on(
            "connect",
            ({ dtlsParameters }, callback, errCallback) => {
              console.log("[JOIN_APPROVED] recv transport connecting...");
              socket.emit(
                "connectTransport",
                { roomId: rid, transportId: recvTransport.id, dtlsParameters },
                (res: any) => {
                  if (res.error) {
                    console.error("[JOIN_APPROVED] connect error:", res.error);
                    return errCallback(res.error);
                  }
                  console.log("[JOIN_APPROVED] recv transport connected");
                  callback();
                }
              );
            }
          );

          if (data?.existingProducers?.length > 0) {
            console.log(
              "[JOIN_APPROVED] Consuming",
              data.existingProducers.length,
              "existing producers"
            );
            for (const p of data.existingProducers) {
              const consumeKey = `${p.peerId}-${p.producerId}`;
              if (!consumedProducersRef.current.has(consumeKey)) {
                await consumeProducer(
                  rid,
                  p.producerId,
                  p.producerDisplayName,
                  p.peerId
                );
              }
            }
          }
          // If host approved with promote flag, start producing now
          if (data?.promote) {
            console.log(
              "[JOIN_APPROVED] === PROMOTE FLAG IS TRUE, STARTING PRODUCER ==="
            );
            try {
              // small delay to ensure transports are set up
              await new Promise((r) => setTimeout(r, 100));
              console.log(
                "[JOIN_APPROVED] Calling startProducing with rid:",
                rid
              );
              await startProducing(rid);
              console.log(
                "[JOIN_APPROVED] startProducing completed successfully"
              );
            } catch (err) {
              console.error("[JOIN_APPROVED] startProducing error:", err);
            }
          } else {
            console.log("[JOIN_APPROVED] No promote flag, staying as consumer");
          }
        } catch (err) {
          console.error("[JOIN_APPROVED] Failed:", err);
        }
      });

      // Create recv transport for consuming only if not waiting
      if (roleFromServer !== "waiting") {
        const recvTransportRes = await new Promise<any>((resolve, reject) => {
          socket.emit(
            "createTransport",
            { roomId: rid, kind: "recv" },
            (res: any) => {
              if (res.error) reject(new Error(res.error));
              else resolve(res);
            }
          );
        });

        const recvTransport = device.createRecvTransport(recvTransportRes);
        recvTransportRef.current = recvTransport;

        recvTransport.on(
          "connect",
          ({ dtlsParameters }, callback, errCallback) => {
            socket.emit(
              "connectTransport",
              { roomId: rid, transportId: recvTransport.id, dtlsParameters },
              (res: any) => {
                if (res.error) return errCallback(res.error);
                callback();
              }
            );
          }
        );

        if (joinRes.existingProducers?.length > 0) {
          console.log(
            "Consuming",
            joinRes.existingProducers.length,
            "existing producers"
          );
          for (const {
            producerId,
            producerDisplayName,
            peerId,
          } of joinRes.existingProducers) {
            const consumeKey = `${peerId}-${producerId}`;
            if (!consumedProducersRef.current.has(consumeKey)) {
              await consumeProducer(
                rid,
                producerId,
                producerDisplayName,
                peerId
              );
            }
          }
        }
      } else {
        // role is waiting: client should wait for approval event
        console.log("You are in WAITING state; awaiting host approval to join");
      }

      setInviteLink(joinRes.inviteLink || `http://localhost:5173?room=${rid}`);
      setView("room");
      updateParticipants(rid);
    } catch (error) {
      console.error("Error entering room:", error);
      setError("Failed to join room: " + (error as Error).message);
    }
  };

  const consumeProducer = async (
    rid: string,
    producerId: string,
    displayName: string,
    peerId: string
  ) => {
    try {
      if (!deviceRef.current || !socketRef.current) return;

      const consumeKey = `${peerId}-${producerId}`;
      if (consumedProducersRef.current.has(consumeKey)) {
        console.log("Already consuming", producerId);
        return;
      }

      const device = deviceRef.current;
      const socket = socketRef.current;

      if (!recvTransportRef.current) {
        console.log("Creating recv transport");
        const recvTransportRes = await new Promise<any>((resolve, reject) => {
          socket.emit(
            "createTransport",
            { roomId: rid, kind: "recv" },
            (res: any) => {
              if (res.error) reject(new Error(res.error));
              else resolve(res);
            }
          );
        });

        const recvTransport = device.createRecvTransport(recvTransportRes);
        recvTransportRef.current = recvTransport;

        recvTransport.on(
          "connect",
          ({ dtlsParameters }, callback, errCallback) => {
            socket.emit(
              "connectTransport",
              { roomId: rid, transportId: recvTransport.id, dtlsParameters },
              (res: any) => {
                if (res.error) return errCallback(res.error);
                callback();
              }
            );
          }
        );
      }

      const consumeRes = await new Promise<any>((resolve, reject) => {
        socket.emit(
          "consume",
          {
            roomId: rid,
            producerId,
            rtpCapabilities: device.rtpCapabilities,
          },
          (res: any) => {
            if (res.error) reject(res.error);
            else resolve(res);
          }
        );
      });

      const consumer = await recvTransportRef.current.consume({
        id: consumeRes.id,
        producerId: consumeRes.producerId,
        kind: consumeRes.kind,
        rtpParameters: consumeRes.rtpParameters,
        paused: false,
      });

      if (consumer.paused) {
        await consumer.resume();
      }

      consumedProducersRef.current.add(consumeKey);

      if (consumer.kind === "video") {
        const remoteStream = new MediaStream([consumer.track]);
        setRemoteVideos((prev) => {
          const existingIndex = prev.findIndex((v) => v.peerId === peerId);
          if (existingIndex >= 0) {
            const updated = [...prev];
            updated[existingIndex].stream = remoteStream;
            return updated;
          } else {
            return [
              ...prev,
              {
                peerId,
                displayName,
                stream: remoteStream,
              },
            ];
          }
        });
      } else if (consumer.kind === "audio") {
        const audioStream = new MediaStream([consumer.track]);
        setRemoteVideos((prev) => {
          const existingIndex = prev.findIndex((v) => v.peerId === peerId);
          if (existingIndex >= 0) {
            const updated = [...prev];
            updated[existingIndex].audioStream = audioStream;
            return updated;
          } else {
            return [
              ...prev,
              {
                peerId,
                displayName,
                stream: new MediaStream(),
                audioStream,
              },
            ];
          }
        });
      }

      console.log("Consumer created:", consumeRes.id, "for", displayName);
    } catch (error) {
      console.error("Failed to consume:", error);
    }
  };

  // Start producing media after permission (or when host/producer on join)
  const startProducing = async (overrideRoomId?: string) => {
    try {
      const socket = socketRef.current;
      const device = deviceRef.current;
      if (!socket || !device) {
        console.error("[START_PRODUCING] Missing socket or device");
        return;
      }

      if (sendTransportRef.current) {
        console.log("[START_PRODUCING] Already producing, skipping");
        return;
      }

      console.log(
        "[START_PRODUCING] Starting... overrideRoomId:",
        overrideRoomId,
        "current roomId:",
        roomId
      );

      // Get media if we don't already have it
      if (!localStreamRef.current) {
        console.log(
          "[START_PRODUCING] No local stream, requesting getUserMedia"
        );
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: { width: 1280, height: 720 },
          });
          console.log("[START_PRODUCING] getUserMedia succeeded");
          localStreamRef.current = stream;
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
            localVideoRef.current.muted = true;
            localVideoRef.current
              .play()
              .catch((err) =>
                console.warn("[START_PRODUCING] Local video play blocked:", err)
              );
          }
        } catch (err) {
          console.error("[START_PRODUCING] getUserMedia failed:", err);
          return;
        }
      } else {
        console.log("[START_PRODUCING] Already have local stream");
      }

      // Create send transport
      const ridToUse = overrideRoomId || roomId;
      console.log(
        "[START_PRODUCING] Creating send transport for roomId:",
        ridToUse
      );
      const sendTransportRes = await new Promise<any>((resolve, reject) => {
        socket.emit(
          "createTransport",
          { roomId: ridToUse, kind: "send" },
          (res: any) => {
            if (res.error) {
              console.error(
                "[START_PRODUCING] createTransport error:",
                res.error
              );
              reject(new Error(res.error));
            } else {
              console.log(
                "[START_PRODUCING] createTransport response received"
              );
              resolve(res);
            }
          }
        );
      });

      const sendTransport = device.createSendTransport(sendTransportRes);
      sendTransportRef.current = sendTransport;
      console.log(
        "[START_PRODUCING] Send transport created:",
        sendTransport.id
      );

      sendTransport.on(
        "connect",
        ({ dtlsParameters }, callback, errCallback) => {
          console.log("[START_PRODUCING] Send transport connecting...");
          socket.emit(
            "connectTransport",
            { roomId: ridToUse, transportId: sendTransport.id, dtlsParameters },
            (res: any) => {
              if (res.error) {
                console.error("[START_PRODUCING] Connect error:", res.error);
                return errCallback(res.error);
              }
              console.log("[START_PRODUCING] Send transport connected");
              callback();
            }
          );
        }
      );

      sendTransport.on(
        "produce",
        async ({ kind, rtpParameters }, callback, errCallback) => {
          try {
            console.log("[START_PRODUCING] Produce event for kind:", kind);
            const res = await new Promise<any>((resolve, reject) => {
              socket.emit(
                "produce",
                {
                  roomId: ridToUse,
                  transportId: sendTransport.id,
                  kind,
                  rtpParameters,
                },
                (r: any) => {
                  if (r.error) reject(r.error);
                  else resolve(r);
                }
              );
            });
            callback({ id: res.id });
            console.log("Producer created:", kind, res.id);
          } catch (error) {
            console.error("Produce error:", error);
            errCallback(error as Error);
          }
        }
      );

      // Produce local tracks
      const stream = localStreamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) {
          try {
            await sendTransport.produce({ track });
          } catch (err) {
            console.error("sendTransport.produce failed:", err);
          }
        }
      }
    } catch (error) {
      console.error("startProducing error:", error);
    }
  };

  const stopProducing = () => {
    try {
      // Stop local tracks
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }

      // Close send transport
      if (sendTransportRef.current) {
        try {
          sendTransportRef.current.close();
        } catch (_) {}
        sendTransportRef.current = null;
      }
    } catch (err) {
      console.error("stopProducing error:", err);
    }
  };

  const removeRemoteVideo = (peerId: string) => {
    const keysToRemove: string[] = [];
    consumedProducersRef.current.forEach((key) => {
      if (key.startsWith(`${peerId}-`)) {
        keysToRemove.push(key);
      }
    });
    keysToRemove.forEach((key) => consumedProducersRef.current.delete(key));

    setRemoteVideos((prev) => prev.filter((v) => v.peerId !== peerId));
  };

  const updateParticipants = async (rid: string) => {
    try {
      const response = await fetch(`/api/rooms/${rid}/participants`);
      if (!response.ok) return;

      const { participants } = await response.json();
      setParticipants(participants);
    } catch (error) {
      console.error("Error updating participants:", error);
    }
  };

  const leaveRoom = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
    }

    if (socketRef.current) {
      socketRef.current.disconnect();
    }

    if (sendTransportRef.current) {
      sendTransportRef.current.close();
    }

    if (recvTransportRef.current) {
      recvTransportRef.current.close();
    }

    consumedProducersRef.current.clear();
    setView("landing");
    setRoomId("");
    setRemoteVideos([]);
    setParticipants([]);
  };

  if (view === "landing") {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white rounded-lg shadow-md p-8 border border-gray-200">
          <h1 className="text-3xl font-bold text-gray-900 mb-2 text-center">
            Video Conference
          </h1>
          <p className="text-base text-gray-600 text-center mb-8">
            WebRTC video conferencing platform
          </p>

          <div className="space-y-4 mb-6">
            <input
              type="text"
              placeholder="Your name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && createRoom()}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-gray-700"
            />
            <button onClick={createRoom} className="btn-primary w-full">
              Create Room
            </button>
          </div>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-3 bg-gray-50 text-gray-600 font-medium">
                OR
              </span>
            </div>
          </div>

          <div className="space-y-4">
            <input
              type="text"
              placeholder="Room ID"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && joinRoom()}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-gray-700"
            />
            <button onClick={joinRoom} className="btn-secondary w-full">
              Join Room
            </button>
          </div>

          {error && (
            <p className="mt-6 p-4 bg-red-50 text-red-700 rounded-lg text-center font-medium border border-red-200">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-900 text-white flex flex-col overflow-hidden">
      <div className="bg-gray-950 border-b border-gray-700 px-6 py-4">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-2xl font-bold">Conference Room</h2>
          <button onClick={leaveRoom} className="btn-danger">
            Leave Room
          </button>
        </div>

        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <p className="text-sm text-gray-400 mb-1">Room ID</p>
          <div className="flex justify-between items-center gap-3">
            <code className="text-lg font-mono text-gray-100">{roomId}</code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(roomId);
                alert("Room ID copied to clipboard");
              }}
              className="px-3 py-2 bg-gray-700 text-gray-100 rounded font-semibold text-sm hover:bg-gray-600 transition"
            >
              Copy
            </button>
          </div>
        </div>
      </div>
      {/* Waiting banner for users who are pending host approval */}
      {yourRole === "waiting" && (
        <div className="bg-yellow-100 text-yellow-900 p-3 text-center">
          You are waiting for the host to approve your join. You will be able to
          view the room after approval.
        </div>
      )}
      <div className="flex-1 flex gap-6 p-6 overflow-hidden">
        <div className="flex-1 flex flex-col gap-4 overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 auto-rows-max">
            <div className="video-tile md:col-span-1">
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className="video-element"
              />
              <div className="video-label">{displayName} (You)</div>
            </div>

            {remoteVideos.map((remote) => (
              <RemoteVideoTile key={remote.peerId} video={remote} />
            ))}
          </div>
        </div>

        <div className="w-80 bg-gray-800 rounded-lg p-6 flex flex-col gap-6 overflow-y-auto border border-gray-700">
          <div>
            <h3 className="text-lg font-bold mb-4">
              Participants ({participants.length})
            </h3>
            <ul className="space-y-3">
              {participants.map((p) => (
                <li
                  key={p.id}
                  className={`rounded-lg p-3 flex justify-between items-center transition ${
                    (p as any).role === "waiting"
                      ? "bg-yellow-900 hover:bg-yellow-800"
                      : "bg-gray-700 hover:bg-gray-600"
                  }`}
                >
                  <div className="flex flex-col">
                    <span className="font-medium text-sm">{p.displayName}</span>
                    {(p as any).role && (
                      <span className="text-xs text-gray-300 capitalize">
                        {(p as any).role === "waiting" && (
                          <span className="text-yellow-200">Waiting...</span>
                        )}
                        {(p as any).role === "host" && (
                          <span className="text-blue-300">👑 Host</span>
                        )}
                        {(p as any).role === "producer" && (
                          <span className="text-green-300">📹 Producer</span>
                        )}
                        {(p as any).role === "consumer" && (
                          <span className="text-gray-400">👁️ Viewer</span>
                        )}
                      </span>
                    )}
                  </div>
                  <span className="text-sm text-gray-300">
                    {(p as any).role !== "waiting" && (
                      <>
                        {p.hasAudio && <span className="mr-2">🎙️</span>}
                        {p.hasVideo && <span>📹</span>}
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {/* Permission request UI for host */}
          <PermissionRequestNotification
            requests={permissionRequests}
            onApprove={(peerId: string) => {
              console.log("[APPROVE] Allow clicked for peerId:", peerId);
              console.log("[APPROVE] Current roomId:", roomId);
              if (!socketRef.current) {
                console.error("[APPROVE] Socket not available");
                return;
              }
              console.log("[APPROVE] Emitting approveJoin with payload:", {
                roomId,
                peerId,
                promote: true,
              });
              socketRef.current.emit(
                "approveJoin",
                { roomId, peerId, promote: true },
                (res: any) => {
                  console.log("[APPROVE] Callback received, res:", res);
                  if (res && res.approved) {
                    console.log(
                      "[APPROVE] Success! Approved:",
                      res.promoted,
                      "removing notification"
                    );
                    setPermissionRequests((prev) => {
                      const filtered = prev.filter((r) => r.peerId !== peerId);
                      console.log(
                        "[APPROVE] Requests before:",
                        prev.length,
                        "after:",
                        filtered.length
                      );
                      return filtered;
                    });
                  } else if (res && res.error) {
                    console.error("[APPROVE] Server error:", res.error);
                    alert("Failed to approve: " + res.error);
                  } else {
                    console.error("[APPROVE] Unexpected response:", res);
                  }
                }
              );
              console.log("[APPROVE] Emit sent");
            }}
            onDeny={(peerId: string) => {
              console.log("[DENY] Denying join for peerId:", peerId);
              setPermissionRequests((prev) =>
                prev.filter((r) => r.peerId !== peerId)
              );
            }}
          />

          {/* Speaking permission button for consumers */}
          <div>
            <SpeakingPermissionButton
              role={yourRole}
              onRequest={() => {
                if (!socketRef.current) return;
                socketRef.current.emit(
                  "requestSpeakingPermission",
                  { roomId },
                  (res: any) => {
                    if (res.error) console.error(res.error);
                  }
                );
              }}
            />
          </div>
          {inviteLink && (
            <div className="border-t border-gray-600 pt-4">
              <h4 className="font-bold mb-3 text-sm">Invite Link</h4>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={inviteLink}
                  readOnly
                  className="flex-1 px-3 py-2 bg-gray-700 text-gray-100 rounded text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 border border-gray-600"
                />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(inviteLink);
                    alert("Copied to clipboard");
                  }}
                  className="btn-copy"
                >
                  Copy
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RemoteVideoTile({
  video,
}: {
  video: {
    peerId: string;
    displayName: string;
    stream: MediaStream;
    audioStream?: MediaStream;
  };
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (videoRef.current && video.stream.getTracks().length > 0) {
      try {
        videoRef.current.srcObject = video.stream;
        // Mute the video element (use separate audio element for sound)
        videoRef.current.muted = true;
        videoRef.current.play().catch((err) => {
          console.warn("Remote video play() blocked:", err);
        });
      } catch (err) {
        console.warn("Failed to attach remote stream:", err);
      }
    }
  }, [video.stream]);

  useEffect(() => {
    if (audioRef.current && video.audioStream) {
      audioRef.current.srcObject = video.audioStream;
    }
  }, [video.audioStream]);

  return (
    <div className="video-tile">
      <video ref={videoRef} autoPlay playsInline className="video-element" />
      <audio ref={audioRef} autoPlay playsInline />
      <div className="video-label">{video.displayName}</div>
    </div>
  );
}

export default App;
