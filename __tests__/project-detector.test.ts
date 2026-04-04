import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findCarryonConfig } from "../src/project-detector";

describe("findCarryonConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carryon-pd-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  test("returns null when no .carryon.json exists", () => {
    const result = findCarryonConfig(tmpDir);
    expect(result).toBeNull();
  });

  test("returns parsed config when .carryon.json exists", () => {
    const config = {
      version: 1,
      terminals: [
        { name: "dev-server", command: "npm run dev" },
        { name: "tests", command: "npm test" },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, ".carryon.json"), JSON.stringify(config));

    const result = findCarryonConfig(tmpDir);
    expect(result).toEqual(config);
  });

  test("returns null for invalid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, ".carryon.json"), "not json{");
    const result = findCarryonConfig(tmpDir);
    expect(result).toBeNull();
  });

  test("returns null for config with wrong version", () => {
    fs.writeFileSync(path.join(tmpDir, ".carryon.json"), JSON.stringify({ version: 99, terminals: [] }));
    const result = findCarryonConfig(tmpDir);
    expect(result).toBeNull();
  });

  test("returns valid config with split groups", () => {
    const config = {
      version: 1,
      terminals: [
        { name: "server", command: "npm start" },
        [
          { name: "left-pane", command: "npm run watch" },
          { name: "right-pane", command: "npm test" },
        ],
      ],
    };
    fs.writeFileSync(path.join(tmpDir, ".carryon.json"), JSON.stringify(config));

    const result = findCarryonConfig(tmpDir);
    expect(result).toEqual(config);
  });

  test("returns valid config with color fields", () => {
    const config = {
      version: 1,
      terminals: [
        { name: "server", command: "npm start", color: "green" },
        { name: "tests", command: "npm test", color: "brightRed" },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, ".carryon.json"), JSON.stringify(config));

    const result = findCarryonConfig(tmpDir);
    expect(result).toEqual(config);
  });

  test("returns null for config with empty split group", () => {
    const config = {
      version: 1,
      terminals: [
        { name: "server" },
        [],
      ],
    };
    fs.writeFileSync(path.join(tmpDir, ".carryon.json"), JSON.stringify(config));

    const result = findCarryonConfig(tmpDir);
    expect(result).toBeNull();
  });

  test("returns null for config with split group missing name", () => {
    const config = {
      version: 1,
      terminals: [
        [
          { name: "valid-pane" },
          { command: "npm test" },
        ],
      ],
    };
    fs.writeFileSync(path.join(tmpDir, ".carryon.json"), JSON.stringify(config));

    const result = findCarryonConfig(tmpDir);
    expect(result).toBeNull();
  });
});
