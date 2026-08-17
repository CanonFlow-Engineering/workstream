import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkstreamStore, type Actor } from "../src/index.js";
import { createLocalServer } from "../src/server.js";

const human: Actor = { kind: "human", id: "owner" };
const architect: Actor = { kind: "architect-agent", id: "builder" };
const tester: Actor = { kind: "independent-tester", id: "tester" };
const judge: Actor = { kind: "llm-judge", id: "judge" };
const skeptic: Actor = { kind: "skeptic-agent", id: "skeptic" };

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

const jsonObject = async (
  response: Response,
): Promise<Record<string, unknown>> => {
  const value: unknown = await response.json();
  assert.equal(isRecord(value), true);
  if (!isRecord(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value;
};

const requiredObject = (
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> => {
  const value = record[field];
  assert.equal(isRecord(value), true);
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
};

const requiredText = (
  record: Record<string, unknown>,
  field: string,
): string => {
  const value = record[field];
  assert.equal(typeof value, "string");
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
};

const closeServer = (
  server: ReturnType<typeof createLocalServer>,
): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const post = async (
  base: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${base}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 200);
  return jsonObject(response);
};

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

const compassInput = (evidenceHash: string, owner = "owner") => ({
  nonGoals: [
    {
      evidenceHash,
      id: "no-remote-actions",
      text: "Do not create remote effects.",
    },
  ],
  owner,
  principles: [
    {
      evidenceHash,
      id: "local-evidence",
      text: "Prefer local evidence before remote synchronization.",
    },
  ],
  title: "Local-first direction",
});

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

test("serves a loopback-only local browser work loop without GitHub synchronization", async () => {
  const root = mkdtempSync(join(tmpdir(), "workstream-server-test-"));
  const server = createLocalServer(root);
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    if (address === null || typeof address === "string") {
      throw new Error("Expected a loopback server address.");
    }
    assert.equal(address.address, "127.0.0.1");
    const port = address.port;
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const healthBody = await jsonObject(health);
    assert.equal(healthBody.localOnly, true);
    assert.equal(healthBody.githubIntegration, "dry-run-only");
    assert.equal(healthBody.actorIdsAreAuthentication, false);
    assert.equal(healthBody.humanGate, "trusted-local-workflow-control");
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Human approval queue/);
    assert.match(
      await (await fetch(base)).text(),
      /Actor IDs are ledger labels/,
    );

    await post(base, "/api/initialize", { actor: "human:owner" });
    await post(base, "/api/projects", {
      actor: "human:owner",
      description: "A local browser project.",
      id: "local-ui",
      name: "Local UI",
    });
    await post(base, "/api/work", {
      actor: "human:owner",
      id: "work-1",
      projectId: "local-ui",
      title: "Show the human gate",
    });
    await post(base, "/api/work/work-1/mandate", {
      actor: "human:owner",
      content: "# Mandate\n\nUse the local browser only.\n",
    });
    await post(base, "/api/work/work-1/claim", {
      actor: "architect-agent:builder",
    });
    await post(base, "/api/work/work-1/handoff", {
      actor: "architect-agent:builder",
      recipient: "independent-tester:tester",
      summary: "The local implementation is ready for test.",
    });
    const testAttachment = await post(base, "/api/work/work-1/evidence", {
      actor: "independent-tester:tester",
      content: "Independent local test result.",
      kind: "test",
    });
    const testHash = requiredText(
      requiredObject(testAttachment, "evidence"),
      "sha256",
    );
    await post(base, "/api/work/work-1/test", {
      actor: "independent-tester:tester",
      evidenceHash: testHash,
      verdict: "PASS",
    });
    const judgeAttachment = await post(base, "/api/work/work-1/evidence", {
      actor: "llm-judge:judge",
      content: "Judge reads immutable local evidence.",
      kind: "judge",
    });
    const judgeHash = requiredText(
      requiredObject(judgeAttachment, "evidence"),
      "sha256",
    );
    await post(base, "/api/work/work-1/judge", {
      actor: "llm-judge:judge",
      evidenceHash: judgeHash,
      verdict: "Pass",
    });
    const detail = await fetch(`${base}/api/work/work-1`);
    assert.equal(detail.status, 200);
    const detailBody = await jsonObject(detail);
    assert.equal(requiredObject(detailBody, "work").status, "awaiting-gate");
    const evidence = detailBody.evidence;
    assert.equal(Array.isArray(evidence), true);
    if (!Array.isArray(evidence)) {
      throw new Error("Expected work evidence.");
    }
    assert.equal(evidence.length, 3);
    const state = await fetch(`${base}/api/state`);
    const stateBody = await jsonObject(state);
    assert.equal(stateBody.initialized, true);
    await post(base, "/api/work/work-1/gate", {
      actor: "human:owner",
      decision: "accept",
    });
    const finalDetail = await jsonObject(
      await fetch(`${base}/api/work/work-1`),
    );
    assert.equal(requiredObject(finalDetail, "work").status, "accepted");
  } finally {
    await closeServer(server);
    rmSync(root, { recursive: true, force: true });
  }
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

test("records owner-approved and superseded Compass versions with source evidence", () => {
  withTemporaryDirectory((root) => {
    const store = new WorkstreamStore(root, fixedClock());
    store.initialize(human);
    store.createProject(human, "compass", "Compass", "Direction records.");
    const source = store.attachProjectEvidence(
      human,
      "compass",
      "human-decision",
      new TextEncoder().encode("Use local evidence."),
    );
    assert.throws(
      () =>
        store.createCompass(
          human,
          "unlinked",
          "compass",
          compassInput("f".repeat(64)),
        ),
      /not registered/,
    );
    const first = store.createCompass(
      human,
      "compass-v1",
      "compass",
      compassInput(source.sha256),
    );
    assert.equal(first.status, "draft");
    assert.throws(
      () => store.approveCompass({ kind: "human", id: "other" }, first.id),
      /named human owner/,
    );
    assert.equal(store.approveCompass(human, first.id).status, "approved");
    const replacement = store.createCompass(
      human,
      "compass-v2",
      "compass",
      compassInput(source.sha256),
    );
    assert.equal(
      store.supersedeCompass(human, first.id, replacement.id).status,
      "approved",
    );
    assert.equal(store.compass(first.id)?.status, "superseded");
    assert.equal(store.compass(first.id)?.supersededBy, replacement.id);
    assert.equal(store.verify().valid, true);
    store.close();
  });
});

test("exports approved VISION.md and imports it as a source-evidenced draft", () => {
  withTemporaryDirectory((root) => {
    const sourceRoot = join(root, "source");
    const store = new WorkstreamStore(sourceRoot, fixedClock());
    store.initialize(human);
    store.createProject(human, "compass", "Compass", "Direction records.");
    const source = store.attachProjectEvidence(
      human,
      "compass",
      "human-decision",
      new TextEncoder().encode("Human decision."),
    );
    const compass = store.createCompass(
      human,
      "compass-v1",
      "compass",
      compassInput(source.sha256),
    );
    store.approveCompass(human, compass.id);
    const vision = join(root, "VISION.md");
    const exported = store.exportVision("compass", vision);
    assert.match(exported, /workstream-vision\/0\.1/);
    assert.match(readFileSync(vision, "utf8"), /## Principles/);
    store.close();

    const importedRoot = join(root, "imported");
    const imported = new WorkstreamStore(importedRoot, fixedClock());
    imported.initialize(human);
    imported.createProject(human, "compass", "Compass", "Direction records.");
    const draft = imported.importVision(
      human,
      "compass-import",
      "compass",
      vision,
    );
    assert.equal(draft.status, "draft");
    assert.notEqual(draft.sourceVisionEvidenceHash, null);
    assert.equal(
      draft.principles[0]?.evidenceHash,
      draft.sourceVisionEvidenceHash,
    );
    assert.equal(imported.verify().valid, true);
    imported.close();
  });
});

test("records expiring assumptions, immutable decisions, and milestone contracts", () => {
  withTemporaryDirectory((root) => {
    const store = new WorkstreamStore(root, fixedClock());
    store.initialize(human);
    store.createProject(human, "compass", "Compass", "Direction records.");
    const source = store.attachProjectEvidence(
      human,
      "compass",
      "research",
      new TextEncoder().encode("Local research."),
    );
    const idea = store.createIdea(skeptic, "idea-1", "compass", {
      affectedUser: "Local teams",
      assumption: "They need a direction record.",
      costEstimate: "One small slice.",
      evidenceHash: source.sha256,
      expectedResult: "A reviewable Compass.",
      expiresAt: "2026-08-16T00:00:00.000Z",
      problem: "Direction gets lost.",
      rejectionReason: "Reject if local use is not observed.",
      risk: "Scope expansion.",
    });
    assert.equal(idea.status, "inbox");
    assert.equal(store.reviewIdea(human, idea.id, "shaped").status, "shaped");
    const assumption = store.createAssumption(
      skeptic,
      "assumption-1",
      "compass",
      {
        confidence: "medium",
        expiresAt: "2026-08-16T00:00:00.000Z",
        owner: "owner",
        statement: "Teams need a local Compass.",
        testMethod: "Inspect a local user result.",
      },
    );
    assert.equal(assumption.expired, true);
    assert.equal(
      store.recordAssumptionResult(
        human,
        assumption.id,
        "validated",
        source.sha256,
      ).result,
      "validated",
    );
    const tradeoff = store.createTradeoff(
      skeptic,
      "tradeoff-1",
      "compass",
      "Add GitHub write access?",
      "Faster handoff.",
      "Remote authority and audit burden.",
      source.sha256,
    );
    assert.equal(
      store.decideTradeoff(human, tradeoff.id, "defer", "Keep M2A local.")
        .decision,
      "defer",
    );
    const firstDecision = store.recordDecision(
      human,
      "decision-1",
      "compass",
      "Remote synchronization",
      "defer",
      "Evidence is incomplete.",
      source.sha256,
    );
    const replacement = store.recordDecision(
      human,
      "decision-2",
      "compass",
      "Remote synchronization",
      "reject",
      "The local boundary remains sufficient.",
      source.sha256,
      firstDecision.id,
    );
    assert.equal(store.decisions()[0]?.supersededBy, replacement.id);
    assert.throws(
      () =>
        store.createMilestone(human, "milestone-invalid", "compass", {
          acceptanceTests: [],
          evidenceRequired: ["Receipt"],
          humanGate: "Human accepts or stops.",
          nonGoals: ["No remote write."],
          risks: ["Scope expansion."],
          rollbackCondition: "Stop the local milestone.",
          smallestUsefulResult: "A local record.",
          userProblem: "Direction is not visible.",
        }),
      /acceptance tests/,
    );
    assert.equal(
      store.createMilestone(human, "milestone-1", "compass", {
        acceptanceTests: ["Verify the ledger."],
        evidenceRequired: ["Receipt"],
        humanGate: "Human accepts or stops.",
        nonGoals: ["No remote write."],
        risks: ["Scope expansion."],
        rollbackCondition: "Stop the local milestone.",
        smallestUsefulResult: "A local record.",
        userProblem: "Direction is not visible.",
      }).id,
      "milestone-1",
    );
    assert.equal(store.verify().valid, true);
    store.close();
  });
});

test("denies the Skeptic build, test, Judge, and approval actions", () => {
  withTemporaryDirectory((root) => {
    const started = startClaimedWork(root);
    assert.throws(
      () => started.store.claimWork(skeptic, started.workId),
      /Only an architect agent/,
    );
    assert.throws(
      () =>
        started.store.attachEvidence(
          skeptic,
          started.workId,
          "skeptic-note",
          new TextEncoder().encode("Direction concern."),
        ),
      /cannot attach work evidence/,
    );
    const evidence = started.store.attachEvidence(
      tester,
      started.workId,
      "test",
      new TextEncoder().encode("Independent test evidence."),
    );
    assert.throws(
      () =>
        started.store.recordTest(
          skeptic,
          started.workId,
          "PASS",
          evidence.sha256,
        ),
      /independent tester/,
    );
    assert.throws(
      () =>
        started.store.recordJudge(
          skeptic,
          started.workId,
          "Pass",
          evidence.sha256,
        ),
      /LLM Judge/,
    );
    assert.throws(
      () => started.store.decideGate(skeptic, started.workId, "accept"),
      /requires a human actor/,
    );
    assert.equal(started.store.verify().valid, true);
    started.store.close();
  });
});

test("replays Compass records through export and rejects a tampered Compass artifact", () => {
  withTemporaryDirectory((root) => {
    const sourceRoot = join(root, "source");
    const store = new WorkstreamStore(sourceRoot, fixedClock());
    store.initialize(human);
    store.createProject(human, "compass", "Compass", "Direction records.");
    const source = store.attachProjectEvidence(
      human,
      "compass",
      "research",
      new TextEncoder().encode("Evidence that must not change."),
    );
    store.createCompass(
      human,
      "compass-v1",
      "compass",
      compassInput(source.sha256),
    );
    const bundle = join(root, "bundle");
    store.exportBundle(bundle);
    const sourceSnapshot = store.compassSnapshot();
    store.close();

    const imported = new WorkstreamStore(join(root, "imported"), fixedClock());
    imported.importBundle(bundle);
    assert.deepEqual(imported.compassSnapshot(), sourceSnapshot);
    imported.close();

    writeFileSync(
      join(bundle, "evidence", "sha256", source.sha256),
      "changed evidence",
    );
    const tampered = new WorkstreamStore(join(root, "tampered"), fixedClock());
    assert.throws(() => tampered.importBundle(bundle), /does not match/);
    assert.equal(tampered.events().length, 0);
    tampered.close();
  });
});

test("uses equivalent Compass permissions through the loopback browser API", async () => {
  const root = mkdtempSync(join(tmpdir(), "workstream-compass-server-"));
  const server = createLocalServer(root);
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a loopback server address.");
    }
    const base = `http://127.0.0.1:${address.port}`;
    await post(base, "/api/initialize", { actor: "human:owner" });
    await post(base, "/api/projects", {
      actor: "human:owner",
      description: "Compass browser test.",
      id: "compass",
      name: "Compass",
    });
    const attachment = await post(base, "/api/projects/compass/evidence", {
      actor: "human:owner",
      content: "Local source evidence.",
      kind: "research",
    });
    const hash = requiredText(requiredObject(attachment, "evidence"), "sha256");
    await post(base, "/api/compass", {
      actor: "human:owner",
      id: "compass-v1",
      nonGoals: [
        {
          evidenceHash: hash,
          id: "no-remote-actions",
          text: "No remote actions.",
        },
      ],
      owner: "owner",
      principles: [
        {
          evidenceHash: hash,
          id: "local-evidence",
          text: "Use local evidence.",
        },
      ],
      projectId: "compass",
      title: "Local Compass",
    });
    const denied = await fetch(`${base}/api/compass/compass-v1/approve`, {
      body: JSON.stringify({ actor: "skeptic-agent:skeptic" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /requires a human actor/);
    const malformedConfidence = await fetch(`${base}/api/assumptions`, {
      body: JSON.stringify({
        actor: "human:owner",
        confidence: "certain",
        expiresAt: "2026-12-31T00:00:00.000Z",
        id: "assumption-invalid",
        owner: "owner",
        projectId: "compass",
        statement: "A malformed confidence must not be accepted.",
        testMethod: "Check the local API.",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(malformedConfidence.status, 400);
    assert.match(await malformedConfidence.text(), /confidence is invalid/);
    await post(base, "/api/compass/compass-v1/approve", {
      actor: "human:owner",
    });
    const projection = await jsonObject(
      await fetch(`${base}/api/projects/compass/vision`),
    );
    assert.match(requiredText(projection, "projection"), /Local Compass/);
    const state = await jsonObject(await fetch(`${base}/api/state`));
    assert.equal(
      requiredObject(state, "compass").compasses instanceof Array,
      true,
    );
  } finally {
    await closeServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});
