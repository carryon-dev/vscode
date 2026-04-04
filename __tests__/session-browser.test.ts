import { buildTree, buildFullTree, buildProjectMap, stripAnsi, shortenPath, formatAge, buildSessionDescription, clientDescription } from "../src/session-browser";
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

  test("groups sessions by project with current workspace first", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "dev", backend: "native", created: now, attachedClients: 0, cwd: "/home/user/projectA" },
      { id: "native-2", name: "api", backend: "native", created: now, attachedClients: 1, cwd: "/home/user/projectB" },
      { id: "native-3", name: "scratch", backend: "native", created: now, attachedClients: 0 },
    ];
    const projectMap = new Map<string, string[]>();
    projectMap.set("/home/user/projectA", ["native-1"]);
    projectMap.set("/home/user/projectB", ["native-2"]);

    const tree = buildTree(sessions, projectMap, "/home/user/projectA", new Set());

    expect(tree).toHaveLength(3); // projectA, projectB, Other (no cwd)
    expect(tree[0].label).toBe("projectA");
    expect(tree[0].isCurrentWorkspace).toBe(true);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].session.name).toBe("dev");
    expect(tree[1].label).toBe("projectB");
    expect(tree[2].label).toBe("Other");
    expect(tree[2].children).toHaveLength(1);
    expect(tree[2].children[0].session.name).toBe("scratch");
  });

  test("unassigned sessions with cwd are grouped by cwd", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "dev", backend: "native", created: now, attachedClients: 0, cwd: "/home/user/myapp" },
      { id: "native-2", name: "api", backend: "native", created: now, attachedClients: 0, cwd: "/home/user/myapp" },
      { id: "native-3", name: "other", backend: "native", created: now, attachedClients: 0, cwd: "/tmp/scratch" },
    ];

    const tree = buildTree(sessions, new Map(), null, new Set());

    expect(tree).toHaveLength(2); // two cwd groups
    const myapp = tree.find((g) => g.label.includes("myapp"));
    expect(myapp).toBeDefined();
    expect(myapp!.children).toHaveLength(2);
  });

  test("marks assigned vs unassigned sessions", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "dev", backend: "native", created: now, attachedClients: 0 },
      { id: "native-2", name: "api", backend: "native", created: now, attachedClients: 0 },
    ];
    const projectMap = new Map<string, string[]>();
    projectMap.set("/home/user/projectA", ["native-1"]);

    const tree = buildTree(sessions, projectMap, "/home/user/projectA", new Set());

    // native-1 is in projectA - assigned
    expect(tree[0].children[0].isAssigned).toBe(true);
    // native-2 is unassigned
    const other = tree.find((g) => g.label === "Other");
    expect(other!.children[0].isAssigned).toBe(false);
  });

  test("marks open sessions", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "dev", backend: "native", created: now, attachedClients: 0 },
    ];
    const openSessionIds = new Set(["native-1"]);
    const tree = buildTree(sessions, new Map(), null, openSessionIds);

    expect(tree[0].children[0].isOpen).toBe(true);
  });

  test("omits empty groups except current workspace", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "dev", backend: "native", created: now, attachedClients: 0 },
    ];
    const projectMap = new Map<string, string[]>();
    projectMap.set("/home/user/projectA", ["native-1"]);

    const tree = buildTree(sessions, projectMap, "/home/user/projectA", new Set());

    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe("projectA");
  });
});

