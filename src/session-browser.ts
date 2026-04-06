import * as vscode from "vscode";
import * as path from "path";
import type { DaemonClient } from "./daemon-client";
import type { SessionTerminalMap } from "./terminal-profile";

export interface SessionClient {
  clientId: string;
  type: string;
  name: string;
  pid: number;
  connectedAt: number;
  ip?: string;
}

export interface Session {
  id: string;
  name: string;
  backend: string;
  pid?: number;
  created: number;
  lastAttached?: number;
  cwd?: string;
  command?: string;
  attachedClients: number;
  clients?: SessionClient[];
}

export interface GroupTreeItem {
  label: string;
  projectPath: string | null;
  children: SessionTreeItem[];
  isCurrentWorkspace: boolean;
}

export interface SessionTreeItem {
  session: Session;
  isOpen: boolean;
  isAssigned: boolean;
}

export interface DeviceSnapshot {
  id: string;
  name: string;
  online: boolean;
  last_seen: string;
  team_id: string;
  team_name: string;
  sessions: RemoteSession[];
}

export interface RemoteSession {
  id: string;
  name: string;
  device_id: string;
  device_name: string;
  created: number;
  last_attached?: number;
}

export interface RemoteStatus {
  connected: boolean;
  account_id?: string;
  device_id?: string;
  device_name?: string;
}

export interface TeamGroupItem {
  teamId: string;
  teamName: string;
  devices: DeviceSnapshot[];
}

export interface FullTree {
  localGroups: GroupTreeItem[];
  teamGroups: TeamGroupItem[];
}

/**
 * Pure function: builds the tree structure from sessions using cwd prefix matching.
 * Sessions are matched to workspace folders by checking if session cwd is at or under
 * the workspace path. Sessions matching multiple workspaces go to the most specific one.
 * Exported for testing independently of VS Code APIs.
 */
export function buildTree(
  sessions: Session[],
  workspacePaths: string[],
  currentWorkspacePath: string | null,
  openSessionIds: Set<string>,
): GroupTreeItem[] {
  const groups: GroupTreeItem[] = [];
  const matchedSessionIds = new Set<string>();

  // Sort workspace paths longest-first so we match most specific first
  const sortedPaths = [...workspacePaths].sort((a, b) => b.length - a.length);

  // Build workspace path -> sessions map
  const wsSessionMap = new Map<string, Session[]>();
  for (const ws of sortedPaths) {
    wsSessionMap.set(ws, []);
  }

  for (const s of sessions) {
    if (!s.cwd || matchedSessionIds.has(s.id)) continue;
    for (const ws of sortedPaths) {
      if (isUnderPath(s.cwd, ws)) {
        wsSessionMap.get(ws)!.push(s);
        matchedSessionIds.add(s.id);
        break;
      }
    }
  }

  // Current workspace first
  if (currentWorkspacePath && wsSessionMap.has(currentWorkspacePath)) {
    const wsSessions = wsSessionMap.get(currentWorkspacePath)!;
    if (wsSessions.length > 0) {
      groups.push({
        label: path.basename(currentWorkspacePath),
        projectPath: currentWorkspacePath,
        children: wsSessions.map((s) => ({
          session: s,
          isOpen: openSessionIds.has(s.id),
          isAssigned: true,
        })),
        isCurrentWorkspace: true,
      });
    }
  }

  // Other workspace folders
  for (const ws of sortedPaths) {
    if (ws === currentWorkspacePath) continue;
    const wsSessions = wsSessionMap.get(ws)!;
    if (wsSessions.length === 0) continue;
    groups.push({
      label: path.basename(ws),
      projectPath: ws,
      children: wsSessions.map((s) => ({
        session: s,
        isOpen: openSessionIds.has(s.id),
        isAssigned: true,
      })),
      isCurrentWorkspace: false,
    });
  }

  // Unmatched sessions
  const unmatched = sessions.filter((s) => !matchedSessionIds.has(s.id));
  if (unmatched.length > 0) {
    groups.push({
      label: "Other Sessions",
      projectPath: null,
      children: unmatched.map((s) => ({
        session: s,
        isOpen: openSessionIds.has(s.id),
        isAssigned: false,
      })),
      isCurrentWorkspace: false,
    });
  }

  return groups;
}

/**
 * Pure function: builds the full tree including local project groups and remote team groups.
 * Wraps buildTree for local sessions and adds team/device grouping for remote devices.
 * Exported for testing independently of VS Code APIs.
 */
