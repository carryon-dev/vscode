import { buildTree, buildFullTree, stripAnsi, shortenPath, formatAge, buildSessionDescription, clientDescription, isUnderPath } from "../src/session-browser";
import type { DeviceSnapshot, RemoteStatus } from "../src/session-browser";

interface SessionClient {
  clientId: string;
  type: string;
  name: string;
  pid: number;
  connectedAt: number;
  ip?: string;
}

interface Session {
  id: string;
  name: string;
  backend: string;
  created: number;
  attachedClients: number;
  cwd?: string;
  command?: string;
  pid?: number;
  clients?: SessionClient[];
}

describe("buildTree", () => {
  const now = Date.now();

  test("groups sessions by workspace cwd match", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "dev", backend: "native", created: now, attachedClients: 0, cwd: "/home/user/projectA" },
      { id: "native-2", name: "sub", backend: "native", created: now, attachedClients: 0, cwd: "/home/user/projectA/src" },
      { id: "native-3", name: "other", backend: "native", created: now, attachedClients: 0, cwd: "/tmp/scratch" },
    ];
    const workspacePaths = ["/home/user/projectA"];

    const tree = buildTree(sessions, workspacePaths, "/home/user/projectA", new Set());

    expect(tree).toHaveLength(2);
    expect(tree[0].label).toBe("projectA");
    expect(tree[0].isCurrentWorkspace).toBe(true);
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children.map((c) => c.session.name).sort()).toEqual(["dev", "sub"]);
    expect(tree[1].label).toBe("Other Sessions");
    expect(tree[1].children).toHaveLength(1);
    expect(tree[1].children[0].session.name).toBe("other");
  });

  test("does not match prefix without path boundary", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "real", backend: "native", created: now, attachedClients: 0, cwd: "/home/user/project" },
      { id: "native-2", name: "extra", backend: "native", created: now, attachedClients: 0, cwd: "/home/user/projectExtra" },
    ];
    const workspacePaths = ["/home/user/project"];

    const tree = buildTree(sessions, workspacePaths, "/home/user/project", new Set());

    const wsGroup = tree.find((g) => g.isCurrentWorkspace);
    expect(wsGroup!.children).toHaveLength(1);
    expect(wsGroup!.children[0].session.name).toBe("real");
  });

  test("matches to most specific workspace in multi-root", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "root-session", backend: "native", created: now, attachedClients: 0, cwd: "/home/user/mono" },
      { id: "native-2", name: "pkg-session", backend: "native", created: now, attachedClients: 0, cwd: "/home/user/mono/packages/api" },
    ];
    const workspacePaths = ["/home/user/mono", "/home/user/mono/packages/api"];

    const tree = buildTree(sessions, workspacePaths, "/home/user/mono", new Set());

    const monoGroup = tree.find((g) => g.label === "mono");
    const apiGroup = tree.find((g) => g.label === "api");
    expect(monoGroup!.children).toHaveLength(1);
    expect(monoGroup!.children[0].session.name).toBe("root-session");
    expect(apiGroup!.children).toHaveLength(1);
    expect(apiGroup!.children[0].session.name).toBe("pkg-session");
  });

  test("sessions with no cwd go to Other Sessions", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "no-cwd", backend: "native", created: now, attachedClients: 0 },
    ];

    const tree = buildTree(sessions, [], null, new Set());

    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe("Other Sessions");
    expect(tree[0].children).toHaveLength(1);
  });

  test("marks open sessions", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "dev", backend: "native", created: now, attachedClients: 0, cwd: "/project" },
    ];
    const openSessionIds = new Set(["native-1"]);
    const tree = buildTree(sessions, ["/project"], "/project", openSessionIds);

    expect(tree[0].children[0].isOpen).toBe(true);
  });

  test("no Other Sessions group when all sessions are matched", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "dev", backend: "native", created: now, attachedClients: 0, cwd: "/project" },
    ];

    const tree = buildTree(sessions, ["/project"], "/project", new Set());

    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe("project");
  });

  test("current workspace group comes first", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "a", backend: "native", created: now, attachedClients: 0, cwd: "/alpha" },
      { id: "native-2", name: "b", backend: "native", created: now, attachedClients: 0, cwd: "/beta" },
    ];

    const tree = buildTree(sessions, ["/alpha", "/beta"], "/beta", new Set());

    expect(tree[0].label).toBe("beta");
    expect(tree[0].isCurrentWorkspace).toBe(true);
    expect(tree[1].label).toBe("alpha");
  });
});

