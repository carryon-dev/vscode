import * as net from "net";

// Frame types - only JsonRpc (0xFF) is used by the extension
const FRAME_TYPE_JSONRPC = 0xff;

interface Frame {
  type: number;
  sessionId: string;
  payload: Buffer;
}

type NotificationListener = (params: unknown) => void;

export class DaemonClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private nextId = 0;
  private notificationListeners = new Map<string, Set<NotificationListener>>();
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private _socketPath: string | null = null;
  private _connected = false;
  private _onConnectionChange: ((connected: boolean) => void) | null = null;

  get connected(): boolean {
    return this._connected;
  }

  set onConnectionChange(cb: ((connected: boolean) => void) | null) {
    this._onConnectionChange = cb;
  }

  async connect(socketPath: string): Promise<void> {
    this._socketPath = socketPath;
    this.stopReconnect();
    return this.doConnect(socketPath);
  }

  private doConnect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath, () => {
        this.socket = socket;
        this._connected = true;
        this._onConnectionChange?.(true);
        resolve();
      });
      socket.on("error", (err) => {
        if (!this._connected) {
          reject(err);
        } else {
          // Post-connect error: force close to ensure onDisconnect fires
          socket.destroy();
        }
      });
      socket.on("data", (data) => this.onData(data));
      socket.on("close", () => this.onDisconnect());
    });
  }

  dispose(): void {
    this._onConnectionChange = null;
    this.stopReconnect();
    this.socket?.destroy();
    this.socket = null;
    this._connected = false;
    this.rejectAll("Disposed");
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    if (!this.socket || !this._connected) throw new Error("Not connected");

    this.nextId = (this.nextId + 1) & 0x7fffffff;
    const id = this.nextId;
    const message = JSON.stringify({ jsonrpc: "2.0", method, params, id });
    const frame = this.encodeJsonRpcFrame(message);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC call "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result as T); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.socket!.write(frame);
    });
  }

  onNotification(method: string, listener: NotificationListener): void {
    let listeners = this.notificationListeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.notificationListeners.set(method, listeners);
    }
    listeners.add(listener);
  }

  offNotification(method: string, listener: NotificationListener): void {
    this.notificationListeners.get(method)?.delete(listener);
  }

  enableReconnect(intervalMs = 5000): void {
    this.stopReconnect();
    this.reconnectTimer = setInterval(async () => {
      if (this._connected || !this._socketPath) return;
      try {
        await this.doConnect(this._socketPath);
      } catch {
        // Will retry on next interval
      }
    }, intervalMs);
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private onDisconnect(): void {
    this.socket = null;
    this._connected = false;
    this.rejectAll("Disconnected");
    this._onConnectionChange?.(false);
  }

  private rejectAll(reason: string): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.drain();
  }

  private drain(): void {
    while (true) {
      if (this.buffer.length < 5) break;

      const type = this.buffer.readUInt8(0);
      const sessionIdLen = this.buffer.readUInt32BE(1);
      if (sessionIdLen > 1024) {
        this.socket?.destroy();
        return;
      }
      const payloadLenOffset = 5 + sessionIdLen;
      if (this.buffer.length < payloadLenOffset + 4) break;

      const payloadLen = this.buffer.readUInt32BE(payloadLenOffset);
      if (payloadLen > 64 * 1024 * 1024) {
        this.socket?.destroy();
        return;
      }
      const totalLen = payloadLenOffset + 4 + payloadLen;
      if (this.buffer.length < totalLen) break;

      const sessionId = this.buffer.subarray(5, 5 + sessionIdLen).toString("utf-8");
      const payload = Buffer.from(this.buffer.subarray(payloadLenOffset + 4, totalLen));
      this.buffer = this.buffer.subarray(totalLen);

      this.handleFrame({ type, sessionId, payload });
    }
  }

  private handleFrame(frame: Frame): void {
    if (frame.type !== FRAME_TYPE_JSONRPC) return; // Extension only handles JSON-RPC

    let message: unknown;
    try {
      message = JSON.parse(frame.payload.toString());
    } catch (err) {
      return;
    }
    if (!message || typeof message !== "object") return;
    const msg = message as Record<string, unknown>;

    // Response (has id)
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pendingRequests.get(msg.id as number);
      if (pending) {
        this.pendingRequests.delete(msg.id as number);
        if (msg.error) {
          pending.reject(new Error((msg.error as { message: string }).message));
        } else {
          pending.resolve(msg.result);
        }
      }
    }

    // Notification (has method, no id)
    if (msg.method && msg.id == null) {
      const listeners = this.notificationListeners.get(msg.method as string);
      if (listeners) {
        for (const listener of listeners) {
          listener(msg.params);
        }
      }
    }
  }

  private encodeJsonRpcFrame(json: string): Buffer {
    const payload = Buffer.from(json);
    // type(1) + sessionIdLen(4) + sessionId(0) + payloadLen(4) + payload
    const header = Buffer.alloc(9);
    header.writeUInt8(FRAME_TYPE_JSONRPC, 0);
    header.writeUInt32BE(0, 1); // sessionId length = 0
    header.writeUInt32BE(payload.length, 5);
    return Buffer.concat([header, payload]);
  }
}
