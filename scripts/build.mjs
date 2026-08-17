import { cpSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

rmSync("dist", { recursive: true, force: true });
const compiled = spawnSync(
  "./node_modules/.bin/tsc",
  ["-p", "tsconfig.build.json"],
  {
    stdio: "inherit",
  },
);
if (compiled.status !== 0) {
  process.exitCode = compiled.status ?? 2;
} else {
  mkdirSync("dist", { recursive: true });
  cpSync("src/cli-help.md", "dist/cli-help.md");
  cpSync("src/ui", "dist/ui", { recursive: true });
}
