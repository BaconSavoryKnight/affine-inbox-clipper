import { build } from "esbuild";
import { cpSync, rmSync, mkdirSync } from "node:fs";
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });
const common = { bundle: true, format: "iife", target: "firefox115", minify: false, legalComments: "inline", logLevel: "info" };
await build({ ...common, entryPoints: { background: "src/background.js", content: "src/content/entry.js", popup: "src/popup.js", options: "src/options.js" }, outdir: "dist" });
