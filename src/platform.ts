import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

export function getBaseDir(): string {
  return path.join(os.homedir(), ".carryon");
}

export function getSocketPath(baseDir: string): string {
  if (process.platform === "win32") {
    const hash = crypto.createHash("sha256").update(baseDir).digest("hex").slice(0, 12);
    return `\\\\.\\pipe\\carryon-${hash}`;
  }
  return path.join(baseDir, "daemon.sock");
}
