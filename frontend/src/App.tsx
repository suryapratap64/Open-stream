import { useState, useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import * as mediasoupClient from "mediasoup-client";

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

  const enterRoom = async (rid: string, name: string, link = "") => {
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

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: 1280, height: 720 },
      });

      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const device = new mediasoupClient.Device();
      deviceRef.current = device;

      const joinRes = await new Promise<any>((resolve, reject) => {
        socket.emit(
          "join",
          {
            roomId: rid,
            displayName: name,
            rtpCapabilities: {},
          },
          (res: any) => {
            if (res.error) reject(new Error(res.error));
            else resolve(res);
          }
        );
      });

      await device.load({
        routerRtpCapabilities: joinRes.rtpCapabilitiesRouter,
      });

      const sendTransportRes = await new Promise<any>((resolve, reject) => {
        socket.emit(
          "createTransport",
          { roomId: rid, kind: "send" },
          (res: any) => {
            if (res.error) reject(new Error(res.error));
            else resolve(res);
          }
        );
      });

      const sendTransport = device.createSendTransport(sendTransportRes);
      sendTransportRef.current = sendTransport;

      sendTransport.on(
        "connect",
        ({ dtlsParameters }, callback, errCallback) => {
          socket.emit(
            "connectTransport",
            { roomId: rid, transportId: sendTransport.id, dtlsParameters },
            (res: any) => {
              if (res.error) return errCallback(res.error);
              callback();
            }
          );
        }
      );

      sendTransport.on(
        "produce",
        async ({ kind, rtpParameters }, callback, errCallback) => {
          try {
            const res = await new Promise<any>((resolve, reject) => {
              socket.emit(
                "produce",
                {
                  roomId: rid,
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

      for (const track of stream.getTracks()) {
        await sendTransport.produce({ track });
      }

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
            await consumeProducer(rid, producerId, producerDisplayName, peerId);
          }
        }
      }

      setInviteLink(link || `http://localhost:5173?room=${rid}`);
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
                  className="bg-gray-700 rounded-lg p-3 flex justify-between items-center hover:bg-gray-600 transition"
                >
                  <span className="font-medium text-sm">{p.displayName}</span>
                  <span className="text-sm text-gray-300">
                    {p.hasAudio && <span className="mr-2">Audio</span>}
                    {p.hasVideo && <span>Video</span>}
                  </span>
                </li>
              ))}
            </ul>
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
      videoRef.current.srcObject = video.stream;
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
