import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "__mocks__/vscode.ts"),
    },
  },
  test: {
    globals: true,
  },
});
