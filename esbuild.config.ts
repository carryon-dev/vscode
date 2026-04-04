import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const buildOptions: esbuild.BuildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  outdir: "dist",
  format: "cjs",
  sourcemap: true,
  external: ["vscode"],
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build(buildOptions);
    console.log("Build complete.");
  }
})();
