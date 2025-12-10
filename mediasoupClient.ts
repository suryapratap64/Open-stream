import { io } from "socket.io-client";
import * as mediasoupClient from "mediasoup-client";

const socket = io("http://localhost:3000");

let device: mediasoupClient.Device;
let sendTransport: mediasoupClient.SendTransport | null = null;
let recvTransport: mediasoupClient.RecvTransport | null = null;
const consumers = new Map<string, mediasoupClient.Consumer>();


async function join(
  roomId: string,
  displayName: string,
  localStream: MediaStream
) {
  try {
    // Initialize device
    device = new Device();

    // Get router RTP capabilities from server
    const joinRes = await new Promise<any>((resolve) =>
      socket.emit(
        "join",
        {
          roomId,
          displayName,
          rtpCapabilities: device.rtpCapabilities,
        },
        resolve
      )
    );

    if (joinRes.error) {
      console.error("Join error:", joinRes.error);
      return;
    }

    // Load device with router capabilities
    await device.load({ routerRtpCapabilities: joinRes.rtpCapabilitiesRouter });
    console.log("✓ Device loaded");

    // Create send transport
    const sendTransportInfo = await new Promise<any>((resolve) =>
      socket.emit("createTransport", { roomId }, resolve)
    );

    sendTransport = device.createSendTransport(sendTransportInfo);

    // Handle DTLS connection
    sendTransport.on(
      "connect",
      ({ dtlsParameters }, callback, errorCallback) => {
        socket.emit(
          "connectTransport",
          {
            roomId,
            transportId: sendTransport.id,
            dtlsParameters,
          },
          (res: any) => {
            if (res.error) return errorCallback(res.error);
            callback();
          }
        );
      }
    );

    // Handle produce
    sendTransport.on(
      "produce",
      async ({ kind, rtpParameters }, callback, errCallback) => {
        socket.emit(
          "produce",
          {
            roomId,
            transportId: sendTransport.id,
            kind,
            rtpParameters,
          },
          (res: any) => {
            if (res.error) return errCallback(res.error);
            callback({ id: res.id });
          }
        );
      }
    );

    // Produce local tracks
    for (const track of localStream.getTracks()) {
      await sendTransport.produce({ track });
    }

    console.log("✓ Local stream published");

    // Listen for new producers
    socket.on(
      "newProducer",
      async ({ producerId, producerSocketId, kind, producerDisplayName }) => {
        try {
          // Create recv transport if needed
          if (!recvTransport) {
            const recvTransportInfo = await new Promise<any>((resolve) =>
              socket.emit("createTransport", { roomId }, resolve)
            );

            recvTransport = device.createRecvTransport(recvTransportInfo);

            recvTransport.on(
              "connect",
              ({ dtlsParameters }, callback, errorCallback) => {
                socket.emit(
                  "connectTransport",
                  {
                    roomId,
                    transportId: recvTransport.id,
                    dtlsParameters,
                  },
                  (res: any) => {
                    if (res.error) return errorCallback(res.error);
                    callback();
                  }
                );
              }
            );
          }

          // Consume the producer
          const consumeRes = await new Promise<any>((resolve) =>
            socket.emit(
              "consume",
              {
                roomId,
                producerId,
                rtpCapabilities: device.rtpCapabilities,
              },
              resolve
            )
          );

          if (consumeRes.error) {
            console.error("Consume error:", consumeRes.error);
            return;
          }

          const consumer = await recvTransport.consume({
            id: consumeRes.id,
            producerId: consumeRes.producerId,
            kind: consumeRes.kind,
            rtpParameters: consumeRes.rtpParameters,
          });

          consumers.set(consumeRes.id, consumer);

          // Resume consumer
          socket.emit("resumeConsumer", {
            roomId,
            consumerId: consumeRes.id,
          });

          console.log(`✓ Consuming ${kind} from ${producerDisplayName}`);

          // Get remote track
          const remoteStream = new MediaStream();
          remoteStream.addTrack(consumer.track);

          // Emit event for UI to display remote stream
          document.dispatchEvent(
            new CustomEvent("remoteStream", {
              detail: {
                stream: remoteStream,
                producerDisplayName,
                producerSocketId,
              },
            })
          );
        } catch (error) {
          console.error("Error consuming producer:", error);
        }
      }
    );
  } catch (error) {
    console.error("Join error:", error);
  }
}

// Disconnect function
function disconnect() {
  if (sendTransport) sendTransport.close();
  if (recvTransport) recvTransport.close();
  consumers.forEach((consumer) => consumer.close());
  consumers.clear();
  socket.disconnect();
}

export { join, disconnect };
