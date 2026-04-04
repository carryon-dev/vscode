import * as vscode from "vscode";
import * as cp from "child_process";

function execAsync(file: string, args: string[], options: cp.ExecFileOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, { ...options, encoding: "utf-8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout ?? ""));
    });
  });
}

export async function resolveCliPath(): Promise<string | null> {
  // Check user setting first
  const configured = vscode.workspace.getConfiguration("carryon").get<string>("cliPath", "");
  if (configured) {
    try {
      await execAsync(configured, ["--version"], { timeout: 5000 });
      return configured;
    } catch {
      // Configured path doesn't work, fall through
    }
  }

  // Auto-detect from PATH
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = await execAsync(cmd, ["carryon"], { timeout: 5000 });
    const trimmed = result.trim();
    if (trimmed) return trimmed.split("\n")[0];
  } catch {
    // Not found
  }

  return null;
}

export function getInstallCommand(): { label: string; command: string } {
  if (process.platform === "win32") {
    return {
      label: "Install (Scoop)",
      command: "scoop bucket add carryon https://github.com/carryon-dev/scoop-bucket && scoop install carryon",
    };
  }
  if (process.platform === "darwin") {
    return {
      label: "Install (Homebrew)",
      command: "brew install carryon-dev/tap/carryon",
    };
  }
  // Linux - use the quick install script
  return {
    label: "Install",
    command: "curl -fsSL https://carryon.dev/get | sh",
  };
}

export function showCliNotFound(context: vscode.ExtensionContext): void {
  const { label, command } = getInstallCommand();
  const docs = "View Docs";
  vscode.window
    .showErrorMessage(
      `carryOn CLI is not installed. Run: ${command}`,
      label,
      docs,
    )
    .then((choice) => {
      if (choice === label) {
        const terminal = vscode.window.createTerminal("carryOn Install");
        terminal.sendText(command);
        terminal.show();
      } else if (choice === docs) {
        vscode.env.openExternal(vscode.Uri.parse("https://github.com/carryon-dev/cli"));
      }
    });

  // Periodically check if CLI becomes available
  const checkInterval = setInterval(async () => {
    if (await resolveCliPath()) {
      clearInterval(checkInterval);
      vscode.window.showInformationMessage("carryOn CLI detected. Reloading...");
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }, 10000);

  context.subscriptions.push({ dispose: () => clearInterval(checkInterval) });
}

export async function ensureDaemon(cliPath: string): Promise<void> {
  try {
    await execAsync(cliPath, ["status"], { timeout: 5000 });
  } catch {
    // Daemon not running - start it
    try {
      const child = cp.spawn(cliPath, ["start"], { detached: true, stdio: "ignore" });
      child.unref();
      // Give it a moment to start
      await new Promise((r) => setTimeout(r, 1000));
    } catch {
      // Will handle connection failure later
    }
  }
}