describe("buildFullTree", () => {
  const now = Date.now();

  function makeDevice(overrides: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
    return {
      id: "device-1",
      name: "My Laptop",
      online: true,
      last_seen: new Date().toISOString(),
      team_id: "team-1",
      team_name: "Personal",
      sessions: [],
      ...overrides,
    };
  }

  const connectedStatus: RemoteStatus = {
    connected: true,
    account_id: "acct-1",
    device_id: "device-1",
    device_name: "My Laptop",
  };

  test("returns empty teamGroups when remoteStatus is null", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "dev", backend: "native", created: now, attachedClients: 0, cwd: "/home/user/project" },
    ];

    const tree = buildFullTree(sessions, ["/home/user/project"], "/home/user/project", new Set(), null, []);

    expect(tree.teamGroups).toEqual([]);
    expect(tree.localGroups).toHaveLength(1);
    expect(tree.localGroups[0].label).toBe("project");
  });

  test("returns empty teamGroups when remoteStatus.connected is false", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "dev", backend: "native", created: now, attachedClients: 0 },
    ];
    const disconnectedStatus: RemoteStatus = { connected: false };

    const tree = buildFullTree(sessions, [], null, new Set(), disconnectedStatus, []);

    expect(tree.teamGroups).toEqual([]);
    expect(tree.localGroups).toHaveLength(1);
  });

  test("includes team groups when remote is connected", () => {
    const sessions: Session[] = [];
    const devices = [
      makeDevice({ id: "d1", name: "Laptop", team_id: "team-1", team_name: "Personal" }),
    ];

    const tree = buildFullTree(sessions, [], null, new Set(), connectedStatus, devices);

    expect(tree.teamGroups).toHaveLength(1);
    expect(tree.teamGroups[0].teamId).toBe("team-1");
    expect(tree.teamGroups[0].teamName).toBe("Personal");
    expect(tree.teamGroups[0].devices).toHaveLength(1);
    expect(tree.teamGroups[0].devices[0].name).toBe("Laptop");
  });

  test("groups devices by team", () => {
    const sessions: Session[] = [];
    const devices = [
      makeDevice({ id: "d1", name: "Laptop", team_id: "team-1", team_name: "Personal" }),
      makeDevice({ id: "d2", name: "Desktop", team_id: "team-1", team_name: "Personal" }),
      makeDevice({ id: "d3", name: "Server", team_id: "team-2", team_name: "Work" }),
    ];

    const tree = buildFullTree(sessions, [], null, new Set(), connectedStatus, devices);

    expect(tree.teamGroups).toHaveLength(2);
    const personal = tree.teamGroups.find((t) => t.teamName === "Personal");
    const work = tree.teamGroups.find((t) => t.teamName === "Work");
    expect(personal).toBeDefined();
    expect(personal!.devices).toHaveLength(2);
    expect(work).toBeDefined();
    expect(work!.devices).toHaveLength(1);
  });

  test("sorts teams alphabetically by name", () => {
    const sessions: Session[] = [];
    const devices = [
      makeDevice({ id: "d1", team_id: "team-z", team_name: "Zebra" }),
      makeDevice({ id: "d2", team_id: "team-a", team_name: "Alpha" }),
      makeDevice({ id: "d3", team_id: "team-m", team_name: "Middle" }),
    ];

    const tree = buildFullTree(sessions, [], null, new Set(), connectedStatus, devices);

    expect(tree.teamGroups).toHaveLength(3);
    expect(tree.teamGroups[0].teamName).toBe("Alpha");
    expect(tree.teamGroups[1].teamName).toBe("Middle");
    expect(tree.teamGroups[2].teamName).toBe("Zebra");
  });

  test("preserves local cwd grouping alongside team groups", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "dev", backend: "native", created: now, attachedClients: 0, cwd: "/home/user/projectA" },
      { id: "native-2", name: "api", backend: "native", created: now, attachedClients: 1, cwd: "/home/user/projectB" },
    ];

    const devices = [
      makeDevice({ id: "d1", name: "Laptop", team_id: "team-1", team_name: "Personal" }),
    ];

    const tree = buildFullTree(
      sessions, ["/home/user/projectA", "/home/user/projectB"], "/home/user/projectA", new Set(), connectedStatus, devices,
    );

    // Local groups preserved with current workspace first
    expect(tree.localGroups).toHaveLength(2);
    expect(tree.localGroups[0].label).toBe("projectA");
    expect(tree.localGroups[0].isCurrentWorkspace).toBe(true);
    expect(tree.localGroups[1].label).toBe("projectB");

    // Team groups also present
    expect(tree.teamGroups).toHaveLength(1);
    expect(tree.teamGroups[0].teamName).toBe("Personal");
  });
});