describe("buildProjectMap", () => {
  test("extracts session IDs from associated sessions using .id field", async () => {
    // This is the exact shape the daemon returns - full Session objects with .id
    const mockClient = {
      call: vi.fn().mockResolvedValue({
        declared: [],
        associated: [
          { id: "native-abc123", name: "dev", backend: "native", created: 1, attachedClients: 0 },
          { id: "native-def456", name: "api", backend: "native", created: 2, attachedClients: 1 },
        ],
      }),
    };

    const result = await buildProjectMap(mockClient, ["/home/user/myapp"]);

    expect(result.get("/home/user/myapp")).toEqual(["native-abc123", "native-def456"]);
    expect(mockClient.call).toHaveBeenCalledWith("project.terminals", { path: "/home/user/myapp" });
  });

  test("handles multiple workspace paths", async () => {
    const mockClient = {
      call: vi.fn()
        .mockResolvedValueOnce({
          declared: [],
          associated: [{ id: "native-1", name: "a", backend: "native", created: 1, attachedClients: 0 }],
        })
        .mockResolvedValueOnce({
          declared: [],
          associated: [{ id: "native-2", name: "b", backend: "native", created: 1, attachedClients: 0 }],
        }),
    };

    const result = await buildProjectMap(mockClient, ["/path/a", "/path/b"]);

    expect(result.get("/path/a")).toEqual(["native-1"]);
    expect(result.get("/path/b")).toEqual(["native-2"]);
  });

  test("skips workspace paths with no associations", async () => {
    const mockClient = {
      call: vi.fn().mockResolvedValue({
        declared: [],
        associated: [],
      }),
    };

    const result = await buildProjectMap(mockClient, ["/home/user/empty"]);

    expect(result.size).toBe(0);
  });

  test("ignores errors from individual workspace queries", async () => {
    const mockClient = {
      call: vi.fn()
        .mockRejectedValueOnce(new Error("not found"))
        .mockResolvedValueOnce({
          declared: [],
          associated: [{ id: "native-1", name: "a", backend: "native", created: 1, attachedClients: 0 }],
        }),
    };

    const result = await buildProjectMap(mockClient, ["/bad/path", "/good/path"]);

    expect(result.size).toBe(1);
    expect(result.get("/good/path")).toEqual(["native-1"]);
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
    const projectMap = new Map<string, string[]>();
    projectMap.set("/home/user/project", ["native-1"]);

    const tree = buildFullTree(sessions, projectMap, "/home/user/project", new Set(), null, []);

    expect(tree.teamGroups).toEqual([]);
    expect(tree.localGroups).toHaveLength(1);
    expect(tree.localGroups[0].label).toBe("project");
  });

  test("returns empty teamGroups when remoteStatus.connected is false", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "dev", backend: "native", created: now, attachedClients: 0 },
    ];
    const disconnectedStatus: RemoteStatus = { connected: false };

    const tree = buildFullTree(sessions, new Map(), null, new Set(), disconnectedStatus, []);

    expect(tree.teamGroups).toEqual([]);
    expect(tree.localGroups).toHaveLength(1);
  });

  test("includes team groups when remote is connected", () => {
    const sessions: Session[] = [];
    const devices = [
      makeDevice({ id: "d1", name: "Laptop", team_id: "team-1", team_name: "Personal" }),
    ];

    const tree = buildFullTree(sessions, new Map(), null, new Set(), connectedStatus, devices);

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

    const tree = buildFullTree(sessions, new Map(), null, new Set(), connectedStatus, devices);

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

    const tree = buildFullTree(sessions, new Map(), null, new Set(), connectedStatus, devices);

    expect(tree.teamGroups).toHaveLength(3);
    expect(tree.teamGroups[0].teamName).toBe("Alpha");
    expect(tree.teamGroups[1].teamName).toBe("Middle");
    expect(tree.teamGroups[2].teamName).toBe("Zebra");
  });

  test("preserves local project grouping alongside team groups", () => {
    const sessions: Session[] = [
      { id: "native-1", name: "dev", backend: "native", created: now, attachedClients: 0, cwd: "/home/user/projectA" },
      { id: "native-2", name: "api", backend: "native", created: now, attachedClients: 1, cwd: "/home/user/projectB" },
    ];
    const projectMap = new Map<string, string[]>();
    projectMap.set("/home/user/projectA", ["native-1"]);
    projectMap.set("/home/user/projectB", ["native-2"]);

    const devices = [
      makeDevice({ id: "d1", name: "Laptop", team_id: "team-1", team_name: "Personal" }),
    ];

    const tree = buildFullTree(
      sessions, projectMap, "/home/user/projectA", new Set(), connectedStatus, devices,
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
