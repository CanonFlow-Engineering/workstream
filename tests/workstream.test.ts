import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkstreamStore, type Actor } from "../src/index.js";

const human: Actor = { kind: "human", id: "owner" };
const architect: Actor = { kind: "architect-agent", id: "builder" };
const tester: Actor = { kind: "independent-tester", id: "tester" };
const judge: Actor = { kind: "llm-judge", id: "judge" };

const withTemporaryDirectory = (action: (directory: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), "workstream-test-"));
  try {
    action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const fixedClock = (): (() => string) => {
  let index = 0;
  return () => `2026-08-17T00:00:${String(index++).padStart(2, "0")}.000Z`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const independentlyCanonicalJson = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(independentlyCanonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map(
        (key) =>
          `${JSON.stringify(key)}:${independentlyCanonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("Expected a JSON value.");
};

const independentlySha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const startClaimedWork = (
  root: string,
): { readonly store: WorkstreamStore; readonly workId: string } => {
  const store = new WorkstreamStore(root, fixedClock());
  store.initialize(human);
  store.createProject(human, "project", "Project", "A local project.");
  store.createWork(human, "work-1", "project", "Build the first slice.");
  store.issueMandate(
    human,
    "work-1",
    new TextEncoder().encode("# Mandate\n\nBuild M0.\n"),
  );
  store.claimWork(architect, "work-1");
  return { store, workId: "work-1" };
};

test("persists the SQLite ledger and reaches a human gate", () => {
  withTemporaryDirectory((root) => {
    const started = startClaimedWork(root);
    const implementation = started.store.attachEvidence(
      architect,
      started.workId,
      "implementation",
      new TextEncoder().encode("implementation"),
    );
    const testEvidence = started.store.attachEvidence(
      tester,
      started.workId,
      "test",
      new TextEncoder().encode("test receipt"),
    );
    started.store.recordTest(
      tester,
      started.workId,
      "PASS",
      testEvidence.sha256,
    );
    const judgeEvidence = started.store.attachEvidence(
      judge,
      started.workId,
      "judge",
      new TextEncoder().encode("judge receipt"),
    );
    started.store.recordJudge(
      judge,
      started.workId,
      "Pass",
      judgeEvidence.sha256,
    );
    const accepted = started.store.decideGate(human, started.workId, "accept");
    assert.equal(accepted.status, "accepted");
    assert.equal(implementation.bytes, 14);
    assert.equal(started.store.verify().valid, true);
    const eventCount = started.store.events().length;
    started.store.close();

    const restarted = new WorkstreamStore(root);
    assert.equal(restarted.work(started.workId)?.status, "accepted");
    assert.equal(restarted.events().length, eventCount);
    assert.equal(restarted.verify().valid, true);
    restarted.close();
  });
});

test("denied commands and rolled-back transactions do not append events", () => {
  withTemporaryDirectory((root) => {
    const started = startClaimedWork(root);
    const beforeDenied = started.store.events().length;
    assert.throws(
      () => started.store.claimWork(human, started.workId),
      /Only an architect agent/,
    );
    assert.equal(started.store.events().length, beforeDenied);
    assert.throws(
      () =>
        started.store.createProject(
          human,
          "project",
          "Duplicate",
          "Duplicate project.",
        ),
      /UNIQUE/,
    );
    assert.equal(started.store.events().length, beforeDenied);
    assert.equal(started.store.verify().valid, true);
    started.store.close();
  });
});

test("cannot claim blocked work or self-approve", () => {
  withTemporaryDirectory((root) => {
    const started = startClaimedWork(root);
    const testEvidence = started.store.attachEvidence(
      tester,
      started.workId,
      "test",
      new TextEncoder().encode("failed test"),
    );
    started.store.recordTest(
      tester,
      started.workId,
      "FAIL",
      testEvidence.sha256,
    );
    assert.equal(started.store.work(started.workId)?.status, "blocked");
    assert.throws(
      () => started.store.claimWork(architect, started.workId),
      /Blocked work/,
    );
    assert.throws(
      () => started.store.decideGate(architect, started.workId, "accept"),
      /requires a human actor/,
    );
    assert.equal(started.store.verify().valid, true);
    started.store.close();
  });
});

test("detects changed content-addressed evidence", () => {
  withTemporaryDirectory((root) => {
    const started = startClaimedWork(root);
    const evidence = started.store.attachEvidence(
      architect,
      started.workId,
      "implementation",
      new TextEncoder().encode("evidence"),
    );
    const path = join(
      root,
      ".workstream",
      "evidence",
      "sha256",
      evidence.sha256,
    );
    writeFileSync(path, "changed");
    const verification = started.store.verify();
    assert.equal(verification.valid, false);
    assert.match(verification.errors.join("\n"), /does not match/);
    started.store.close();
  });
});

test("exports and imports an equivalent portable evidence bundle", () => {
  withTemporaryDirectory((root) => {
    const source = join(root, "source");
    const started = startClaimedWork(source);
    started.store.attachEvidence(
      architect,
      started.workId,
      "implementation",
      new TextEncoder().encode("implementation"),
    );
    const bundle = join(root, "bundle");
    const manifest = started.store.exportBundle(bundle);
    const sourceEvents = started.store.events();
    started.store.close();

    const importedRoot = join(root, "imported");
    const imported = new WorkstreamStore(importedRoot);
    const importedManifest = imported.importBundle(bundle);
    assert.deepEqual(importedManifest, manifest);
    assert.deepEqual(imported.events(), sourceEvents);
    assert.equal(imported.work(started.workId)?.status, "claimed");
    assert.equal(imported.verify().valid, true);
    imported.close();
  });
});

test("exports independently reproducible event hashes", () => {
  withTemporaryDirectory((root) => {
    const started = startClaimedWork(root);
    const bundle = join(root, "bundle");
    const manifest = started.store.exportBundle(bundle);
    started.store.close();
    assert.equal(
      manifest.eventsSha256,
      createHash("sha256")
        .update(readFileSync(join(bundle, "events.ndjson")))
        .digest("hex"),
    );
    const lines = readFileSync(join(bundle, "events.ndjson"), "utf8")
      .trim()
      .split("\n");
    for (const line of lines) {
      const event: unknown = JSON.parse(line);
      assert.equal(isRecord(event), true);
      if (!isRecord(event)) {
        throw new Error("Exported event must be an object.");
      }
      const material = {
        actor: event.actor,
        payload: event.payload,
        previousSha256: event.previousSha256,
        sequence: event.sequence,
        timestamp: event.timestamp,
        type: event.type,
      };
      assert.equal(
        event.sha256,
        independentlySha256(independentlyCanonicalJson(material)),
      );
    }
  });
});

test("uses the Markdown help source and reports an invalid ledger with status 1", () => {
  withTemporaryDirectory((root) => {
    const help = spawnSync(
      "node_modules/node/bin/node",
      ["--import", "tsx", "src/cli.ts", "--help"],
      { encoding: "utf8" },
    );
    assert.equal(help.status, 0);
    assert.equal(help.stdout, readFileSync("src/cli-help.md", "utf8"));

    const started = startClaimedWork(root);
    const evidence = started.store.attachEvidence(
      architect,
      started.workId,
      "implementation",
      new TextEncoder().encode("evidence"),
    );
    writeFileSync(
      join(root, ".workstream", "evidence", "sha256", evidence.sha256),
      "changed",
    );
    started.store.close();

    const verification = spawnSync(
      "node_modules/node/bin/node",
      ["--import", "tsx", "src/cli.ts", "verify", root],
      { encoding: "utf8" },
    );
    assert.equal(verification.status, 1);
    assert.match(verification.stdout, /"valid":false/);
  });
});

test("rejects a changed portable event before import", () => {
  withTemporaryDirectory((root) => {
    const source = join(root, "source");
    const started = startClaimedWork(source);
    const bundle = join(root, "bundle");
    started.store.exportBundle(bundle);
    started.store.close();
    const eventsPath = join(bundle, "events.ndjson");
    writeFileSync(eventsPath, `${readFileSync(eventsPath, "utf8")}changed`);
    const target = new WorkstreamStore(join(root, "target"));
    assert.throws(() => target.importBundle(bundle), /manifest digest/);
    assert.equal(target.events().length, 0);
    target.close();
  });
});