describe("stripAnsi", () => {
  test("strips basic SGR color sequences", () => {
    expect(stripAnsi("\x1b[32mgreen\x1b[0m")).toBe("green");
    expect(stripAnsi("\x1b[1mbold\x1b[22m")).toBe("bold");
  });

  test("strips 24-bit color sequences", () => {
    expect(stripAnsi("\x1b[38;2;215;119;87mcolored\x1b[39m")).toBe("colored");
  });

  test("strips OSC sequences (window titles)", () => {
    expect(stripAnsi("\x1b]0;my title\x07prompt")).toBe("prompt");
    expect(stripAnsi("\x1b]0;title\x1b\\rest")).toBe("rest");
  });

  test("strips cursor movement and screen control", () => {
    expect(stripAnsi("\x1b[2Jcleared")).toBe("cleared");
    expect(stripAnsi("\x1b[1A\x1b[Kline")).toBe("line");
  });

  test("strips private mode sequences (?)", () => {
    expect(stripAnsi("\x1b[?2004htext\x1b[?2004l")).toBe("text");
    expect(stripAnsi("\x1b[?25lhidden\x1b[?25h")).toBe("hidden");
  });

  test("strips kitty/extended sequences", () => {
    expect(stripAnsi("\x1b[>1u\x1b[>4;2mtext\x1b[<u")).toBe("text");
  });

  test("strips BEL, BS, and other control chars but keeps newlines and tabs", () => {
    expect(stripAnsi("hello\x07world")).toBe("helloworld");
    expect(stripAnsi("ab\x08c")).toBe("abc");
    expect(stripAnsi("line1\nline2")).toBe("line1\nline2");
    expect(stripAnsi("col1\tcol2")).toBe("col1\tcol2");
  });

  test("strips carriage returns", () => {
    expect(stripAnsi("hello\r\nworld")).toBe("hello\nworld");
    expect(stripAnsi("overwrite\rthis")).toBe("overwritethis");
  });

  test("handles real zsh prompt scrollback", () => {
    // Actual scrollback from a zsh session with prompt coloring
    const raw = "\x1b]0;~/Dev/project\x07\r\n\x1b[0m\x1b[27m\x1b[24m\x1b[J\x1b[34m~/Dev/project\x1b[39m\r\n\r\x1b[35m❯\x1b[39m \x1b[K\x1b[?2004h";
    const clean = stripAnsi(raw);
    expect(clean).toContain("~/Dev/project");
    expect(clean).toContain("❯");
    expect(clean).not.toContain("\x1b");
    expect(clean).not.toContain("\x07");
    expect(clean).not.toContain("\r");
  });
});

