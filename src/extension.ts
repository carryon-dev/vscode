import * as vscode from "vscode";
import { getBaseDir, getSocketPath } from "./platform";
import { DaemonClient } from "./daemon-client";
import { TerminalProfileProvider, SessionTerminalMap } from "./terminal-profile";
import { SessionBrowserProvider, setExtensionPath } from "./session-browser";
import { ProjectDetector } from "./project-detector";
import { SettingsWebviewProvider } from "./settings-webview";
import { resolveCliPath, ensureDaemon, showCliNotFound } from "./cli";
import { registerCommandsAndNotifications } from "./commands";

let client: DaemonClient;
let sessionMap: SessionTerminalMap;
let sessionBrowser: SessionBrowserProvider;
let projectDetector: ProjectDetector;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Set extension path for icon resolution
  setExtensionPath(context.extensionPath);

  // 1. Detect CLI
  const cliPath = await resolveCliPath();
  if (!cliPath) {
    showCliNotFound(context);
    return;
  }

  // 2. Ensure daemon is running
  await ensureDaemon(cliPath);

  // 3. Connect daemon client
  client = new DaemonClient();
  const socketPath = getSocketPath(getBaseDir());

  try {
    await client.connect(socketPath);
    // Identify this client to the daemon
    await client.call("client.identify", {
      type: "vscode",
      name: vscode.env.appName,
      pid: process.pid,
    });
  } catch {
    vscode.window.showWarningMessage("Could not connect to carryOn daemon. Some features may be unavailable.");
  }

  // 4. Session → terminal map
  sessionMap = new SessionTerminalMap();

  client.enableReconnect(5000);
  client.onConnectionChange = async (connected) => {
    if (!sessionBrowser) return;
    if (connected) {
      // Re-identify on reconnect
      try {
        await client.call("client.identify", {
          type: "vscode",
          name: vscode.env.appName,
          pid: process.pid,
        });
      } catch { /* best effort */ }
      sessionBrowser.fetchAndRefresh();
    } else {
      sessionBrowser.fetchAndRefresh(); // Clears the tree
    }
  };

  // Track terminal open → register carryon sessions in the map
  // Track terminal close → remove from map
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      const opts = terminal.creationOptions as vscode.TerminalOptions;
      const args = opts?.shellArgs;
      // Match terminals created with: carryon attach <sessionId>
      if (Array.isArray(args) && args[0] === "attach" && args[1]) {
        const sessionId = args[1];
        if (!sessionMap.has(sessionId)) {
          sessionMap.set(sessionId, terminal);
        }
      }
      sessionBrowser?.debouncedRefresh();
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      sessionMap.deleteByTerminal(terminal);
      sessionBrowser?.debouncedRefresh();
    }),
  );

  // 5. Terminal profile
  const profileProvider = new TerminalProfileProvider(client, cliPath, sessionMap);
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider("carryon.terminalProfile", profileProvider),
  );

  // 6. Session browser
  sessionBrowser = new SessionBrowserProvider(client, sessionMap);
  const treeView = vscode.window.createTreeView("carryon.sessions", {
    treeDataProvider: sessionBrowser,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // 6b. Settings webview
  const settingsProvider = new SettingsWebviewProvider(client, context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("carryon.settings", settingsProvider),
    settingsProvider,
    sessionBrowser,
  );

  // 7. Register commands and notification subscriptions
  registerCommandsAndNotifications(context, client, sessionMap, sessionBrowser, cliPath);

  // Initial fetch
  await sessionBrowser.fetchAndRefresh();

  // 8. Project detector
  projectDetector = new ProjectDetector(client, cliPath, sessionMap, () => {
    sessionBrowser.fetchAndRefresh();
  });
  projectDetector.startWatching();
  context.subscriptions.push(
    { dispose: () => projectDetector.dispose() },
    { dispose: () => client.dispose() },
  );

  // 9. Sync loop - detect terminal renames in VS Code and push to daemon
  const syncInterval = setInterval(async () => {
    if (!client.connected) return;
    const renamed = sessionMap.getRenamed();
    for (const { sessionId, newName } of renamed) {
      try {
        await client.call("session.rename", { sessionId, name: newName });
      } catch { /* best effort */ }
    }
  }, 2000);
  context.subscriptions.push({ dispose: () => clearInterval(syncInterval) });

  // Detect on startup
  await projectDetector.detectAndPrompt();
}

export function deactivate(): void {
  // Cleanup handled by context.subscriptions
}
