import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { DaemonClient } from "./daemon-client";
import type { SessionTerminalMap } from "./terminal-profile";
import { openSessionInTerminal } from "./terminal-profile";
import type { Session } from "./session-browser";

interface DeclaredTerminal {
  name: string;
  command?: string;
  backend?: string;
  cwd?: string;
  shell?: string;
  color?: string;
  icon?: string;
}

type TerminalEntry = DeclaredTerminal | DeclaredTerminal[];

interface ProjectConfig {
  version: number;
  terminals: TerminalEntry[];
}

interface ProjectTerminalsResult {
  declared: Array<DeclaredTerminal & { sessionId?: string; running?: boolean }>;
  associated: Session[];
}

/**
 * Reads and validates .carryon.json from a directory.
 * Returns null if not found or invalid.
 * Exported for testing independently of VS Code APIs.
 */
export function findCarryonConfig(dir: string): ProjectConfig | null {
  const configPath = path.join(dir, ".carryon.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || !Array.isArray(parsed.terminals)) {
      return null;
    }
    // Validate each entry is an object or array of objects
    for (const entry of parsed.terminals) {
      if (Array.isArray(entry)) {
        if (entry.length === 0) return null;
        for (const item of entry) {
          if (typeof item !== "object" || item === null || !item.name) return null;
        }
      } else if (typeof entry !== "object" || entry === null || !entry.name) {
        return null;
      }
    }
    return parsed as ProjectConfig;
  } catch {
    return null;
  }
}

export class ProjectDetector {
  private fileWatchers: vscode.FileSystemWatcher[] = [];

  constructor(
    private client: DaemonClient,
    private cliPath: string,
    private sessionMap: SessionTerminalMap,
    private onProjectChanged: () => void,
  ) {}

