import { getSocketPath, getBaseDir } from "../src/platform";
import * as path from "path";
import * as os from "os";

describe("platform", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  test("getBaseDir returns ~/.carryon", () => {
    const result = getBaseDir();
    expect(result).toBe(path.join(os.homedir(), ".carryon"));
  });

  test("getSocketPath returns socket file on unix", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const baseDir = "/tmp/test-carryon";
    const result = getSocketPath(baseDir);
    expect(result).toBe(path.join(baseDir, "daemon.sock"));
  });

  test("getSocketPath returns named pipe on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const baseDir = "C:\\Users\\test\\.carryon";
    const result = getSocketPath(baseDir);
    expect(result).toMatch(/^\\\\.\\pipe\\carryon-[a-f0-9]{12}$/);
  });

  test("Windows pipe hash is deterministic for same path", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const baseDir = "C:\\Users\\test\\.carryon";
    const a = getSocketPath(baseDir);
    const b = getSocketPath(baseDir);
    expect(a).toBe(b);
  });

  test("Windows pipe hash differs for different paths", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const a = getSocketPath("C:\\Users\\alice\\.carryon");
    const b = getSocketPath("C:\\Users\\bob\\.carryon");
    expect(a).not.toBe(b);
  });
});
