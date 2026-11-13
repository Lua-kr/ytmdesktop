import EventEmitter from "events";
import IPCClient, { OPCode } from "./ipc";
import { DiscordActivity } from "./types";
import { randomUUID } from "crypto";
import log from "electron-log";
import { existsSync, statSync } from "node:fs";

function directoryExists(dirPath: string): boolean {
  try {
    return existsSync(dirPath) && statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function getIPCPath(id: number): string {
  if (process.platform === "win32") {
    return `\\\\?\\pipe\\discord-ipc-${id}`;
  }

  const dirtyPrefix = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  const prefix = dirtyPrefix.replace(/\/$/, "");
  const discordSnapDir = "snap.discord";
  const discordFlatpakDir = "com.discordapp.Discord";

  if (directoryExists(`${prefix}/${discordSnapDir}`)) {
    return `${prefix}/${discordSnapDir}/discord-ipc-${id}`;
  } else if (directoryExists(`${prefix}/${discordFlatpakDir}`)) {
    return `${prefix}/app/${discordFlatpakDir}/discord-ipc-${id}`;
  } else {
    return `${prefix}/discord-ipc-${id}`;
  }
}

export default class DiscordClient extends EventEmitter {
  private clientId: string | null = null;
  private connectionPromise: Promise<void> | null = null;
  private ipcClient = new IPCClient();
  private connected = false;
  private pendingClearNonce: string | null = null;

  constructor(clientId: string) {
    super();

    this.clientId = clientId;
  }

  public connect() {
    if (this.connectionPromise) return this.connectionPromise;
    this.ipcClient.removeAllListeners();

    // Promise chaining is OK here, we're looping through different IPC paths and seeing which one works
    // eslint-disable-next-line no-async-promise-executor
    this.connectionPromise = new Promise(async (resolve, reject) => {
      log.debug("dipc: initiated connection loop over 10 ids");
      let id = 0;
      while (id < 10) {
        try {
          await new Promise<void>((ipcResolve, ipcReject) => {
            const ipcPath = getIPCPath(id);
            log.debug("dipc: connecting to discord at", ipcPath);
            this.ipcClient.once("close", () => {
              this.ipcClient.removeAllListeners();
              log.debug("dipc: failed to connect to discord at", ipcPath);
              ipcReject();
            });
            this.ipcClient.once("error", error => {
              log.error("dipc: socket error connecting to discord", error);
            });
            this.ipcClient.once("connect", () => {
              log.debug("dipc: connected to discord at", ipcPath);
              this.ipcClient.removeAllListeners();
              ipcResolve();
            });
            this.ipcClient.connect(getIPCPath(id));
          });

          this.connected = true;
          this.pendingClearNonce = null;
          this.ipcClient.on("close", () => {
            this.connected = false;
            this.pendingClearNonce = null;
            this.emit("close");
          });
          // IPCClient emits ONE { op, json } object, not two arguments.
          this.ipcClient.on("data", ({ op, json }: { op: OPCode; json: unknown }) => {
            if (op === OPCode.PING) {
              this.ipcClient.send(json, OPCode.PONG);
              return;
            }
            if (op !== OPCode.FRAME || !json || typeof json !== "object") return;
            const frame = json as { cmd?: string; nonce?: string; evt?: string; data?: unknown };
            if (frame.cmd !== "SET_ACTIVITY" || !frame.nonce || frame.nonce !== this.pendingClearNonce) return;
            this.pendingClearNonce = null;
            if (frame.evt === "ERROR") {
              this.emit("activity-clear-error", frame.data);
            } else {
              this.emit("activity-cleared");
            }
          });

          if (!this.ipcClient.send(
            { v: 1, client_id: this.clientId },
            OPCode.HANDSHAKE
          )) {
            throw new Error("Failed to send Discord IPC handshake");
          }
          this.emit("connect");

          this.connectionPromise = null;
          resolve();

          return;
        } catch {
          id++;
        }
      }

      this.connectionPromise = null;
      reject();
    });

    return this.connectionPromise;
  }

  public close() {
    if (this.connected) {
      this.ipcClient.once("close", () => {
        this.ipcClient.removeAllListeners();
      });
      this.ipcClient.close();
    }
  }

  public destroy() {
    this.connected = false;
    this.pendingClearNonce = null;
    this.removeAllListeners();
    this.ipcClient.destroy();
  }

  public setActivity(activity: DiscordActivity): boolean {
    if (!this.connected) return false;
    this.pendingClearNonce = null;
    return this.ipcClient.send({
      cmd: "SET_ACTIVITY",
      args: {
        pid: process.pid,
        activity
      },
      nonce: randomUUID()
    });
  }

  public clearActivity(): boolean {
    if (!this.connected) return false;
    const nonce = randomUUID();
    this.pendingClearNonce = nonce;
    // Explicit null is the portable Discord RPC form for clearing an activity.
    const sent = this.ipcClient.send({
      cmd: "SET_ACTIVITY",
      args: {
        pid: process.pid,
        activity: null
      },
      nonce
    });
    if (!sent) this.pendingClearNonce = null;
    return sent;
  }
}