export function buildFullTree(
  sessions: Session[],
  workspacePaths: string[],
  currentWorkspacePath: string | null,
  openSessionIds: Set<string>,
  remoteStatus: RemoteStatus | null,
  devices: DeviceSnapshot[],
): FullTree {
  const localGroups = buildTree(sessions, workspacePaths, currentWorkspacePath, openSessionIds);

  if (!remoteStatus || !remoteStatus.connected) {
    return { localGroups, teamGroups: [] };
  }

  const teamMap = new Map<string, { teamName: string; devices: DeviceSnapshot[] }>();
  for (const device of devices) {
    let team = teamMap.get(device.team_id);
    if (!team) {
      team = { teamName: device.team_name, devices: [] };
      teamMap.set(device.team_id, team);
    }
    team.devices.push(device);
  }

  const teamGroups: TeamGroupItem[] = Array.from(teamMap.entries())
    .sort((a, b) => a[1].teamName.localeCompare(b[1].teamName))
    .map(([teamId, team]) => ({
      teamId,
      teamName: team.teamName,
      devices: team.devices,
    }));

  return { localGroups, teamGroups };
}

/**
 * Strip ANSI/terminal escape sequences and control characters from scrollback output.
 */
export function stripAnsi(str: string): string {
  return str
    // CSI sequences: \e[ followed by parameter bytes, intermediate bytes, then final byte (ECMA-48)
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
    // OSC sequences: \e] ... (terminated by BEL or ST)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Other escape sequences: \e followed by one or two chars
    .replace(/\x1b[^[\]].?/g, "")
    // Remaining control chars (BEL, BS, carriage return, etc) except newline and tab
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    // Carriage return (often paired with newline, or used for overwriting)
    .replace(/\r/g, "");
}

export function shortenPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

/**
 * Reports whether child path is at or under parent path.
 * Path-boundary aware: /a/bc is NOT under /a/b.
 */
export function isUnderPath(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  // Normalize: remove trailing slashes
  const c = child.replace(/\/+$/, "");
  const p = parent.replace(/\/+$/, "");
  if (c === p) return true;
  return c.startsWith(p + "/");
}

export function formatAge(epochMs: number): string {
  const seconds = Math.floor((Date.now() - epochMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_[\]]/g, "\\$&");
}

// Resolve icon paths relative to the extension root
let extensionPath = "";

export function setExtensionPath(p: string): void {
  extensionPath = p;
}

function sessionIcon(session: Session): vscode.ThemeIcon | vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } {
  if (!session.pid) {
    return new vscode.ThemeIcon("circle-outline");
  }
  if (session.backend === "native" && extensionPath) {
    return vscode.Uri.file(path.join(extensionPath, "images", "icon.svg"));
  }
  if (session.backend === "tmux") {
    return new vscode.ThemeIcon("terminal-tmux");
  }
  return new vscode.ThemeIcon("terminal");
}

// --- Tree node types ---

