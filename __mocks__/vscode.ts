// Minimal vscode mock for unit tests.
// Only the APIs used by tested modules need to be present here.
export const window = {
  showWarningMessage: () => undefined,
  showErrorMessage: () => Promise.resolve(undefined),
  showInformationMessage: () => undefined,
  createTerminal: () => undefined,
  terminals: [] as unknown[],
};

export const workspace = {
  workspaceFolders: undefined,
  getConfiguration: () => ({
    get: (_key: string, defaultValue?: unknown) => defaultValue ?? "",
  }),
};

export const commands = {
  executeCommand: () => undefined,
};

export const env = {
  openExternal: () => undefined,
};

export class TerminalProfile {
  constructor(public options: unknown) {}
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label: string | undefined;
  collapsibleState: TreeItemCollapsibleState | undefined;
  contextValue: string | undefined;
  iconPath: unknown;
  id: string | undefined;
  tooltip: unknown;
  description: string | undefined;

  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class ThemeIcon {
  constructor(public id: string) {}
}

export class MarkdownString {
  isTrusted: boolean | undefined;
  constructor(public value: string) {}
}

export const Uri = {
  file: (p: string) => ({ fsPath: p, scheme: "file" }),
  parse: (s: string) => ({ toString: () => s }),
};

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };

  fire(data: T): void {
    for (const l of this.listeners) l(data);
  }

  dispose(): void {
    this.listeners = [];
  }
}
