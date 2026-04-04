import { vi, describe, test, expect, beforeEach, afterEach } from "vitest";
import * as cp from "child_process";
import * as vscode from "vscode";

vi.mock("child_process");

import { getInstallCommand, resolveCliPath, ensureDaemon } from "../src/cli";

// Helper: mock cp.execFile to call its callback with a result or error.
// cp.execFile has multiple overloads; the async wrapper always passes (file, args, opts, callback).
function mockExecFileOnce(result: string | Error) {
  vi.mocked(cp.execFile as Function).mockImplementationOnce(
    (_file: string, _args: string[], _opts: unknown, callback?: Function) => {
      const cb = typeof _opts === "function" ? _opts : callback;
      if (result instanceof Error) {
        cb?.(result, "", "");
      } else {
        cb?.(null, result, "");
      }
      return {} as cp.ChildProcess;
    },
  );
}

describe("getInstallCommand", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  test("returns homebrew command on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const result = getInstallCommand();
    expect(result.label).toBe("Install (Homebrew)");
    expect(result.command).toContain("brew install");
  });

  test("returns scoop command on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const result = getInstallCommand();
    expect(result.label).toBe("Install (Scoop)");
    expect(result.command).toContain("scoop");
  });

  test("returns curl command on Linux", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const result = getInstallCommand();
    expect(result.label).toBe("Install");
    expect(result.command).toContain("curl");
  });
});

describe("resolveCliPath", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("returns null when CLI not found", async () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: vi.fn().mockReturnValue(""),
    } as any);
    // which/where call fails
    mockExecFileOnce(new Error("not found"));

    const result = await resolveCliPath();
    expect(result).toBeNull();
  });

  test("returns path from PATH when found", async () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: vi.fn().mockReturnValue(""),
    } as any);
    // which call succeeds
    mockExecFileOnce("/usr/local/bin/carryon\n");

    const result = await resolveCliPath();
    expect(result).toBe("/usr/local/bin/carryon");
  });

  test("uses configured path when valid", async () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: vi.fn().mockReturnValue("/custom/path/carryon"),
    } as any);
    // --version check succeeds
    mockExecFileOnce("0.1.0");

    const result = await resolveCliPath();
    expect(result).toBe("/custom/path/carryon");
  });

  test("falls through to PATH when configured path fails", async () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: vi.fn().mockReturnValue("/bad/path"),
    } as any);
    // First call: configured path version check fails
    mockExecFileOnce(new Error("not found"));
    // Second call: PATH lookup via `which`
    mockExecFileOnce("/usr/local/bin/carryon\n");

    const result = await resolveCliPath();
    expect(result).toBe("/usr/local/bin/carryon");
  });
});

describe("ensureDaemon", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("does not start daemon if already running", async () => {
    // status check succeeds
    mockExecFileOnce("");

    await ensureDaemon("/usr/local/bin/carryon");

    expect(cp.execFile).toHaveBeenCalledWith(
      "/usr/local/bin/carryon",
      ["status"],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
    expect(cp.spawn).not.toHaveBeenCalled();
  });

  test("starts daemon if status check fails", async () => {
    // status check fails
    mockExecFileOnce(new Error("not running"));
    vi.mocked(cp.spawn).mockReturnValue({ unref: vi.fn() } as any);

    await ensureDaemon("/usr/local/bin/carryon");

    expect(cp.spawn).toHaveBeenCalledWith(
      "/usr/local/bin/carryon",
      ["start"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });
});