export class LocalGroupNode extends vscode.TreeItem {
  readonly kind = "localGroup" as const;
  constructor(public readonly localGroups: GroupTreeItem[]) {
    super("Local", vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "localGroup";
    this.iconPath = new vscode.ThemeIcon("folder");
    const count = localGroups.reduce((sum, g) => sum + g.children.length, 0);
    this.description = `${count} session${count !== 1 ? "s" : ""}`;
  }
}

class TeamGroupNode extends vscode.TreeItem {
  readonly kind = "teamGroup" as const;
  constructor(public readonly team: TeamGroupItem) {
    super(team.teamName, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "teamGroup";
    this.iconPath = new vscode.ThemeIcon("organization");
    const count = team.devices.length;
    this.description = count > 0 ? `${count} device${count !== 1 ? "s" : ""}` : "";
  }
}

export class DeviceNode extends vscode.TreeItem {
  readonly kind = "device" as const;
  constructor(public readonly device: DeviceSnapshot) {
    super(device.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = device.online ? "device" : "deviceOffline";
    this.iconPath = new vscode.ThemeIcon(device.online ? "vm-running" : "vm");
    this.description = device.online ? "online" : "offline";
  }
}

export class RemoteSessionNode extends vscode.TreeItem {
  readonly kind = "remoteSession" as const;
  constructor(public readonly remoteSession: RemoteSession, public readonly deviceOnline: boolean) {
    super(remoteSession.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = deviceOnline ? "sessionRemote" : "sessionRemoteOffline";
    this.id = `remote-${remoteSession.device_id}-${remoteSession.id}`;
    this.iconPath = new vscode.ThemeIcon("terminal");
    this.description = formatAge(remoteSession.created);
  }
}

export class GroupNode extends vscode.TreeItem {
  readonly kind = "group" as const;
  constructor(public readonly group: GroupTreeItem) {
    super(
      group.label,
      group.isCurrentWorkspace
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.contextValue = "group";
    this.iconPath = new vscode.ThemeIcon("folder");
    this.description = `${group.children.length} session${group.children.length !== 1 ? "s" : ""}`;
  }
}

export class SessionNode extends vscode.TreeItem {
  readonly kind = "session" as const;
  constructor(public readonly item: SessionTreeItem) {
    const s = item.session;
    super(s.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "session";
    this.id = s.id;
    this.iconPath = sessionIcon(s);
    // tooltip is undefined - resolved lazily via resolveTreeItem
    this.description = buildSessionDescription(s);
  }
}

class DetailNode extends vscode.TreeItem {
  readonly kind = "detail" as const;
  constructor(label: string, value: string, icon?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.contextValue = "detail";
    this.iconPath = icon ? new vscode.ThemeIcon(icon) : undefined;
  }
}

class ClientsNode extends vscode.TreeItem {
  readonly kind = "clients" as const;
  constructor(public readonly clients: SessionClient[]) {
    super(
      "Clients",
      clients.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = "clients";
    this.description = `${clients.length} attached`;
    this.iconPath = new vscode.ThemeIcon("person");
  }
}

class ClientNode extends vscode.TreeItem {
  readonly kind = "client" as const;
  constructor(public readonly client: SessionClient) {
    super(client.name || client.type, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "client";
    this.description = clientDescription(client);
    this.iconPath = clientIcon(client);
  }
}

export function clientDescription(c: SessionClient): string {
  if (c.type === "web") {
    return c.ip || "web";
  }
  if (c.pid) {
    return `pid ${c.pid}`;
  }
  return c.type;
}

function clientIcon(c: SessionClient): vscode.ThemeIcon {
  switch (c.type) {
    case "vscode": return new vscode.ThemeIcon("window");
    case "web": return new vscode.ThemeIcon("globe");
    case "cli": return new vscode.ThemeIcon("terminal");
    default: return new vscode.ThemeIcon("plug");
  }
}

export type TreeNode = LocalGroupNode | GroupNode | SessionNode | TeamGroupNode | DeviceNode | RemoteSessionNode | DetailNode | ClientsNode | ClientNode;

export function buildSessionDescription(session: Session): string {
  const parts: string[] = [];
  if (session.command) parts.push(session.command);
  parts.push(formatAge(session.created));
  if (!session.pid) parts.push("• stopped");
  return parts.join("  ");
}

export class SessionBrowserProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private localGroups: GroupTreeItem[] = [];
  private teamGroups: TeamGroupItem[] = [];
  private refreshTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private client: DaemonClient,
    private sessionMap: SessionTerminalMap,
  ) { }

  dispose(): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = undefined;
    }
    this._onDidChangeTreeData.dispose();
  }

  refresh(fullTree: FullTree): void {
    this.localGroups = fullTree.localGroups;
    this.teamGroups = fullTree.teamGroups;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const nodes: TreeNode[] = [new LocalGroupNode(this.localGroups)];
      for (const team of this.teamGroups) {
        nodes.push(new TeamGroupNode(team));
      }
      return nodes;
    }
    if (element instanceof LocalGroupNode) {
      return element.localGroups.map((g) => new GroupNode(g));
    }
    if (element instanceof GroupNode) {
      return element.group.children.map((item) => new SessionNode(item));
    }
    if (element instanceof SessionNode) {
      const s = element.item.session;
      const details: TreeNode[] = [];
      details.push(new DetailNode("ID", s.id, "key"));
      details.push(new DetailNode("Backend", s.backend, "server-environment"));
      details.push(new DetailNode("Status", s.pid ? `running (pid ${s.pid})` : "stopped", s.pid ? "pass" : "error"));
      details.push(new DetailNode("Created", formatTimestamp(s.created), "calendar"));
      if (s.lastAttached) {
        details.push(new DetailNode("Last attached", formatTimestamp(s.lastAttached), "history"));
      }
      if (s.command) {
        details.push(new DetailNode("Command", s.command, "play"));
      }
      if (s.cwd) {
        details.push(new DetailNode("CWD", shortenPath(s.cwd), "folder-opened"));
      }
      details.push(new ClientsNode(s.clients ?? []));
      return details;
    }
    if (element instanceof TeamGroupNode) {
      if (element.team.devices.length === 0) {
        return [new DetailNode("No visible devices", "", "info")];
      }
      return element.team.devices.map((d) => new DeviceNode(d));
    }
    if (element instanceof DeviceNode) {
      if (element.device.sessions.length === 0) {
        return [new DetailNode("No sessions", "", "info")];
      }
      return element.device.sessions.map((s) => new RemoteSessionNode(s, element.device.online));
    }
    if (element instanceof RemoteSessionNode) {
      const s = element.remoteSession;
      const details: TreeNode[] = [];
      details.push(new DetailNode("ID", s.id, "key"));
      details.push(new DetailNode("Device", s.device_name, "vm"));
      details.push(new DetailNode("Created", formatTimestamp(s.created), "calendar"));
      if (s.last_attached) {
        details.push(new DetailNode("Last attached", formatTimestamp(s.last_attached), "history"));
      }
      return details;
    }
    if (element instanceof ClientsNode) {
      return element.clients.map((c) => new ClientNode(c));
    }
    return [];
  }

