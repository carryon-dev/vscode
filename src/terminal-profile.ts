import * as path from "path";
import * as vscode from "vscode";
import type { DaemonClient } from "./daemon-client";
import type { Session } from "./session-browser";

let extensionPath = "";

export function setTerminalExtensionPath(p: string): void {
  extensionPath = p;
}

/**
 * Tracks which daemon sessions have open VS Code terminals.
 * Prevents duplicate tabs for the same session.
 */
export class SessionTerminalMap {
  private sessionToTerminal = new Map<string, vscode.Terminal>();
  private terminalToSession = new Map<vscode.Terminal, string>();
  private sessionNames = new Map<string, string>(); // sessionId → last known name

  has(sessionId: string): boolean {
    return this.sessionToTerminal.has(sessionId);
  }

  get(sessionId: string): vscode.Terminal | undefined {
    return this.sessionToTerminal.get(sessionId);
  }

  getSessionId(terminal: vscode.Terminal): string | undefined {
    return this.terminalToSession.get(terminal);
  }

  set(sessionId: string, terminal: vscode.Terminal): void {
    this.sessionToTerminal.set(sessionId, terminal);
    this.terminalToSession.set(terminal, sessionId);
    this.sessionNames.set(sessionId, terminal.name);
  }

  deleteByTerminal(terminal: vscode.Terminal): void {
    const sessionId = this.terminalToSession.get(terminal);
    if (sessionId) {
      // Only delete if it still points to this terminal (not a replacement from rename)
      if (this.sessionToTerminal.get(sessionId) === terminal) {
        this.sessionToTerminal.delete(sessionId);
        this.sessionNames.delete(sessionId);
      }
    }
    this.terminalToSession.delete(terminal);
  }

  deleteBySessionId(sessionId: string): void {
    const terminal = this.sessionToTerminal.get(sessionId);
    if (terminal) {
      this.terminalToSession.delete(terminal);
    }
    this.sessionToTerminal.delete(sessionId);
    this.sessionNames.delete(sessionId);
  }

  /**
   * Check for terminal renames. Returns sessions whose terminal name
   * has changed since last check.
   */
  getRenamed(): Array<{ sessionId: string; newName: string }> {
    const renamed: Array<{ sessionId: string; newName: string }> = [];
    for (const [sessionId, terminal] of this.sessionToTerminal) {
      const lastKnown = this.sessionNames.get(sessionId);
      if (lastKnown !== undefined && terminal.name !== lastKnown) {
        renamed.push({ sessionId, newName: terminal.name });
        this.sessionNames.set(sessionId, terminal.name);
      }
    }
    return renamed;
  }

  nextName(workspaceName: string): string {
    const existing = new Set<string>();
    for (const terminal of this.sessionToTerminal.values()) {
      existing.add(terminal.name);
    }
    let n = 1;
    while (existing.has(`${workspaceName}-${n}`)) {
      n++;
    }
    return `${workspaceName}-${n}`;
  }
}

export class TerminalProfileProvider implements vscode.TerminalProfileProvider {
  constructor(
    private client: DaemonClient,
    private cliPath: string,
    private sessionMap: SessionTerminalMap,
  ) {}

  async provideTerminalProfile(
    _token: vscode.CancellationToken,
  ): Promise<vscode.TerminalProfile | undefined> {
    if (!this.client.connected) {
      vscode.window.showWarningMessage("carryOn daemon is not running.");
      return undefined;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspaceName = workspaceFolder?.name ?? "carryOn";
    const cwd = workspaceFolder?.uri.fsPath;
    const name = this.sessionMap.nextName(workspaceName);

    try {
      const session = await this.client.call<Session>("session.create", {
        name,
        cwd,
      });

      // Associate with workspace if we have one
      if (cwd) {
        await this.client.call("project.associate", {
          path: cwd,
          sessionId: session.id,
        });
      }

      const profileOptions: vscode.TerminalOptions = {
        name: session.name,
        shellPath: this.cliPath,
        shellArgs: ["attach", session.id],
        isTransient: false,
        env: {
          CARRYON_CLIENT_TYPE: "vscode",
          CARRYON_CLIENT_NAME: vscode.env.appName,
        },
      };
      if (extensionPath) {
        profileOptions.iconPath = vscode.Uri.file(path.join(extensionPath, "images", "icon.svg"));
      }
      return new vscode.TerminalProfile(profileOptions);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to create carryOn session: ${msg}`);
      return undefined;
    }
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Opens a daemon session in a VS Code terminal tab.
 * Deduplicates - if already open, focuses the existing tab.
 */
export function openSessionInTerminal(
  sessionId: string,
  sessionName: string,
  cliPath: string,
  sessionMap: SessionTerminalMap,
  options?: {
    color?: string;
    icon?: string;
    location?: { parentTerminal: vscode.Terminal };
  },
): vscode.Terminal {
  // Deduplication: focus existing tab
  const existing = sessionMap.get(sessionId);
  if (existing) {
    existing.show();
    return existing;
  }

  const terminalOptions: vscode.TerminalOptions = {
    name: sessionName,
    shellPath: cliPath,
    shellArgs: ["attach", sessionId],
    isTransient: false,
    env: {
      CARRYON_CLIENT_TYPE: "vscode",
      CARRYON_CLIENT_NAME: vscode.env.appName,
    },
  };

  if (options?.color) {
    terminalOptions.color = new vscode.ThemeColor(`terminal.ansi${capitalize(options.color)}`);
  }

  if (options?.icon) {
    terminalOptions.iconPath = new vscode.ThemeIcon(options.icon);
  } else if (extensionPath) {
    terminalOptions.iconPath = vscode.Uri.file(path.join(extensionPath, "images", "icon.svg"));
  }

  if (options?.location) {
    terminalOptions.location = options.location;
  }

  const terminal = vscode.window.createTerminal(terminalOptions);
  sessionMap.set(sessionId, terminal);
  terminal.show();
  return terminal;
}