describe("shortenPath", () => {
  test("replaces home directory with ~", () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home) {
      expect(shortenPath(home + "/projects/foo")).toBe("~/projects/foo");
    }
  });

  test("returns path unchanged when not under home", () => {
    expect(shortenPath("/tmp/foo")).toBe("/tmp/foo");
  });
});

describe("formatAge", () => {
  test("shows seconds for < 60s", () => {
    expect(formatAge(Date.now() - 30000)).toBe("30s");
  });

  test("shows minutes for < 60m", () => {
    expect(formatAge(Date.now() - 5 * 60 * 1000)).toBe("5m");
  });

  test("shows hours for < 24h", () => {
    expect(formatAge(Date.now() - 3 * 60 * 60 * 1000)).toBe("3h");
  });

  test("shows days for >= 24h", () => {
    expect(formatAge(Date.now() - 2 * 24 * 60 * 60 * 1000)).toBe("2d");
  });
});

describe("buildSessionDescription", () => {
  test("shows command and age", () => {
    const desc = buildSessionDescription(
      { id: "1", name: "x", backend: "native", created: Date.now() - 60000, attachedClients: 0, pid: 123, command: "npm start", clients: [] },
    );
    expect(desc).toContain("npm start");
    expect(desc).toContain("1m");
    expect(desc).not.toContain("stopped");
  });

  test("shows stopped when no pid", () => {
    const desc = buildSessionDescription(
      { id: "1", name: "x", backend: "native", created: Date.now(), attachedClients: 0, clients: [] },
    );
    expect(desc).toContain("stopped");
  });

  test("shows age without command when no command", () => {
    const desc = buildSessionDescription(
      { id: "1", name: "x", backend: "native", created: Date.now() - 120000, attachedClients: 0, pid: 1, clients: [] },
    );
    expect(desc).toContain("2m");
    expect(desc).not.toContain("undefined");
  });
});

describe("clientDescription", () => {
  test("shows ip for web clients", () => {
    expect(clientDescription({ clientId: "1", type: "web", name: "browser", pid: 0, connectedAt: 0, ip: "1.2.3.4" })).toBe("1.2.3.4");
  });

  test("shows 'web' for web client without ip", () => {
    expect(clientDescription({ clientId: "1", type: "web", name: "browser", pid: 0, connectedAt: 0 })).toBe("web");
  });

  test("shows pid for non-web clients", () => {
    expect(clientDescription({ clientId: "1", type: "cli", name: "term", pid: 12345, connectedAt: 0 })).toBe("pid 12345");
  });

  test("shows type when no pid", () => {
    expect(clientDescription({ clientId: "1", type: "vscode", name: "VS Code", pid: 0, connectedAt: 0 })).toBe("vscode");
  });
});

describe("isUnderPath", () => {
  test("exact match returns true", () => {
    expect(isUnderPath("/home/user/project", "/home/user/project")).toBe(true);
  });

  test("subdirectory returns true", () => {
    expect(isUnderPath("/home/user/project/src", "/home/user/project")).toBe(true);
  });

  test("deep subdirectory returns true", () => {
    expect(isUnderPath("/home/user/project/src/pkg", "/home/user/project")).toBe(true);
  });

  test("different path returns false", () => {
    expect(isUnderPath("/home/user/other", "/home/user/project")).toBe(false);
  });

  test("prefix but not boundary returns false", () => {
    expect(isUnderPath("/home/user/projectExtra", "/home/user/project")).toBe(false);
  });

  test("trailing slash on parent", () => {
    expect(isUnderPath("/home/user/project/src", "/home/user/project/")).toBe(true);
  });

  test("empty child returns false", () => {
    expect(isUnderPath("", "/home/user/project")).toBe(false);
  });

  test("empty parent returns false", () => {
    expect(isUnderPath("/home/user/project", "")).toBe(false);
  });
});
