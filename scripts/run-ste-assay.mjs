import { spawnSync } from "node:child_process";

if (process.version !== "v20.20.2") {
  throw new Error(
    `STEAssay requires the pinned Node v20.20.2 runner; received ${process.version}.`,
  );
}
const result = spawnSync(
  process.execPath,
  ["node_modules/ste-assay/dist/src/cli.js", "verify", "."],
  {
    stdio: "inherit",
    env: { ...process.env, STE_ASSAY_CLOCK: "2026-08-17T00:00:00.000Z" },
  },
);
process.exitCode = result.status ?? 2;
