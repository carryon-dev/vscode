import * as crypto from "crypto";
import * as vscode from "vscode";
import type { DaemonClient } from "./daemon-client";

interface DaemonStatus {
  uptime: number;
  pid: number;
  backends: Array<{ id: string; available: boolean }>;
  sessions: number;
  local?: { running: boolean; enabled: boolean; expose: boolean; port: number; url?: string; password_set?: boolean };
  remote?: { enabled: boolean; connected: boolean; device_name?: string; relay?: string };
}

interface ConfigSchema {
  schemaVersion: number;
  groups: ConfigGroup[];
}

interface ConfigGroup {
  key: string;
  name: string;
  description: string;
  settings: ConfigSetting[];
}

interface ConfigSetting {
  key: string;
  name: string;
  description: string;
  type: "string" | "number" | "bool";
  default: unknown;
  value: unknown;
  enum?: string[];
  min?: number;
  max?: number;
}

interface SettingsState {
  daemon: DaemonStatus | null;
  schema: ConfigSchema | null;
  connected: boolean;
}

export class SettingsWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private schema: ConfigSchema | null = null;
  private onConfigChanged: (params: unknown) => void;

  constructor(
    private client: DaemonClient,
    private extensionUri: vscode.Uri,
  ) {
    this.onConfigChanged = (params: unknown) => {
      if (!params || typeof params !== "object") return;
      const p = params as Record<string, unknown>;
      const key = p.key;
      const value = p.value;
      if (typeof key !== "string") return;
      const setting = this.findSetting(key);
      if (setting) setting.value = value;
      this.view?.webview.postMessage({ type: "configChanged", key, value });
      // Refresh status in case the config change affected daemon state
      // (e.g. enabling/disabling local server or remote)
      this.sendStatus();
    };
    this.client.onNotification("config.changed", this.onConfigChanged);
  }

  dispose(): void {
    this.client.offNotification("config.changed", this.onConfigChanged);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "getStatus":
          await this.sendStatus();
          break;
        case "configSet": {
          try {
            const result = await this.client.call<{ ok: boolean; warning?: string }>(
              "config.set",
              { key: message.key, value: String(message.value) },
            );
            const genResult = result as Record<string, unknown>;
            if (result.warning) {
              if (typeof genResult.generated_password === "string") {
                const password = genResult.generated_password;
                const action = await vscode.window.showWarningMessage(
                  `${result.warning}. Web access password: ${password}`,
                  "Copy Password",
                );
                if (action === "Copy Password") {
                  await vscode.env.clipboard.writeText(password);
                }
              } else {
                vscode.window.showWarningMessage(result.warning);
              }
            }
            // Optimistically update cached schema
            const cached = this.findSetting(message.key);
            if (cached) cached.value = message.value;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to set ${message.key}: ${msg}`);
            // Revert the control to the cached value
            const revert = this.findSetting(message.key);
            if (revert) {
              this.view?.webview.postMessage({
                type: "configChanged",
                key: message.key,
                value: revert.value,
              });
            }
          }
          break;
        }
        case "changeWebPassword":
          vscode.commands.executeCommand("carryon.changeWebPassword");
          break;
        case "openLogs":
          vscode.commands.executeCommand("carryon.openLogs");
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendStatus();
      }
    });

    this.sendStatus();

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  private findSetting(key: string): ConfigSetting | undefined {
    if (!this.schema) return undefined;
    for (const group of this.schema.groups) {
      for (const setting of group.settings) {
        if (setting.key === key) return setting;
      }
    }
    return undefined;
  }

  private async sendStatus(): Promise<void> {
    if (!this.view) return;

    const state: SettingsState = {
      daemon: null,
      schema: null,
      connected: this.client.connected,
    };

    if (this.client.connected) {
      const [daemonResult, schemaResult] = await Promise.allSettled([
        this.client.call<DaemonStatus>("daemon.status"),
        this.client.call<ConfigSchema>("config.schema"),
      ]);

      if (daemonResult.status === "fulfilled") {
        state.daemon = daemonResult.value;
      }

      if (schemaResult.status === "fulfilled") {
        this.schema = schemaResult.value;
        state.schema = this.schema;
      } else {
        state.schema = null;
        this.schema = null;
        const msg = schemaResult.reason instanceof Error
          ? schemaResult.reason.message : String(schemaResult.reason);
        this.view?.webview.postMessage({ type: "schemaError", error: msg });
      }
    }

    this.view?.webview.postMessage({ type: "status", ...state });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      padding: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      line-height: 1.5;
    }

    /* -- Status section -- */
    .status-section {
      padding: 12px 16px 14px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border));
    }
    .status-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .status-title {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    }
    .status-link {
      margin-left: auto;
      font-size: 11px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }
    .status-link:hover { text-decoration: underline; }
    .status-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 2px 0;
      font-size: var(--vscode-font-size);
    }
    .status-label {
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    .status-value {
      color: var(--vscode-foreground);
      font-variant-numeric: tabular-nums;
    }
    .status-value a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .status-value a:hover { text-decoration: underline; }
    .badge {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 500;
    }
    .badge-running {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 20%, transparent);
      color: var(--vscode-testing-iconPassed);
    }
    .badge-stopped {
      background: color-mix(in srgb, var(--vscode-testing-iconFailed) 20%, transparent);
      color: var(--vscode-testing-iconFailed);
    }
    .badge-disconnected {
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 20%, transparent);
      color: var(--vscode-editorWarning-foreground);
    }
    .badge-muted {
      background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    .backends { display: flex; gap: 4px; flex-wrap: wrap; }
    .backend-tag {
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 11px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    /* -- Config groups -- */
    .config-group {
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border));
    }
    .config-group:last-child { border-bottom: none; }
    .group-title {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      padding: 14px 16px 0;
    }
    .group-desc {
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      font-size: var(--vscode-font-size);
      padding: 3px 16px 0;
      line-height: 1.4;
    }
    .group-settings {
      padding: 8px 0 6px;
    }

    /* -- Individual settings -- */
    .setting {
      padding: 7px 16px;
    }
    .setting-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      min-height: 28px;
    }
    .setting-label {
      font-size: var(--vscode-font-size);
      font-weight: 500;
      color: var(--vscode-foreground);
      white-space: nowrap;
    }
    .setting-control {
      flex-shrink: 0;
    }
    .setting-desc {
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      font-size: var(--vscode-font-size);
      line-height: 1.4;
      padding-top: 2px;
    }

    /* -- Toggle switch -- */
    .switch {
      position: relative;
      width: 36px;
      height: 20px;
      cursor: pointer;
      display: inline-block;
      vertical-align: middle;
    }
    .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
    .switch-track {
      position: absolute;
      inset: 0;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      border-radius: 10px;
      transition: all 0.15s ease;
    }
    .switch-track::after {
      content: "";
      position: absolute;
      height: 14px;
      width: 14px;
      left: 2px;
      top: 2px;
      background: var(--vscode-foreground);
      opacity: 0.5;
      border-radius: 50%;
      transition: all 0.15s ease;
    }
    .switch input:checked + .switch-track {
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
    }
    .switch input:checked + .switch-track::after {
      transform: translateX(16px);
      background: var(--vscode-button-foreground);
      opacity: 1;
    }
    .switch:hover .switch-track {
      border-color: var(--vscode-focusBorder);
    }

    /* -- Shared control width -- */
    .setting-select,
    .setting-input {
      width: 110px;
      border-radius: 3px;
      padding: 4px 8px;
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
      outline: none;
    }
    .setting-select {
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, var(--vscode-widget-border)));
      cursor: pointer;
    }
    .setting-input {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    }
    .setting-input[type="number"] { text-align: right; }
    .setting-select:focus,
    .setting-input:focus { border-color: var(--vscode-focusBorder); }
    .setting-btn {
      padding: 4px 12px;
      border-radius: 3px;
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      border: none;
      cursor: pointer;
    }
    .setting-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }

    /* -- Placeholder -- */
    .placeholder {
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      font-style: italic;
      font-size: var(--vscode-font-size);
      padding: 16px;
    }
  </style>
</head>
<body>
  <div class="status-section">
    <div class="status-header">
      <span class="status-title">Status</span>
      <span id="daemon-badge"></span>
      <a class="status-link" id="open-logs-btn">View Logs</a>
    </div>
    <div id="daemon-status">Loading...</div>
  </div>

  <div id="settings-content"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentState = {};

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function formatUptime(seconds) {
      if (seconds < 60) return Math.floor(seconds) + 's';
      const m = Math.floor(seconds / 60);
      if (m < 60) return m + 'm';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h ' + (m % 60) + 'm';
      const d = Math.floor(h / 24);
      return d + 'd ' + (h % 24) + 'h';
    }

    function renderDaemon(daemon, connected) {
      const badge = document.getElementById('daemon-badge');
      const el = document.getElementById('daemon-status');
      if (!connected) {
        badge.innerHTML = '<span class="badge badge-disconnected">Disconnected</span>';
        el.innerHTML = '';
        return;
      }
      if (!daemon) {
        badge.innerHTML = '<span class="badge badge-stopped">Unavailable</span>';
        el.innerHTML = '';
        return;
      }
      badge.innerHTML = '<span class="badge badge-running">Running</span>';
      const backends = (daemon.backends || [])
        .filter(function(b) { return b.available; })
        .map(function(b) { return '<span class="backend-tag">' + escapeHtml(b.id) + '</span>'; })
        .join('');

      const local = daemon.local;
      let localValue = '<span class="badge badge-muted">Not enabled</span>';
      if (local && local.enabled) {
        var rawUrl = local.url ? local.url.replace('0.0.0.0', 'localhost') : '';
        if (local.running && rawUrl && (rawUrl.startsWith('http://') || rawUrl.startsWith('https://'))) {
          var localUrl = escapeHtml(rawUrl);
          localValue = '<a href="' + localUrl + '" title="Open in browser">' + localUrl + '</a>';
        } else {
          localValue = '<span class="badge badge-muted">Starting...</span>';
        }
      }

      const remote = daemon.remote;
      let remoteValue = '<span class="badge badge-muted">Not enabled</span>';
      if (remote && remote.enabled) {
        if (remote.connected) {
          remoteValue = '<span class="badge badge-running">Connected</span>';
          if (remote.device_name) {
            remoteValue += ' <span style="color:var(--vscode-descriptionForeground)">' + escapeHtml(remote.device_name) + '</span>';
          }
        } else {
          remoteValue = '<span class="badge badge-disconnected">Disconnected</span>';
        }
      }

      el.innerHTML =
        '<div class="status-row"><span class="status-label">Uptime</span><span class="status-value">' + escapeHtml(formatUptime(daemon.uptime)) + '</span></div>' +
        '<div class="status-row"><span class="status-label">Sessions</span><span class="status-value">' + escapeHtml(String(daemon.sessions)) + '</span></div>' +
        '<div class="status-row"><span class="status-label">PID</span><span class="status-value">' + escapeHtml(String(daemon.pid)) + '</span></div>' +
        (backends ? '<div class="status-row"><span class="status-label">Backends</span><div class="backends">' + backends + '</div></div>' : '') +
        '<div class="status-row"><span class="status-label">Local Server</span><span class="status-value">' + localValue + '</span></div>' +
        '<div class="status-row"><span class="status-label">Remote</span><span class="status-value">' + remoteValue + '</span></div>';
    }

    function renderControl(setting) {
      var key = escapeHtml(setting.key);
      var val = setting.value;

      if (setting.type === 'bool') {
        return '<label class="switch"><input type="checkbox" data-key="' + key + '"' + (val ? ' checked' : '') + '><span class="switch-track"></span></label>';
      }
      if (setting.type === 'string' && setting.enum && setting.enum.length > 0) {
        var html = '<select class="setting-select" data-key="' + key + '">';
        for (var i = 0; i < setting.enum.length; i++) {
          var opt = escapeHtml(setting.enum[i]);
          html += '<option value="' + opt + '"' + (String(val) === setting.enum[i] ? ' selected' : '') + '>' + opt + '</option>';
        }
        return html + '</select>';
      }
      if (setting.type === 'number') {
        var attrs = 'data-key="' + key + '" value="' + escapeHtml(String(val != null ? val : '')) + '"';
        if (setting.min != null) attrs += ' min="' + escapeHtml(String(setting.min)) + '"';
        if (setting.max != null) attrs += ' max="' + escapeHtml(String(setting.max)) + '"';
        return '<input type="number" class="setting-input" ' + attrs + '>';
      }
      return '<input type="text" class="setting-input" data-key="' + key + '" value="' + escapeHtml(String(val != null ? val : '')) + '">';
    }

    function renderSettings(schema, connected) {
      var el = document.getElementById('settings-content');
      if (!connected) {
        el.innerHTML = '<div class="placeholder">Daemon not connected</div>';
        return;
      }
      if (!schema || !schema.groups || schema.groups.length === 0) {
        el.innerHTML = '<div class="placeholder">No settings available</div>';
        return;
      }

      var html = '';
      for (var g = 0; g < schema.groups.length; g++) {
        var group = schema.groups[g];
        html += '<div class="config-group">';
        html += '<div class="group-title">' + escapeHtml(group.name) + '</div>';
        if (group.description) {
          html += '<div class="group-desc">' + escapeHtml(group.description) + '</div>';
        }
        html += '<div class="group-settings">';
        for (var s = 0; s < group.settings.length; s++) {
          var setting = group.settings[s];
          html += '<div class="setting">';
          html += '<div class="setting-top">';
          html += '<span class="setting-label">' + escapeHtml(setting.name) + '</span>';
          html += '<span class="setting-control">' + renderControl(setting) + '</span>';
          html += '</div>';
          if (setting.description) {
            html += '<div class="setting-desc">' + escapeHtml(setting.description) + '</div>';
          }
          html += '</div>';
        }
        // Add password management row to the Local Server group
        if (group.key === 'local') {
          var exposeEnabled = false;
          var passwordSet = false;
          for (var p = 0; p < group.settings.length; p++) {
            if (group.settings[p].key === 'local.expose' && group.settings[p].value) exposeEnabled = true;
          }
          if (currentState.daemon && currentState.daemon.local) {
            passwordSet = !!currentState.daemon.local.password_set;
          }
          if (exposeEnabled) {
            html += '<div class="setting">';
            html += '<div class="setting-top">';
            html += '<span class="setting-label">Network Password</span>';
            html += '<span class="setting-control"><button class="setting-btn" id="change-password-btn">' + (passwordSet ? 'Change' : 'Set Password') + '</button></span>';
            html += '</div>';
            html += '<div class="setting-desc">Required for all web connections while expose is enabled.</div>';
            html += '</div>';
          }
        }

        html += '</div></div>';
      }

      el.innerHTML = html;
      bindControls(el);

      // Bind password button
      var pwBtn = document.getElementById('change-password-btn');
      if (pwBtn) {
        pwBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'changeWebPassword' });
        });
      }
    }

    function bindControls(container) {
      container.querySelectorAll('input[type="checkbox"][data-key]').forEach(function(cb) {
        cb.addEventListener('change', function() {
          vscode.postMessage({ type: 'configSet', key: cb.getAttribute('data-key'), value: cb.checked });
        });
      });
      container.querySelectorAll('select[data-key]').forEach(function(sel) {
        sel.addEventListener('change', function() {
          vscode.postMessage({ type: 'configSet', key: sel.getAttribute('data-key'), value: sel.value });
        });
      });
      container.querySelectorAll('input.setting-input[data-key]').forEach(function(inp) {
        var lastVal = inp.value;
        function commit() {
          if (inp.value !== lastVal) {
            lastVal = inp.value;
            var v = inp.type === 'number' ? (inp.value === '' ? 0 : Number(inp.value)) : inp.value;
            vscode.postMessage({ type: 'configSet', key: inp.getAttribute('data-key'), value: v });
          }
        }
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') inp.blur(); });
      });
    }

    function updateControl(key, value) {
      var ek = CSS.escape(key);
      var cb = document.querySelector('input[type="checkbox"][data-key="' + ek + '"]');
      if (cb) { cb.checked = !!value; return; }
      var sel = document.querySelector('select[data-key="' + ek + '"]');
      if (sel) { sel.value = String(value); return; }
      var inp = document.querySelector('input[data-key="' + ek + '"]');
      if (inp) { inp.value = value != null ? String(value) : ''; return; }
    }

    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg.type === 'status') {
        currentState = msg;
        renderDaemon(msg.daemon, msg.connected);
        renderSettings(msg.schema, msg.connected);
      } else if (msg.type === 'schemaError') {
        document.getElementById('settings-content').innerHTML =
          '<div class="placeholder">Failed to load settings: ' + escapeHtml(msg.error) + '</div>';
      } else if (msg.type === 'configChanged') {
        if (currentState.schema) {
          for (var g = 0; g < currentState.schema.groups.length; g++) {
            var settings = currentState.schema.groups[g].settings;
            for (var s = 0; s < settings.length; s++) {
              if (settings[s].key === msg.key) { settings[s].value = msg.value; break; }
            }
          }
        }
        updateControl(msg.key, msg.value);
      }
    });

    document.getElementById('open-logs-btn').addEventListener('click', function() {
      vscode.postMessage({ type: 'openLogs' });
    });

    vscode.postMessage({ type: 'getStatus' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}
