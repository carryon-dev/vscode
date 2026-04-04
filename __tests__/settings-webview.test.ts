import { describe, it, expect, vi, beforeEach } from "vitest";
import { SettingsWebviewProvider } from "../src/settings-webview";
import * as vscode from "vscode";

type NotificationListener = (params: unknown) => void;

function createMockClient() {
  const listeners = new Map<string, Set<NotificationListener>>();
  return {
    connected: true,
    onNotification(method: string, listener: NotificationListener) {
      let set = listeners.get(method);
      if (!set) { set = new Set(); listeners.set(method, set); }
      set.add(listener);
    },
    offNotification(method: string, listener: NotificationListener) {
      listeners.get(method)?.delete(listener);
    },
    call: vi.fn().mockResolvedValue(undefined),
    // Test helper: fire a notification
    _fire(method: string, params: unknown) {
      for (const l of listeners.get(method) ?? []) l(params);
    },
    _listeners: listeners,
  };
}

function createMockWebviewView() {
  const messageHandlers: Array<(msg: unknown) => void> = [];
  const visibilityHandlers: Array<() => void> = [];
  const disposeHandlers: Array<() => void> = [];
  const posted: unknown[] = [];
  return {
    webview: {
      options: {} as Record<string, unknown>,
      html: "",
      postMessage: vi.fn((msg: unknown) => { posted.push(msg); }),
      onDidReceiveMessage: (handler: (msg: unknown) => void) => {
        messageHandlers.push(handler);
        return { dispose: () => {} };
      },
      cspSource: "test-csp",
    },
    visible: true,
    onDidChangeVisibility: (handler: () => void) => {
      visibilityHandlers.push(handler);
      return { dispose: () => {} };
    },
    onDidDispose: (handler: () => void) => {
      disposeHandlers.push(handler);
      return { dispose: () => {} };
    },
    // Test helpers
    _sendMessage(msg: unknown) { messageHandlers.forEach((h) => h(msg)); },
    _posted: posted,
    _disposeHandlers: disposeHandlers,
  };
}

const mockSchema = {
  schemaVersion: 1,
  groups: [
    {
      key: "default",
      name: "Default Session",
      description: "Settings for new sessions",
      settings: [
        { key: "default.backend", name: "Backend", description: "Backend", type: "string", default: "native", value: "native", enum: ["native", "tmux"] },
        { key: "default.shell", name: "Shell", description: "Shell", type: "string", default: "", value: "" },
      ],
    },
    {
      key: "local",
      name: "Local Server",
      description: "HTTP server",
      settings: [
        { key: "local.enabled", name: "Enabled", description: "Enable", type: "bool", default: false, value: false },
        { key: "local.port", name: "Port", description: "Port", type: "number", default: 8384, value: 8384, min: 1024, max: 65535 },
      ],
    },
  ],
};

const mockDaemonStatus = {
  uptime: 120,
  pid: 1234,
  backends: [{ id: "native", available: true }],
  sessions: 3,
};

