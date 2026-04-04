import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DaemonClient } from "../src/daemon-client";

// Minimal frame helpers - same protocol as cli/src/ipc/framing.ts
function encodeFrame(type: number, sessionId: string, payload: Buffer): Buffer {
  const sidBuf = Buffer.from(sessionId, "utf-8");
  const header = Buffer.alloc(1 + 4 + sidBuf.length + 4);
  let offset = 0;
  header.writeUInt8(type, offset); offset += 1;
  header.writeUInt32BE(sidBuf.length, offset); offset += 4;
  sidBuf.copy(header, offset); offset += sidBuf.length;
  header.writeUInt32BE(payload.length, offset);
  return Buffer.concat([header, payload]);
}

function encodeJsonRpc(obj: Record<string, unknown>): Buffer {
  return encodeFrame(0xff, "", Buffer.from(JSON.stringify(obj)));
}

function testSocketPath(tmpDir: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\carryon-dc-test-${Date.now()}`;
  }
  return path.join(tmpDir, "test.sock");
}

describe("DaemonClient", () => {
  let tmpDir: string;
  let socketPath: string;
  let mockServer: net.Server;
  let client: DaemonClient;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carryon-dc-test-"));
    socketPath = testSocketPath(tmpDir);
  });

  afterEach(async () => {
    client?.dispose();
    await new Promise<void>((resolve) => {
      if (mockServer?.listening) mockServer.close(() => resolve());
      else resolve();
    });
    fs.rmSync(tmpDir, { recursive: true });
  });

  function startMockServer(
    handler: (data: Buffer, socket: net.Socket) => void,
    onConnect?: (socket: net.Socket) => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      mockServer = net.createServer((socket) => {
        onConnect?.(socket);
        socket.on("data", (data) => handler(data, socket));
      });
      mockServer.listen(socketPath, () => resolve());
    });
  }

  test("connects and calls an RPC method", async () => {
    await startMockServer((data, socket) => {
      // Parse incoming frame: skip type(1) + sidLen(4) + sid(0) + payloadLen(4)
      const payloadLen = data.readUInt32BE(5);
      const payload = JSON.parse(data.subarray(9, 9 + payloadLen).toString());
      expect(payload.method).toBe("session.list");

      const response = { jsonrpc: "2.0", id: payload.id, result: [] };
      socket.write(encodeJsonRpc(response));
    });

    client = new DaemonClient();
    await client.connect(socketPath);
    const result = await client.call<unknown[]>("session.list");
    expect(result).toEqual([]);
  });

  test("rejects on RPC error", async () => {
    await startMockServer((data, socket) => {
      const payloadLen = data.readUInt32BE(5);
      const payload = JSON.parse(data.subarray(9, 9 + payloadLen).toString());
      const response = {
        jsonrpc: "2.0",
        id: payload.id,
        error: { code: -32601, message: "Method not found" },
      };
      socket.write(encodeJsonRpc(response));
    });

    client = new DaemonClient();
    await client.connect(socketPath);
    await expect(client.call("bad.method")).rejects.toThrow("Method not found");
  });

  test("receives notifications", async () => {
    let serverSocket: net.Socket;
    await startMockServer((_data, _socket) => {
      // data handler (unused for this test)
    }, (socket) => {
      serverSocket = socket;
    });

    client = new DaemonClient();
    await client.connect(socketPath);

    const received: unknown[] = [];
    client.onNotification("session.created", (params) => received.push(params));

    // Server pushes a notification
    const notification = { jsonrpc: "2.0", method: "session.created", params: { id: "native-abc" } };
    serverSocket!.write(encodeJsonRpc(notification));

    // Give it a tick to arrive
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ id: "native-abc" });
  });

  test("throws when calling without connection", async () => {
    client = new DaemonClient();
    await expect(client.call("session.list")).rejects.toThrow("Not connected");
  });

  test("rejects pending requests on disconnect", async () => {
    let serverSocket: net.Socket;
    await startMockServer((_data, _socket) => {
      // Don't respond - let the request hang
    }, (socket) => {
      serverSocket = socket;
    });

    client = new DaemonClient();
    await client.connect(socketPath);

    // Start a call but don't respond
    const pending = client.call("session.list");

    // Server drops the connection
    serverSocket!.destroy();

    await expect(pending).rejects.toThrow("Disconnected");
  });

  test("fires onConnectionChange on connect and disconnect", async () => {
    let serverSocket: net.Socket;
    await startMockServer((_data, _socket) => {}, (socket) => {
      serverSocket = socket;
    });

    client = new DaemonClient();
    const changes: boolean[] = [];
    client.onConnectionChange = (connected) => { changes.push(connected); };

    await client.connect(socketPath);
    expect(changes).toEqual([true]);

    // Server drops connection
    serverSocket!.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(changes).toEqual([true, false]);
  });

  test("reconnects after disconnect when enableReconnect is active", async () => {
    let serverSocket: net.Socket;
    await startMockServer((data, socket) => {
      // Echo back a response for any request
      const payloadStart = 9; // type(1) + sidLen(4) + sid(0) + payloadLen(4)
      if (data.length > payloadStart) {
        const payloadLen = data.readUInt32BE(5);
        const payload = JSON.parse(data.subarray(payloadStart, payloadStart + payloadLen).toString());
        socket.write(encodeJsonRpc({ jsonrpc: "2.0", id: payload.id, result: "ok" }));
      }
    }, (socket) => {
      serverSocket = socket;
    });

    client = new DaemonClient();
    const changes: boolean[] = [];
    client.onConnectionChange = (connected) => { changes.push(connected); };

    await client.connect(socketPath);
    client.enableReconnect(100); // fast interval for testing

    // Drop connection
    serverSocket!.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(client.connected).toBe(false);

    // Wait for reconnect
    await new Promise((r) => setTimeout(r, 250));
    expect(client.connected).toBe(true);
    expect(changes).toEqual([true, false, true]);
  });

  test("call times out after specified duration", async () => {
    await startMockServer((_data, _socket) => {
      // Never respond
    });

    client = new DaemonClient();
    await client.connect(socketPath);

    await expect(
      client.call("session.list", {}, 100),
    ).rejects.toThrow('RPC call "session.list" timed out after 100ms');
  });

  test("handles fragmented frames across multiple data events", async () => {
    let serverSocket: net.Socket;
    await startMockServer((_data, _socket) => {}, (socket) => {
      serverSocket = socket;
    });

    client = new DaemonClient();
    await client.connect(socketPath);

    const received: unknown[] = [];
    client.onNotification("test.event", (params) => received.push(params));

    // Send a notification in two fragments
    const notification = { jsonrpc: "2.0", method: "test.event", params: { value: 42 } };
    const frame = encodeJsonRpc(notification);
    const mid = Math.floor(frame.length / 2);

    serverSocket!.write(frame.subarray(0, mid));
    await new Promise((r) => setTimeout(r, 20));
    serverSocket!.write(frame.subarray(mid));

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ value: 42 });
  });
});
