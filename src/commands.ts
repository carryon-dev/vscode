import * as vscode from "vscode";
import type { DaemonClient } from "./daemon-client";
import { type SessionTerminalMap, openSessionInTerminal } from "./terminal-profile";
import type { SessionBrowserProvider } from "./session-browser";
import { SessionNode, RemoteSessionNode, LocalGroupNode, GroupNode, DeviceNode } from "./session-browser";

type SessionCommandNode = SessionNode | RemoteSessionNode | undefined;

type CreateSessionNode = LocalGroupNode | GroupNode | DeviceNode | undefined;

async function createSession(
  node: CreateSessionNode,
  promptForName: boolean,
  client: DaemonClient,
  sessionMap: SessionTerminalMap,
  sessionBrowser: SessionBrowserProvider,
  cliPath: string,
): Promise<void> {
  if (!client.connected) {
    vscode.window.showWarningMessage("carryOn daemon is not running.");
    return;
  }

  // Determine context from tree node
  let deviceId: string | undefined;
  let cwd: string | undefined;
  let projectPath: string | undefined;

  if (node instanceof DeviceNode) {
    if (!node.device.online) {
      vscode.window.showErrorMessage(`Device "${node.device.name}" is offline.`);
      return;
    }
    deviceId = node.device.id;
  } else if (node instanceof GroupNode) {
    projectPath = node.group.projectPath ?? undefined;
    cwd = projectPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  } else {
    // LocalGroupNode or undefined
    cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  // Resolve name
  let name: string;
  if (promptForName) {
    const input = await vscode.window.showInputBox({
      prompt: "Session name",
      placeHolder: "my-session",
    });
    if (!input) return; // cancelled
    name = input;
  } else {
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? "carryOn";
    name = sessionMap.nextName(workspaceName);
  }

  try {
    // RPC call
    const params: Record<string, unknown> = { name };
    if (deviceId) {
      params.device_id = deviceId;
    } else if (cwd) {
      params.cwd = cwd;
    }

    const session = await client.call<{ id: string; name: string }>("session.create", params);

    // Auto-attach in terminal
    openSessionInTerminal(session.id, session.name, cliPath, sessionMap);
    sessionBrowser.fetchAndRefresh();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to create session: ${msg}`);
  }
}

export function registerCommandsAndNotifications(
  context: vscode.ExtensionContext,
  client: DaemonClient,
  sessionMap: SessionTerminalMap,
  sessionBrowser: SessionBrowserProvider,
  cliPath: string,
): void {
  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("carryon.openSession", async (node: SessionCommandNode) => {
      if (node instanceof SessionNode) {
        // Local session
        const s = node.item.session;
        openSessionInTerminal(s.id, s.name, cliPath, sessionMap);
        sessionBrowser.fetchAndRefresh();
      } else if (node instanceof RemoteSessionNode) {
        // Remote session
        const s = node.remoteSession;
        openSessionInTerminal(s.id, s.name, cliPath, sessionMap);
        sessionBrowser.fetchAndRefresh();
      }
    }),

    vscode.commands.registerCommand("carryon.killSession", async (node: SessionCommandNode) => {
      if (node instanceof SessionNode) {
        const s = node.item.session;
        const confirm = await vscode.window.showWarningMessage(
          `Kill session "${s.name}"?`,
          { modal: true },
          "Kill",
        );
        if (confirm === "Kill") {
          try {
            await client.call("session.kill", { sessionId: s.id });
            sessionMap.deleteBySessionId(s.id);
            sessionBrowser.fetchAndRefresh();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to kill session: ${msg}`);
          }
        }
      }
    }),

    vscode.commands.registerCommand("carryon.renameSession", async (node: SessionCommandNode) => {
      if (node instanceof SessionNode) {
        const s = node.item.session;
        const newName = await vscode.window.showInputBox({
          prompt: "New session name",
          value: s.name,
        });
        if (newName && newName !== s.name) {
          try {
            await client.call("session.rename", { sessionId: s.id, name: newName });
            sessionBrowser.fetchAndRefresh();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to rename session: ${msg}`);
          }
        }
      }
    }),

    vscode.commands.registerCommand("carryon.refreshSessions", () => {
      sessionBrowser.fetchAndRefresh();
    }),

    vscode.commands.registerCommand("carryon.openLogs", () => {
      const terminal = vscode.window.createTerminal({
        name: "carryOn Logs",
        shellPath: cliPath,
        shellArgs: ["logs", "-f"],
        isTransient: true,
      });
      terminal.show();
    }),

    vscode.commands.registerCommand("carryon.newSession", async (node: CreateSessionNode) => {
      await createSession(node, false, client, sessionMap, sessionBrowser, cliPath);
    }),

    vscode.commands.registerCommand("carryon.newSessionNamed", async (node: CreateSessionNode) => {
      await createSession(node, true, client, sessionMap, sessionBrowser, cliPath);
    }),

    vscode.commands.registerCommand("carryon.changeWebPassword", async () => {
      if (!client.connected) {
        vscode.window.showWarningMessage("carryOn daemon is not running.");
        return;
      }

      const password = await vscode.window.showInputBox({
        prompt: "New web access password (min 8 characters)",
        password: true,
      });
      if (!password) return;

      const confirm = await vscode.window.showInputBox({
        prompt: "Confirm password",
        password: true,
      });
      if (!confirm) return;

      if (password !== confirm) {
        vscode.window.showErrorMessage("Passwords do not match.");
        return;
      }

      if (password.length < 8) {
        vscode.window.showErrorMessage("Password must be at least 8 characters.");
        return;
      }

      try {
        await client.call("local.set-password", { password });
        vscode.window.showInformationMessage("Web password updated. All web clients have been disconnected.");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to set password: ${msg}`);
      }
    }),
  );

  // Notification subscriptions - use debounced refresh to coalesce rapid-fire notifications
  const refreshHandler = () => sessionBrowser.debouncedRefresh();
  const renamedHandler = (params: unknown) => {
    if (!params || typeof params !== "object") return;
    const p = params as Record<string, unknown>;
    const sessionId = p.sessionId;
    const newName = p.name;
    if (typeof sessionId === "string" && typeof newName === "string") {
      // If this session is open in a terminal, dispose and reattach with new name
      const terminal = sessionMap.get(sessionId);
      if (terminal && terminal.name !== newName) {
        sessionMap.deleteBySessionId(sessionId);
        terminal.dispose();
        openSessionInTerminal(sessionId, newName, cliPath, sessionMap);
      }
    }
    sessionBrowser.debouncedRefresh();
  };

  const notifMethods = [
    "session.created", "session.ended", "session.attached",
    "session.detached", "remote.device.online", "remote.device.offline",
    "remote.sessions.updated",
  ];
  for (const method of notifMethods) {
    client.onNotification(method, refreshHandler);
  }
  client.onNotification("session.renamed", renamedHandler);

  context.subscriptions.push({
    dispose: () => {
      for (const method of notifMethods) {
        client.offNotification(method, refreshHandler);
      }
      client.offNotification("session.renamed", renamedHandler);
    },
  });
}
