import { spawnSync } from "node:child_process";

if (process.version !== "v20.20.2") {
  throw new Error(
    `TypeScriptAssay requires the pinned Node v20.20.2 runner; received ${process.version}.`,
  );
}
const result = spawnSync(
  process.execPath,
  [
    "node_modules/typescript-assay/dist/src/cli.js",
    "verify",
    ".",
    "--json",
    "artifacts/typescript-assay/receipt.json",
    "--sarif",
    "artifacts/typescript-assay/report.sarif",
    "--clock",
    "2026-08-17T00:00:00.000Z",
  ],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 2;