  /**
   * Checks all workspace folders for .carryon.json and associated sessions.
   * Prompts or auto-opens as appropriate.
   */
  async detectAndPrompt(): Promise<void> {
    if (!this.client.connected) return;

    // Wait for VS Code to assign PIDs to restored terminals
    await new Promise((r) => setTimeout(r, 1000));

    // Step 1: Get all sessions with client PIDs from daemon
    let allSessions: Session[] = [];
    try {
      allSessions = await this.client.call<Session[]>("session.list");
    } catch {
      return;
    }

    // Build map: clientPid → sessionId
    const clientPidToSession = new Map<number, string>();
    for (const s of allSessions) {
      for (const c of s.clients ?? []) {
        if (c.pid) clientPidToSession.set(c.pid, s.id);
      }
    }

    // Step 2: Match VS Code terminals against daemon client PIDs.
    // Dispose stale carryon terminals and reattach fresh ones.
    const reattachedSessionIds = new Set<string>();
    for (const terminal of vscode.window.terminals) {
      let pid: number | undefined;
      try { pid = await terminal.processId; } catch { /* */ }
      if (!pid) continue;

      const sessionId = clientPidToSession.get(pid);
      if (!sessionId) continue;

      // This VS Code terminal is a carryon terminal - dispose the stale one
      // and open a fresh attach
      const session = allSessions.find((s) => s.id === sessionId);
      if (!session) continue;

      terminal.dispose();
      reattachedSessionIds.add(sessionId);
    }

    // Brief pause for disposals to complete
    if (reattachedSessionIds.size > 0) {
      await new Promise((r) => setTimeout(r, 300));
      // Reattach the disposed terminals
      for (const sessionId of reattachedSessionIds) {
        const session = allSessions.find((s) => s.id === sessionId);
        if (session) {
          openSessionInTerminal(sessionId, session.name, this.cliPath, this.sessionMap);
        }
      }
    }

    // Step 3: Check each workspace folder for associated sessions and .carryon.json
    // that need opening (not already reattached above)
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const config = findCarryonConfig(folder.uri.fsPath);
      const autoOpen = vscode.workspace.getConfiguration("carryon", folder.uri).get<boolean>("autoOpenTerminals", false);

      // Get associated sessions that are running and not already reattached
      let needsOpening: Session[] = [];
      try {
        const result = await this.client.call<ProjectTerminalsResult>("project.terminals", {
          path: folder.uri.fsPath,
        });
        needsOpening = result.associated.filter(
          (s) => s.pid && !reattachedSessionIds.has(s.id) && !this.sessionMap.has(s.id),
        );
      } catch {
        // No associations
      }

      const declaredCount = config?.terminals.reduce(
        (sum, entry) => sum + (Array.isArray(entry) ? entry.length : 1), 0,
      ) ?? 0;
      const totalCount = declaredCount + needsOpening.length;
      if (totalCount === 0) continue;

      if (autoOpen) {
        if (config) await this.openDeclaredTerminals(folder.uri.fsPath, config);
        this.openAssociatedSessions(needsOpening);
        continue;
      }

      const choice = await vscode.window.showInformationMessage(
        `This project has ${totalCount} carryOn terminal${totalCount > 1 ? "s" : ""}. Open them?`,
        "Yes",
        "No",
        "Always for this project",
      );

      if (choice === "Yes" || choice === "Always for this project") {
        if (config) await this.openDeclaredTerminals(folder.uri.fsPath, config);
        this.openAssociatedSessions(needsOpening);
      }

      if (choice === "Always for this project") {
        const wsConfig = vscode.workspace.getConfiguration("carryon", folder.uri);
        await wsConfig.update("autoOpenTerminals", true, vscode.ConfigurationTarget.WorkspaceFolder);
      }
    }
  }

  /**
   * Opens associated sessions that are running as VS Code terminal tabs.
   */
  private openAssociatedSessions(sessions: Session[]): void {
    for (const s of sessions) {
      openSessionInTerminal(s.id, s.name, this.cliPath, this.sessionMap);
    }
  }

  /**
   * Opens declared terminals: reattaches existing, creates missing.
   * Respects split groups from the config.
   */
  private async openDeclaredTerminals(projectPath: string, config: ProjectConfig): Promise<void> {
    if (!this.client.connected) return;

    try {
      const result = await this.client.call<ProjectTerminalsResult>("project.terminals", {
        path: projectPath,
      });

      // Build a lookup from declared results by name
      const declaredByName = new Map<string, ProjectTerminalsResult["declared"][0]>();
      for (const d of result.declared) {
        declaredByName.set(d.name, d);
      }

      // Walk the config entries to preserve split grouping
      for (const entry of config.terminals) {
        const terminals = Array.isArray(entry) ? entry : [entry];
        let parentTerminal: vscode.Terminal | undefined;

        for (const declared of terminals) {
          try {
            const info = declaredByName.get(declared.name);
            const location = parentTerminal ? { parentTerminal } : undefined;

            if (info?.sessionId && info.running) {
              // Session exists and is running - attach
              const term = openSessionInTerminal(
                info.sessionId, declared.name, this.cliPath, this.sessionMap,
                { color: declared.color, icon: declared.icon, location },
              );
              if (!parentTerminal) parentTerminal = term;
            } else if (!info?.sessionId) {
              // Session doesn't exist - create and attach
              const session = await this.client.call<Session>("session.create", {
                name: declared.name,
                cwd: declared.cwd ?? projectPath,
                command: declared.command,
                shell: declared.shell,
                backend: declared.backend,
              });
              await this.client.call("project.associate", {
                path: projectPath,
                sessionId: session.id,
              });
              const term = openSessionInTerminal(
                session.id, session.name, this.cliPath, this.sessionMap,
                { color: declared.color, icon: declared.icon, location },
              );
              if (!parentTerminal) parentTerminal = term;
            }
            // Stopped sessions - don't auto-open
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`Failed to open terminal "${declared.name}": ${msg}`);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to open project terminals: ${msg}`);
    }
  }

  /**
   * Sets up file watchers for .carryon.json in all workspace folders.
   */
  startWatching(): void {
    const watcher = vscode.workspace.createFileSystemWatcher("**/.carryon.json");
    watcher.onDidChange(() => this.onProjectChanged());
    watcher.onDidCreate(() => this.onProjectChanged());
    watcher.onDidDelete(() => this.onProjectChanged());
    this.fileWatchers.push(watcher);
  }

  dispose(): void {
    for (const w of this.fileWatchers) {
      w.dispose();
    }
    this.fileWatchers = [];
  }
}
