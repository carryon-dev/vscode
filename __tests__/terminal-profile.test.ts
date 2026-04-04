import { SessionTerminalMap } from "../src/terminal-profile";

describe("SessionTerminalMap", () => {
  test("tracks session-to-terminal associations", () => {
    const map = new SessionTerminalMap();
    const fakeTerminal = { name: "test" } as any;

    expect(map.has("session-1")).toBe(false);
    map.set("session-1", fakeTerminal);
    expect(map.has("session-1")).toBe(true);
    expect(map.get("session-1")).toBe(fakeTerminal);
  });

  test("removes association", () => {
    const map = new SessionTerminalMap();
    const fakeTerminal = { name: "test" } as any;

    map.set("session-1", fakeTerminal);
    map.deleteByTerminal(fakeTerminal);
    expect(map.has("session-1")).toBe(false);
  });

  test("finds session ID by terminal", () => {
    const map = new SessionTerminalMap();
    const t1 = { name: "t1" } as any;
    const t2 = { name: "t2" } as any;

    map.set("session-a", t1);
    map.set("session-b", t2);
    expect(map.getSessionId(t2)).toBe("session-b");
    expect(map.getSessionId({ name: "unknown" } as any)).toBeUndefined();
  });

  test("generates incremented name for workspace", () => {
    const map = new SessionTerminalMap();
    expect(map.nextName("my-project")).toBe("my-project-1");

    map.set("s1", { name: "my-project-1" } as any);
    expect(map.nextName("my-project")).toBe("my-project-2");

    map.set("s2", { name: "my-project-2" } as any);
    expect(map.nextName("my-project")).toBe("my-project-3");
  });

  test("removes association by session ID", () => {
    const map = new SessionTerminalMap();
    const t1 = { name: "t1" } as any;
    const t2 = { name: "t2" } as any;

    map.set("session-a", t1);
    map.set("session-b", t2);

    map.deleteBySessionId("session-a");
    expect(map.has("session-a")).toBe(false);
    expect(map.get("session-a")).toBeUndefined();
    expect(map.getSessionId(t1)).toBeUndefined();
    // session-b unaffected
    expect(map.has("session-b")).toBe(true);
    expect(map.getSessionId(t2)).toBe("session-b");
  });

  test("deleteBySessionId is a no-op for unknown ID", () => {
    const map = new SessionTerminalMap();
    const t1 = { name: "t1" } as any;
    map.set("session-a", t1);
    map.deleteBySessionId("nonexistent");
    expect(map.has("session-a")).toBe(true);
  });

  test("detects terminal renames", () => {
    const map = new SessionTerminalMap();
    const terminal = { name: "original" } as any;
    map.set("session-1", terminal);

    // No rename yet
    expect(map.getRenamed()).toEqual([]);

    // Simulate VS Code renaming the terminal tab
    (terminal as any).name = "renamed";
    const renamed = map.getRenamed();
    expect(renamed).toEqual([{ sessionId: "session-1", newName: "renamed" }]);

    // Second call should not report again (cache updated)
    expect(map.getRenamed()).toEqual([]);
  });

  test("getRenamed tracks multiple renames", () => {
    const map = new SessionTerminalMap();
    const t1 = { name: "a" } as any;
    const t2 = { name: "b" } as any;
    map.set("s1", t1);
    map.set("s2", t2);

    (t1 as any).name = "a-new";
    (t2 as any).name = "b-new";
    const renamed = map.getRenamed();
    expect(renamed).toHaveLength(2);
    expect(renamed).toContainEqual({ sessionId: "s1", newName: "a-new" });
    expect(renamed).toContainEqual({ sessionId: "s2", newName: "b-new" });
  });
});
