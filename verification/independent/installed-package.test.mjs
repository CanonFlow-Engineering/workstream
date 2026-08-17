import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { env } from "node:process";
import test from "node:test";

const tarball = env.WORKSTREAM_TARBALL;
const node24 = env.WORKSTREAM_NODE;

assert.ok(tarball, "WORKSTREAM_TARBALL must name the candidate npm tarball.");
assert.ok(node24, "WORKSTREAM_NODE must name the pinned Node 24 executable.");
assert.ok(existsSync(tarball), `Candidate tarball is absent: ${tarball}`);
assert.ok(existsSync(node24), `Pinned Node executable is absent: ${node24}`);

const independentSha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
};

const temporaryDirectory = (prefix) => mkdtempSync(join(tmpdir(), prefix));

const commandEnvironment = (extra = {}) => ({
  ...env,
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "*",
  npm_config_offline: "true",
  PATH: `${dirname(node24)}:${env.PATH}`,
  ...extra,
});

const execute = (file, arguments_, options = {}) => {
  const result = spawnSync(file, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: commandEnvironment(options.env),
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
};

const assertSuccess = (result, description) => {
  assert.equal(
    result.status,
    0,
    `${description} failed (status ${String(result.status)}): ${result.stderr}`,
  );
  return result;
};

const assertFailure = (result, description) => {
  assert.notEqual(
    result.status,
    0,
    `${description} unexpectedly succeeded: ${result.stdout}`,
  );
  return result;
};

const parseJson = (result, description) =>
  JSON.parse(assertSuccess(result, description).stdout);

const installCandidate = () => {
  const consumer = temporaryDirectory("workstream-installed-consumer-");
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "independent-workstream-consumer", private: true })}\n`,
  );
  assertSuccess(
    execute(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      { cwd: consumer },
    ),
    "offline installation of the candidate tarball",
  );
  const cli = join(consumer, "node_modules", ".bin", "workstream");
  assert.ok(
    existsSync(cli),
    "installed tarball did not expose the workstream CLI",
  );
  return { cli, consumer };
};

const cli = (installation, arguments_) =>
  execute(installation.cli, arguments_, { cwd: installation.consumer });

const cliJson = (installation, arguments_, description) =>
  parseJson(cli(installation, arguments_), description);

const activity = (installation, root) =>
  cliJson(installation, ["activity", "--root", root], "read public activity")
    .activity;

const evidenceSha = (response) => response.evidence.sha256;

const createClaimedWork = (installation, label) => {
  const root = join(installation.consumer, `${label}-state`);
  const mandate = join(installation.consumer, `${label}-mandate.md`);
  const implementation = join(
    installation.consumer,
    `${label}-implementation.json`,
  );
  writeFileSync(mandate, "# Independent mandate\n\nRecord package behavior.\n");
  writeFileSync(implementation, '{"result":"implemented"}\n');
  cliJson(
    installation,
    ["init", root, "--actor", "human:owner"],
    "initialize state",
  );
  cliJson(
    installation,
    [
      "project",
      "create",
      "project",
      "Independent project",
      "Black-box package verification",
      "--root",
      root,
      "--actor",
      "human:owner",
    ],
    "create project",
  );
  cliJson(
    installation,
    [
      "work",
      "create",
      "project",
      "work",
      "Independent work",
      "--root",
      root,
      "--actor",
      "human:owner",
    ],
    "create work",
  );
  cliJson(
    installation,
    [
      "mandate",
      "issue",
      "work",
      mandate,
      "--root",
      root,
      "--actor",
      "human:owner",
    ],
    "issue mandate",
  );
  cliJson(
    installation,
    [
      "work",
      "claim",
      "work",
      "--root",
      root,
      "--actor",
      "architect-agent:builder",
    ],
    "claim ready work",
  );
  const implementationEvidence = cliJson(
    installation,
    [
      "evidence",
      "attach",
      "work",
      "implementation",
      implementation,
      "--root",
      root,
      "--actor",
      "architect-agent:builder",
    ],
    "attach implementation evidence",
  );
  return {
    implementation,
    implementationEvidence: evidenceSha(implementationEvidence),
    root,
  };
};

const recordTestAndJudge = (installation, root) => {
  const testReceipt = join(
    installation.consumer,
    "independent-test-receipt.json",
  );
  const judgeReceipt = join(
    installation.consumer,
    "independent-judge-receipt.json",
  );
  writeFileSync(testReceipt, '{"verdict":"PASS"}\n');
  writeFileSync(judgeReceipt, '{"verdict":"Pass"}\n');
  const testEvidence = evidenceSha(
    cliJson(
      installation,
      [
        "evidence",
        "attach",
        "work",
        "independent-test-receipt",
        testReceipt,
        "--root",
        root,
        "--actor",
        "independent-tester:tester",
      ],
      "attach tester evidence",
    ),
  );
  cliJson(
    installation,
    [
      "test",
      "record",
      "work",
      "PASS",
      testEvidence,
      "--root",
      root,
      "--actor",
      "independent-tester:tester",
    ],
    "record tester verdict",
  );
  const judgeEvidence = evidenceSha(
    cliJson(
      installation,
      [
        "evidence",
        "attach",
        "work",
        "judge-receipt",
        judgeReceipt,
        "--root",
        root,
        "--actor",
        "llm-judge:judge",
      ],
      "attach judge evidence",
    ),
  );
  cliJson(
    installation,
    [
      "judge",
      "record",
      "work",
      "Pass",
      judgeEvidence,
      "--root",
      root,
      "--actor",
      "llm-judge:judge",
    ],
    "record judge verdict",
  );
};

const copyBundle = (source, label) => {
  const target = join(dirname(source), `${basename(source)}-${label}`);
  cpSync(source, target, { recursive: true });
  return target;
};

const importMustReject = (installation, bundle, label) => {
  const target = temporaryDirectory(`workstream-rejected-${label}-`);
  assertFailure(
    cli(installation, ["import", bundle, target]),
    `reject ${label} bundle`,
  );
};

test("installed package exposes only documented public exports and works offline", () => {
  const installation = installCandidate();
  try {
    const exportProbe = join(installation.consumer, "public-exports.mjs");
    writeFileSync(
      exportProbe,
      "import * as workstream from '@canonflow/workstream';\n" +
        "console.log(JSON.stringify(Object.keys(workstream).sort()));\n",
    );
    const exports_ = JSON.parse(
      assertSuccess(
        execute(node24, [exportProbe], { cwd: installation.consumer }),
        "import public package export",
      ).stdout,
    );
    assert.deepEqual(exports_, [
      "GitHubDryRun",
      "WorkstreamStore",
      "canonicalJson",
      "parseActor",
      "sha256",
    ]);
    assert.match(
      assertSuccess(cli(installation, ["--help"]), "offline CLI help").stdout,
      /local-first evidence ledger/,
    );
  } finally {
    rmSync(installation.consumer, { force: true, recursive: true });
  }
});

test("installed tarball persists state and prevents denied or rolled-back mutations", () => {
  const installation = installCandidate();
  try {
    const { root } = createClaimedWork(installation, "persistence");
    const eventsBeforeDenial = activity(installation, root);
    assert.equal(
      eventsBeforeDenial.length,
      6,
      "initial lifecycle has six append-only events",
    );
    assertFailure(
      cli(installation, [
        "gate",
        "decide",
        "work",
        "accept",
        "--root",
        root,
        "--actor",
        "architect-agent:builder",
      ]),
      "deny non-human gate decision",
    );
    assert.deepEqual(
      activity(installation, root),
      eventsBeforeDenial,
      "denied command must not append",
    );
    assertFailure(
      cli(installation, [
        "project",
        "create",
        "project",
        "Duplicate project",
        "must roll back",
        "--root",
        root,
        "--actor",
        "human:owner",
      ]),
      "reject duplicate project transaction",
    );
    assert.deepEqual(
      activity(installation, root),
      eventsBeforeDenial,
      "rollback must leave ledger unchanged",
    );
    assert.equal(
      cliJson(
        installation,
        ["work", "show", "work", "--root", root],
        "restart and read work",
      ).work.status,
      "claimed",
    );

    const blocked = createClaimedWork(installation, "blocked");
    recordTestAndJudge(installation, blocked.root);
    cliJson(
      installation,
      [
        "gate",
        "decide",
        "work",
        "stop",
        "--root",
        blocked.root,
        "--actor",
        "human:owner",
      ],
      "stop work",
    );
    assertFailure(
      cli(installation, [
        "work",
        "claim",
        "work",
        "--root",
        blocked.root,
        "--actor",
        "architect-agent:another",
      ]),
      "deny agent claim of stopped work",
    );
  } finally {
    rmSync(installation.consumer, { force: true, recursive: true });
  }
});

test("installed tarball independently verifies ordered event and manifest SHA-256 chains", () => {
  const installation = installCandidate();
  try {
    const { root } = createClaimedWork(installation, "chain");
    const bundle = join(installation.consumer, "chain-bundle");
    cliJson(
      installation,
      ["export", bundle, "--root", root],
      "export chain bundle",
    );
    const eventsBytes = readFileSync(join(bundle, "events.ndjson"));
    const events = eventsBytes
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    let previousSha256 = "0".repeat(64);
    events.forEach((event, index) => {
      assert.equal(event.sequence, index + 1, "event sequence is contiguous");
      assert.equal(
        event.previousSha256,
        previousSha256,
        "event points to prior hash",
      );
      const hashInput = {
        actor: event.actor,
        payload: event.payload,
        previousSha256: event.previousSha256,
        sequence: event.sequence,
        timestamp: event.timestamp,
        type: event.type,
      };
      assert.equal(
        event.sha256,
        independentSha256(Buffer.from(canonicalJson(hashInput))),
        "event SHA-256 is independently reproducible",
      );
      previousSha256 = event.sha256;
    });
    const manifest = JSON.parse(
      readFileSync(join(bundle, "manifest.json"), "utf8"),
    );
    assert.equal(
      manifest.eventsSha256,
      independentSha256(eventsBytes),
      "manifest binds literal events.ndjson bytes, including its final newline",
    );
    assertSuccess(
      cli(installation, ["verify", root]),
      "verify independent event-chain state",
    );
  } finally {
    rmSync(installation.consumer, { force: true, recursive: true });
  }
});

test("installed tarball content-addresses evidence and reports mutation as a failed verification", () => {
  const installation = installCandidate();
  try {
    const { implementation, implementationEvidence, root } = createClaimedWork(
      installation,
      "evidence",
    );
    const bytes = readFileSync(implementation);
    assert.equal(implementationEvidence, independentSha256(bytes));
    const evidencePath = join(
      root,
      ".workstream",
      "evidence",
      "sha256",
      implementationEvidence,
    );
    assert.deepEqual(readFileSync(evidencePath), bytes);
    writeFileSync(evidencePath, '{"result":"mutated"}\n');
    const invalidVerification = cli(installation, ["verify", root]);
    assert.equal(
      invalidVerification.status,
      1,
      "invalid verification must exit with status 1",
    );
    const verification = JSON.parse(invalidVerification.stdout).verification;
    assert.equal(verification.valid, false);
    assert.match(
      verification.errors.join("\n"),
      /hash does not match its content/,
    );
  } finally {
    rmSync(installation.consumer, { force: true, recursive: true });
  }
});

test("installed tarball round-trips exports and rejects every tested portable-bundle tamper", () => {
  const installation = installCandidate();
  try {
    const { root } = createClaimedWork(installation, "portable");
    recordTestAndJudge(installation, root);
    const bundle = join(installation.consumer, "portable-bundle");
    cliJson(
      installation,
      ["export", bundle, "--root", root],
      "export portable bundle",
    );
    const imported = temporaryDirectory("workstream-imported-");
    cliJson(
      installation,
      ["import", bundle, imported],
      "import portable bundle",
    );
    assertSuccess(
      cli(installation, ["verify", root]),
      "verify exported source state",
    );
    assertSuccess(
      cli(installation, ["verify", imported]),
      "verify imported state",
    );
    assert.deepEqual(
      activity(installation, imported),
      activity(installation, root),
    );

    const eventBundle = copyBundle(bundle, "event-tamper");
    const eventPath = join(eventBundle, "events.ndjson");
    writeFileSync(
      eventPath,
      readFileSync(eventPath, "utf8").replace(
        "Independent work",
        "Changed work",
      ),
    );
    importMustReject(installation, eventBundle, "event");

    const manifestBundle = copyBundle(bundle, "manifest-tamper");
    const manifestPath = join(manifestBundle, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.eventsSha256 = "f".repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    importMustReject(installation, manifestBundle, "manifest");

    const digestFirstBundle = copyBundle(bundle, "digest-before-parse");
    writeFileSync(join(digestFirstBundle, "events.ndjson"), "not JSON\n");
    const digestFirstTarget = temporaryDirectory(
      "workstream-rejected-digest-before-parse-",
    );
    const digestFirstResult = cli(installation, [
      "import",
      digestFirstBundle,
      digestFirstTarget,
    ]);
    assertFailure(
      digestFirstResult,
      "reject event digest mismatch before parsing event text",
    );
    assert.match(
      digestFirstResult.stderr,
      /Bundle events do not match the manifest digest/,
    );
    assert.doesNotMatch(digestFirstResult.stderr, /JSON/);

    const artifactBundle = copyBundle(bundle, "artifact-tamper");
    const artifactManifest = JSON.parse(
      readFileSync(join(artifactBundle, "manifest.json"), "utf8"),
    );
    writeFileSync(
      join(artifactBundle, artifactManifest.evidence[0].path),
      "changed evidence bytes\n",
    );
    importMustReject(installation, artifactBundle, "artifact");

    const schemaBundle = copyBundle(bundle, "schema-tamper");
    const schemaPath = join(schemaBundle, "manifest.json");
    const schemaManifest = JSON.parse(readFileSync(schemaPath, "utf8"));
    schemaManifest.schemaVersion = "workstream-bundle/999";
    writeFileSync(schemaPath, `${JSON.stringify(schemaManifest)}\n`);
    importMustReject(installation, schemaBundle, "schema");

    const pathBundle = copyBundle(bundle, "path-tamper");
    const pathPath = join(pathBundle, "manifest.json");
    const pathManifest = JSON.parse(readFileSync(pathPath, "utf8"));
    pathManifest.evidence[0].path = "../../outside";
    writeFileSync(pathPath, `${JSON.stringify(pathManifest)}\n`);
    importMustReject(installation, pathBundle, "unsafe archive path");
  } finally {
    rmSync(installation.consumer, { force: true, recursive: true });
  }
});
