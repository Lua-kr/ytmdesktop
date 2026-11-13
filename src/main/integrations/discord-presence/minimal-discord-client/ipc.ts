import EventEmitter from "events";
import { Socket } from "net";

export enum OPCode {
  HANDSHAKE = 0,
  FRAME = 1,
  CLOSE = 2,
  PING = 3,
  PONG = 4
}

export default class IPCClient extends EventEmitter {
  private socket!: Socket;
  private receiveBuffer = Buffer.alloc(0);

  constructor() {
    super();

    this.createSocket();
  }

  private createSocket() {
    this.receiveBuffer = Buffer.alloc(0);
    this.socket = new Socket();
    this.socket.on("connect", () => {
      this.emit("connect");
    });
    this.socket.on("close", (hadError: boolean) => {
      this.emit("close", hadError);
    });
    this.socket.on("error", error => {
      this.emit("error", error);
    });
    this.socket.on("data", (chunk: Buffer) => {
      // Node sockets may split a frame or concatenate multiple frames.
      // Parsing one data event as one frame loses Discord RPC responses.
      this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
      while (this.receiveBuffer.length >= 8) {
        const op = this.receiveBuffer.readInt32LE(0);
        const length = this.receiveBuffer.readInt32LE(4);
        if (length < 0 || length > 8 * 1024 * 1024) {
          this.receiveBuffer = Buffer.alloc(0);
          this.socket.destroy();
          return;
        }
        if (this.receiveBuffer.length < 8 + length) return;
        const payload = this.receiveBuffer.subarray(8, 8 + length);
        this.receiveBuffer = this.receiveBuffer.subarray(8 + length);
        try {
          const json = JSON.parse(payload.toString("utf-8"));
          this.emit("data", { op, json });
        } catch {
          // Ignore malformed frames without losing subsequent valid frames.
        }
      }
    });
  }

  public connect(ipcPath: string) {
    if (this.socket.destroyed) {
      this.createSocket();
    }
    this.socket.connect(ipcPath);
  }

  public send(data: unknown, op = OPCode.FRAME): boolean {
    // Do not silently discard an activity-clear request or recreate a
    // disconnected socket without completing another handshake.
    if (this.socket.destroyed || !this.socket.writable) return false;
    const json = JSON.stringify(data);
    const length = Buffer.byteLength(json);
    const buffer = Buffer.alloc(8 + length);
    buffer.writeInt32LE(op, 0);
    buffer.writeInt32LE(length, 4);
    buffer.write(json, 8, length);

    try {
      this.socket.write(buffer);
      return true; // A write is queued; RPC acknowledgment is tracked separately.
    } catch {
      return false;
    }
  }

  public close() {
    if (!this.socket.destroyed) {
      this.send({}, OPCode.CLOSE);
      this.socket.end();
    }
  }

  public destroy() {
    this.removeAllListeners();
    this.socket.destroy();
  }
}
