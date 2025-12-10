import os from "os";
import * as mediasoup from "mediasoup";
import type { Worker } from "mediasoup/node/lib/WorkerTypes";

const WORKER_NUM = Math.max(1, Math.min(os.cpus().length, 4)); 

export class MediasoupService {
  private workers: Worker[] = [];
  private nextWorker = 0;

  async createWorkers() {
    for (let i = 0; i < WORKER_NUM; ++i) {
      const worker = await mediasoup.createWorker({
        rtcMinPort: 10000 + i * 1000,
        rtcMaxPort: 10000 + (i + 1) * 1000 - 1,
        logLevel: "warn",
        logTags: ["info", "ice", "dtls", "rtp", "srtp"],
      });

      worker.on("died", () => {
        console.error("mediasoup worker died, exiting in 2s ...");
        setTimeout(() => process.exit(1), 2000);
      });

      this.workers.push(worker);
    }
    console.log(`Created ${this.workers.length} mediasoup workers`);
  }

  getWorker(): Worker {
    const worker = this.workers[this.nextWorker];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    return worker;
  }

  getWorkers(): Worker[] {
    return this.workers;
  }

  async closeAll() {
    for (const worker of this.workers) {
      await worker.close();
    }
  }
}

export const mediasoupService = new MediasoupService();