describe("SettingsWebviewProvider", () => {
  let client: ReturnType<typeof createMockClient>;
  let provider: SettingsWebviewProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = createMockClient();
    provider = new SettingsWebviewProvider(
      client as any,
      vscode.Uri.file("/test/extension") as any,
    );
  });

  describe("constructor and dispose", () => {
    it("registers config.changed notification listener", () => {
      expect(client._listeners.get("config.changed")?.size).toBe(1);
    });

    it("dispose unregisters the listener", () => {
      provider.dispose();
      expect(client._listeners.get("config.changed")?.size).toBe(0);
    });
  });

  describe("onConfigChanged handler", () => {
    it("ignores null params", () => {
      // Should not throw
      client._fire("config.changed", null);
      client._fire("config.changed", undefined);
    });

    it("ignores params without string key", () => {
      client._fire("config.changed", { key: 123, value: "x" });
      client._fire("config.changed", { value: "x" });
    });

    it("posts configChanged message to webview when view exists", () => {
      const view = createMockWebviewView();
      // Resolve the webview so `this.view` is set
      client.call.mockResolvedValue(mockDaemonStatus);
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      view._posted.length = 0; // clear initial sendStatus messages
      client._fire("config.changed", { key: "local.enabled", value: true });

      const configMsg = view._posted.find(
        (m: any) => m.type === "configChanged",
      ) as any;
      expect(configMsg).toBeDefined();
      expect(configMsg.key).toBe("local.enabled");
      expect(configMsg.value).toBe(true);
    });
  });

  describe("resolveWebviewView", () => {
    it("sets webview options and HTML", () => {
      const view = createMockWebviewView();
      client.call.mockResolvedValue(mockDaemonStatus);
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      expect(view.webview.options.enableScripts).toBe(true);
      expect(view.webview.html).toContain("<!DOCTYPE html>");
      expect(view.webview.html).toContain("nonce-");
    });

    it("fetches status on initial resolve", async () => {
      const view = createMockWebviewView();
      client.call
        .mockResolvedValueOnce(mockDaemonStatus)
        .mockResolvedValueOnce(mockSchema);

      provider.resolveWebviewView(view as any, {} as any, {} as any);
      await vi.waitFor(() => {
        expect(client.call).toHaveBeenCalledWith("daemon.status");
      });
    });

    it("handles getStatus message", async () => {
      const view = createMockWebviewView();
      client.call
        .mockResolvedValueOnce(mockDaemonStatus) // initial sendStatus
        .mockResolvedValueOnce(mockSchema)
        .mockResolvedValueOnce(mockDaemonStatus) // getStatus sendStatus
        .mockResolvedValueOnce(mockSchema);

      provider.resolveWebviewView(view as any, {} as any, {} as any);
      await vi.waitFor(() => expect(client.call).toHaveBeenCalledTimes(2));

      view._sendMessage({ type: "getStatus" });
      await vi.waitFor(() => expect(client.call).toHaveBeenCalledTimes(4));
    });

    it("handles configSet success", async () => {
      const view = createMockWebviewView();
      client.call
        .mockResolvedValueOnce(mockDaemonStatus)
        .mockResolvedValueOnce(JSON.parse(JSON.stringify(mockSchema)))
        .mockResolvedValueOnce({ ok: true }); // config.set response

      provider.resolveWebviewView(view as any, {} as any, {} as any);
      await vi.waitFor(() => expect(client.call).toHaveBeenCalledTimes(2));

      view._sendMessage({ type: "configSet", key: "local.port", value: 9000 });
      await vi.waitFor(() => {
        expect(client.call).toHaveBeenCalledWith("config.set", {
          key: "local.port",
          value: "9000",
        });
      });
    });

    it("handles configSet with warning", async () => {
      const showWarning = vi.spyOn(vscode.window, "showWarningMessage" as any);
      const view = createMockWebviewView();
      client.call
        .mockResolvedValueOnce(mockDaemonStatus)
        .mockResolvedValueOnce(JSON.parse(JSON.stringify(mockSchema)))
        .mockResolvedValueOnce({ ok: true, warning: "Restart required" });

      provider.resolveWebviewView(view as any, {} as any, {} as any);
      await vi.waitFor(() => expect(client.call).toHaveBeenCalledTimes(2));

      view._sendMessage({ type: "configSet", key: "local.port", value: 9000 });
      await vi.waitFor(() => {
        expect(showWarning).toHaveBeenCalledWith("Restart required");
      });
    });

    it("reverts control on configSet failure", async () => {
      const view = createMockWebviewView();
      const schema = JSON.parse(JSON.stringify(mockSchema));
      client.call
        .mockResolvedValueOnce(mockDaemonStatus)
        .mockResolvedValueOnce(schema)
        .mockRejectedValueOnce(new Error("Permission denied"));

      provider.resolveWebviewView(view as any, {} as any, {} as any);
      await vi.waitFor(() => expect(client.call).toHaveBeenCalledTimes(2));

      view._posted.length = 0;
      view._sendMessage({ type: "configSet", key: "local.port", value: 9000 });
      await vi.waitFor(() => {
        const revertMsg = view._posted.find(
          (m: any) => m.type === "configChanged" && m.key === "local.port",
        ) as any;
        expect(revertMsg).toBeDefined();
        expect(revertMsg.value).toBe(8384); // original value
      });
    });

    it("handles openLogs message", () => {
      const execCmd = vi.spyOn(vscode.commands, "executeCommand" as any);
      const view = createMockWebviewView();
      client.call.mockResolvedValue(mockDaemonStatus);
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      view._sendMessage({ type: "openLogs" });
      expect(execCmd).toHaveBeenCalledWith("carryon.openLogs");
    });

    it("clears view on dispose", () => {
      const view = createMockWebviewView();
      client.call.mockResolvedValue(mockDaemonStatus);
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      // Trigger the onDidDispose handler
      view._disposeHandlers.forEach((h) => h());

      // After view dispose, config.changed should not try to post
      // (no error thrown because this.view is now undefined)
      client._fire("config.changed", { key: "local.port", value: 9999 });
      // The postMessage calls before dispose are the initial sendStatus ones
    });
  });

  describe("sendStatus when disconnected", () => {
    it("sends null daemon and schema when not connected", async () => {
      client.connected = false;
      const view = createMockWebviewView();
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      await vi.waitFor(() => {
        const statusMsg = view._posted.find((m: any) => m.type === "status") as any;
        expect(statusMsg).toBeDefined();
        expect(statusMsg.daemon).toBeNull();
        expect(statusMsg.schema).toBeNull();
        expect(statusMsg.connected).toBe(false);
      });
    });
  });
});
