# carryOn for VS Code

Persistent terminal sessions for VS Code. Start a terminal, close the editor, reopen it - your session is right where you left it, processes running, scrollback intact.

carryOn is a terminal session manager. A background daemon keeps your sessions alive through editor crashes, SSH drops, system restarts, and everything else. This extension brings your carryOn sessions into VS Code as native terminal tabs with a dedicated sidebar for browsing, managing, and monitoring them.

## Features

### Sessions that survive everything

Your terminal sessions persist no matter what happens. Close VS Code, reboot your machine, lose your network connection - when you come back, your sessions are still running. Full scrollback is preserved so you can see everything that happened while you were away.

### Work with AI agents

Running Claude, Copilot, or another AI agent on a long task? Check on it from your phone via the built-in web UI, respond to prompts, approve actions, and course-correct without being at your desk. carryOn keeps agent sessions alive and accessible from VS Code, the CLI, or any browser on your network.

### Session browser sidebar

A dedicated activity bar panel shows all your sessions organized by workspace, project, and working directory. See which clients are connected, hover for session details, and open any session with a click. Remote sessions from other devices on your team appear here too.

### Project configuration

Define your project's terminals in a `.carryon.json` file and carryOn will offer to start them when you open the workspace. Your dev server, test watcher, and build process - all launched automatically, all persistent. Wrap terminals in an array to open them as a split group, and set `color` for colored tab icons.

```json
{
  "version": 1,
  "terminals": [
    { "name": "server", "command": "npm run dev", "color": "green" },
    [
      { "name": "tests", "command": "npm test -- --watch", "color": "yellow" },
      { "name": "logs", "command": "tail -f app.log", "color": "cyan" }
    ]
  ]
}
```

### Access from your local network

carryOn includes a built-in web UI that lets you access your sessions from any browser on your network - your phone, tablet, or another machine. No account required, no cloud, no relay. When exposed to the network, carryOn automatically adds password protection and self-signed TLS.

```bash
carryon config set local.enabled true
carryon config set local.expose true
```

### Remote access with E2E encryption

Need to reach your sessions from outside your local network? carryOn's relay connects your devices over the internet with end-to-end encryption (X25519 + ChaCha20-Poly1305). The relay cannot read your data. Browse remote devices and their sessions directly from the VS Code sidebar. No VPN, no tunnels, no port forwarding.

### Built-in settings panel

Configure carryOn directly from VS Code. The settings panel in the sidebar shows daemon status, lets you toggle the web UI, switch backends, and adjust configuration - all with live updates.

## Requirements

The [carryOn CLI](https://github.com/carryon-dev/cli) must be installed and available on your PATH.

```bash
# macOS
brew install carryon-dev/tap/carryon

# Linux / macOS (manual)
curl -fsSL https://carryon.dev/get | sh
```

The daemon starts automatically on first use - no manual setup needed.

## Getting started

1. Install the carryOn CLI (see above)
2. Install this extension from the VS Code Marketplace
3. Open the carryOn sidebar (activity bar icon) - your sessions appear automatically

Create a new session using the **carryOn** terminal profile (Terminal > New Terminal dropdown) or from the command line:

```bash
carryon --name dev-server
```

The session appears as a VS Code terminal tab. Detach with `Ctrl+C Ctrl+C` (double tap). Close VS Code entirely. Reopen it. Your session is still there.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `carryon.cliPath` | auto-detected | Path to the carryOn CLI binary |
| `carryon.autoOpenTerminals` | `false` | Auto-open terminals declared in `.carryon.json` when opening a workspace |

## Commands

All commands are available from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
| --- | --- |
| carryOn: Open in Terminal | Open a session as a VS Code terminal tab |
| carryOn: Kill Session | Terminate a session and its processes |
| carryOn: Rename Session | Rename a session |
| carryOn: Associate with Workspace | Link a session to the current workspace |
| carryOn: Detach from Workspace | Remove a session's workspace association |
| carryOn: Refresh Sessions | Refresh the session list |
| carryOn: Open Logs | View daemon logs |

## How it works

carryOn runs a background daemon that manages terminal sessions independently of any editor or client. The VS Code extension connects to the daemon over a Unix socket (IPC) and spawns `carryon attach` processes inside VS Code's terminal emulator. This means carryOn sessions look and feel like regular VS Code terminals, but they outlive the editor.

The extension supports two backends:

- **native** - built-in PTY management with no external dependencies (default)
- **tmux** - delegates to tmux for users who prefer it

## Links

- [carryOn website](https://carryon.dev)
- [CLI repository](https://github.com/carryon-dev/cli)
- [Documentation](https://carryon.dev/docs)
- [Report an issue](https://github.com/carryon-dev/vscode/issues)

## License

[Functional Source License 1.1 (FSL-1.1-ALv2)](https://fsl.software). You can read, modify, and use the code freely - you just can't use it to build a competing product. After 2 years, each version converts to Apache 2.0.