  /**
   * Lazily resolves tooltip with scrollback content on hover.
   */
  async resolveTreeItem(
    item: vscode.TreeItem,
    element: TreeNode,
    token: vscode.CancellationToken,
  ): Promise<vscode.TreeItem> {
    if (element instanceof SessionNode) {
      const s = element.item.session;
      const lines: string[] = [];
      lines.push(`**${escapeMd(s.name)}** \`${escapeMd(s.id)}\``);
      lines.push("---");
      if (s.command) lines.push(`**Command:** \`${escapeMd(s.command)}\``);
      lines.push(`**Backend:** ${escapeMd(s.backend)} · **Status:** ${s.pid ? "running" : "stopped"}`);
      lines.push(`**Clients:** ${s.attachedClients} · **Age:** ${formatAge(s.created)}`);

      // Fetch scrollback dynamically
      if (this.client.connected && s.pid && !token.isCancellationRequested) {
        try {
          const scrollback = await this.client.call<string>("session.scrollback", {
            sessionId: s.id,
          });
          if (!token.isCancellationRequested && scrollback && scrollback.trim()) {
            const clean = stripAnsi(scrollback.trim());
            const outputLines = clean.split("\n").slice(-10);
            if (outputLines.some((l) => l.trim())) {
              lines.push("---");
              lines.push("**Recent output:**");
              lines.push("```");
              lines.push(outputLines.join("\n"));
              lines.push("```");
            }
          }
        } catch {
          // Scrollback not available - skip
        }
      }

      item.tooltip = new vscode.MarkdownString(lines.join("\n\n"));
    }
    if (element instanceof RemoteSessionNode) {
      const s = element.remoteSession;
      const lines: string[] = [];
      lines.push(`**${escapeMd(s.name)}** \`${escapeMd(s.id)}\``);
      lines.push("---");
      lines.push(`**Device:** ${escapeMd(s.device_name)}`);
      lines.push(`**Age:** ${formatAge(s.created)}`);
      if (s.last_attached) {
        lines.push(`**Last attached:** ${formatTimestamp(s.last_attached)}`);
      }
      item.tooltip = new vscode.MarkdownString(lines.join("\n\n"));
    }
    return item;
  }

  debouncedRefresh(): void {
    if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
    this.refreshTimeout = setTimeout(() => this.fetchAndRefresh(), 100);
  }

  async fetchAndRefresh(): Promise<void> {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = undefined;
    }

    if (!this.client.connected) {
      this.localGroups = [];
      this.teamGroups = [];
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    try {
      const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

      // Run independent RPC calls in parallel
      const [sessions, remoteStatus] = await Promise.all([
        this.client.call<Session[]>("session.list"),
        this.client.call<RemoteStatus>("remote.status").catch(() => null),
      ]);

      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
      const openIds = new Set<string>();
      for (const terminal of vscode.window.terminals) {
        const sid = this.sessionMap.getSessionId(terminal);
        if (sid) openIds.add(sid);
      }

      let devices: DeviceSnapshot[] = [];
      if (remoteStatus?.connected) {
        try {
          devices = await this.client.call<DeviceSnapshot[]>("remote.devices");
        } catch {
          // Remote unavailable
        }
      }

      const fullTree = buildFullTree(sessions, workspacePaths, workspacePath, openIds, remoteStatus, devices);
      this.refresh(fullTree);
    } catch {
      this.localGroups = [];
      this.teamGroups = [];
      this._onDidChangeTreeData.fire(undefined);
    }
  }
}
