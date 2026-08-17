import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { canonicalJson, isSha256, sha256 } from "./canonical.js";
import { systemClock, type Clock } from "./clock.js";
import {
  actorMayAttachEvidence,
  mayClaim,
  nextGateStatus,
  requireHuman,
} from "../domain/permissions.js";
import type {
  Actor,
  EvidenceReference,
  ExportManifest,
  GateDecision,
  JudgeVerdict,
  LedgerEvent,
  Project,
  TestVerdict,
  VerificationReport,
  WorkItem,
  WorkStatus,
} from "../domain/model.js";
import { zeroHash } from "../domain/model.js";

const databaseDirectory = ".workstream";
const databaseName = "workstream.db";
const evidenceDirectory = join(databaseDirectory, "evidence", "sha256");

type SqlRow = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringValue = (record: SqlRow, key: string): string => {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Database field ${key} is not a string.`);
  }
  return value;
};

const nullableStringValue = (record: SqlRow, key: string): string | null => {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Database field ${key} is not a string or null.`);
  }
  return value;
};

const numberValue = (record: SqlRow, key: string): number => {
  const value = record[key];
  if (typeof value !== "number") {
    throw new Error(`Database field ${key} is not a number.`);
  }
  return value;
};

const parseJsonRecord = (
  text: string,
  label: string,
): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return parsed;
};

const actorKinds: readonly Actor["kind"][] = [
  "human",
  "architect-agent",
  "independent-tester",
  "llm-judge",
];

const isActorKind = (value: string): value is Actor["kind"] =>
  actorKinds.some((candidate) => candidate === value);

export const parseActor = (value: string): Actor => {
  const separator = value.indexOf(":");
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (separator < 1 || id.length === 0 || !isActorKind(kind)) {
    throw new Error("Actor must use kind:id with a supported actor kind.");
  }
  return { kind, id };
};

const actorText = (actor: Actor): string => `${actor.kind}:${actor.id}`;

const projectFromRow = (row: SqlRow): Project => ({
  id: stringValue(row, "id"),
  name: stringValue(row, "name"),
  description: stringValue(row, "description"),
  createdAt: stringValue(row, "created_at"),
});

const workFromRow = (row: SqlRow): WorkItem => ({
  id: stringValue(row, "id"),
  projectId: stringValue(row, "project_id"),
  title: stringValue(row, "title"),
  status: requireStatus(stringValue(row, "status")),
  claimant: nullableStringValue(row, "claimant"),
  mandateEvidenceHash: nullableStringValue(row, "mandate_evidence_hash"),
  createdAt: stringValue(row, "created_at"),
  updatedAt: stringValue(row, "updated_at"),
});

const eventFromRow = (row: SqlRow): LedgerEvent => ({
  sequence: numberValue(row, "sequence"),
  actor: parseActor(stringValue(row, "actor")),
  timestamp: stringValue(row, "occurred_at"),
  type: stringValue(row, "event_type"),
  payload: parseJsonRecord(stringValue(row, "payload_json"), "Event payload"),
  previousSha256: stringValue(row, "previous_sha256"),
  sha256: stringValue(row, "event_sha256"),
});

const eventMaterial = (
  event: Omit<LedgerEvent, "sha256">,
): Record<string, unknown> => ({
  actor: event.actor,
  payload: event.payload,
  previousSha256: event.previousSha256,
  sequence: event.sequence,
  timestamp: event.timestamp,
  type: event.type,
});

const evidencePath = (root: string, hash: string): string =>
  join(root, evidenceDirectory, hash);

const requireText = (payload: Record<string, unknown>, key: string): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Event payload ${key} must be a non-empty string.`);
  }
  return value;
};

const workStatuses: readonly WorkStatus[] = [
  "ready",
  "claimed",
  "testing",
  "awaiting-gate",
  "accepted",
  "rejected",
  "stopped",
  "blocked",
];

const isWorkStatus = (value: string): value is WorkStatus =>
  workStatuses.some((status) => status === value);

const requireStatus = (value: string): WorkStatus => {
  if (!isWorkStatus(value)) {
    throw new Error("Event contains an unknown work status.");
  }
  return value;
};

export class WorkstreamStore {
  readonly root: string;
  readonly database: DatabaseSync;
  readonly clock: Clock;

  constructor(root: string, clock: Clock = systemClock) {
    this.root = resolve(root);
    this.clock = clock;
    mkdirSync(join(this.root, databaseDirectory), { recursive: true });
    mkdirSync(join(this.root, evidenceDirectory), { recursive: true });
    this.database = new DatabaseSync(
      join(this.root, databaseDirectory, databaseName),
    );
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.createSchema();
  }

  close(): void {
    this.database.close();
  }

  initialize(actor: Actor): LedgerEvent {
    const existing = this.database
      .prepare("SELECT COUNT(*) AS count FROM events")
      .get();
    if (existing === undefined || numberValue(existing, "count") !== 0) {
      throw new Error("Workstream is already initialized.");
    }
    const permission = requireHuman(actor, "Initialization");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    return this.append(actor, "workstream.initialized", {
      schemaVersion: "workstream/0.1",
    });
  }

  createProject(
    actor: Actor,
    id: string,
    name: string,
    description: string,
  ): Project {
    const permission = requireHuman(actor, "Project creation");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    this.requireIdentifier(id, "Project id");
    this.requireText(name, "Project name");
    this.requireText(description, "Project description");
    const createdAt = this.clock();
    this.transaction(() => {
      this.append(actor, "project.created", {
        createdAt,
        description,
        id,
        name,
      });
      this.database
        .prepare(
          "INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(id, name, description, createdAt);
    });
    const project = this.project(id);
    if (project === null) {
      throw new Error("Project projection was not created.");
    }
    return project;
  }

  createWork(
    actor: Actor,
    id: string,
    projectId: string,
    title: string,
  ): WorkItem {
    const permission = requireHuman(actor, "Work creation");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    this.requireIdentifier(id, "Work id");
    this.requireText(title, "Work title");
    if (this.project(projectId) === null) {
      throw new Error(`Project ${projectId} does not exist.`);
    }
    const createdAt = this.clock();
    this.transaction(() => {
      this.append(actor, "work.created", { createdAt, id, projectId, title });
      this.database
        .prepare(
          "INSERT INTO work_items (id, project_id, title, status, claimant, mandate_evidence_hash, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)",
        )
        .run(id, projectId, title, "ready", createdAt, createdAt);
    });
    return this.requireWork(id);
  }

  issueMandate(
    actor: Actor,
    workId: string,
    content: Uint8Array,
  ): EvidenceReference {
    const permission = requireHuman(actor, "Mandate issuance");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    const work = this.requireWork(workId);
    if (work.status !== "ready") {
      throw new Error("A mandate can be issued only for ready work.");
    }
    const evidence = this.storeEvidence(content);
    const updatedAt = this.clock();
    this.transaction(() => {
      this.registerEvidence(evidence);
      this.append(actor, "mandate.issued", {
        evidenceHash: evidence.sha256,
        workId,
      });
      this.database
        .prepare(
          "UPDATE work_items SET mandate_evidence_hash = ?, updated_at = ? WHERE id = ?",
        )
        .run(evidence.sha256, updatedAt, workId);
    });
    return evidence;
  }

  claimWork(actor: Actor, workId: string): WorkItem {
    const work = this.requireWork(workId);
    const permission = mayClaim(actor, work.status);
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    const updatedAt = this.clock();
    this.transaction(() => {
      this.append(actor, "work.claimed", { claimant: actor.id, workId });
      this.database
        .prepare(
          "UPDATE work_items SET claimant = ?, status = ?, updated_at = ? WHERE id = ?",
        )
        .run(actor.id, "claimed", updatedAt, workId);
    });
    return this.requireWork(workId);
  }

  attachEvidence(
    actor: Actor,
    workId: string,
    kind: string,
    content: Uint8Array,
  ): EvidenceReference {
    this.requireText(kind, "Evidence kind");
    const work = this.requireWork(workId);
    const permission = actorMayAttachEvidence(actor, work.claimant);
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    const evidence = this.storeEvidence(content);
    this.transaction(() => {
      this.registerEvidence(evidence);
      this.append(actor, "evidence.attached", {
        evidenceHash: evidence.sha256,
        kind,
        workId,
      });
      this.database
        .prepare(
          "INSERT INTO work_evidence (work_id, evidence_hash, kind) VALUES (?, ?, ?)",
        )
        .run(workId, evidence.sha256, kind);
    });
    return evidence;
  }

  createHandoff(
    actor: Actor,
    workId: string,
    recipient: Actor,
    summary: string,
  ): LedgerEvent {
    const work = this.requireWork(workId);
    if (actor.kind === "architect-agent" && work.claimant !== actor.id) {
      throw new Error("An architect agent may hand off only its claimed work.");
    }
    this.requireText(summary, "Handoff summary");
    return this.append(actor, "handoff.created", {
      recipient: actorText(recipient),
      summary,
      workId,
    });
  }

  recordTest(
    actor: Actor,
    workId: string,
    verdict: TestVerdict,
    evidenceHash: string,
  ): WorkItem {
    if (actor.kind !== "independent-tester") {
      throw new Error("Test recording requires the independent tester actor.");
    }
    const work = this.requireWork(workId);
    if (work.status !== "claimed") {
      throw new Error("Tests can be recorded only for claimed work.");
    }
    this.requireEvidence(evidenceHash);
    const status: WorkStatus = verdict === "PASS" ? "testing" : "blocked";
    const updatedAt = this.clock();
    this.transaction(() => {
      this.append(actor, "test.recorded", { evidenceHash, verdict, workId });
      this.database
        .prepare(
          "INSERT INTO observations (work_id, kind, verdict, evidence_hash) VALUES (?, ?, ?, ?)",
        )
        .run(workId, "test", verdict, evidenceHash);
      this.database
        .prepare(
          "UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?",
        )
        .run(status, updatedAt, workId);
    });
    return this.requireWork(workId);
  }

  recordJudge(
    actor: Actor,
    workId: string,
    verdict: JudgeVerdict,
    evidenceHash: string,
  ): WorkItem {
    if (actor.kind !== "llm-judge") {
      throw new Error("Judge recording requires the LLM Judge actor.");
    }
    const work = this.requireWork(workId);
    if (work.status !== "testing") {
      throw new Error(
        "Judge evidence requires a passing independent test record.",
      );
    }
    this.requireEvidence(evidenceHash);
    const status: WorkStatus = verdict === "Pass" ? "awaiting-gate" : "blocked";
    const updatedAt = this.clock();
    this.transaction(() => {
      this.append(actor, "judge.recorded", { evidenceHash, verdict, workId });
      this.database
        .prepare(
          "INSERT INTO observations (work_id, kind, verdict, evidence_hash) VALUES (?, ?, ?, ?)",
        )
        .run(workId, "judge", verdict, evidenceHash);
      this.database
        .prepare(
          "UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?",
        )
        .run(status, updatedAt, workId);
    });
    return this.requireWork(workId);
  }

  decideGate(actor: Actor, workId: string, decision: GateDecision): WorkItem {
    const permission = requireHuman(actor, "Gate decision");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    const work = this.requireWork(workId);
    const next = nextGateStatus(work.status, decision);
    if (next.kind === "error") {
      throw new Error(next.message);
    }
    const updatedAt = this.clock();
    this.transaction(() => {
      this.append(actor, "gate.decided", { decision, workId });
      this.database
        .prepare(
          "UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?",
        )
        .run(next.value, updatedAt, workId);
    });
    return this.requireWork(workId);
  }

  project(id: string): Project | null {
    const row = this.database
      .prepare(
        "SELECT id, name, description, created_at FROM projects WHERE id = ?",
      )
      .get(id);
    return row === undefined ? null : projectFromRow(row);
  }

  work(id: string): WorkItem | null {
    const row = this.database
      .prepare(
        "SELECT id, project_id, title, status, claimant, mandate_evidence_hash, created_at, updated_at FROM work_items WHERE id = ?",
      )
      .get(id);
    return row === undefined ? null : workFromRow(row);
  }

  queue(): readonly WorkItem[] {
    return this.database
      .prepare(
        "SELECT id, project_id, title, status, claimant, mandate_evidence_hash, created_at, updated_at FROM work_items WHERE status = ? ORDER BY created_at, id",
      )
      .all("ready")
      .map(workFromRow);
  }

  blocked(): readonly WorkItem[] {
    return this.database
      .prepare(
        "SELECT id, project_id, title, status, claimant, mandate_evidence_hash, created_at, updated_at FROM work_items WHERE status = ? ORDER BY updated_at, id",
      )
      .all("blocked")
      .map(workFromRow);
  }

  activity(workId?: string): readonly LedgerEvent[] {
    const events = this.events();
    if (workId === undefined) {
      return events;
    }
    return events.filter((event) => event.payload.workId === workId);
  }

  events(): readonly LedgerEvent[] {
    return this.database
      .prepare(
        "SELECT sequence, actor, occurred_at, event_type, payload_json, previous_sha256, event_sha256 FROM events ORDER BY sequence",
      )
      .all()
      .map(eventFromRow);
  }

  verify(): VerificationReport {
    const errors: string[] = [];
    let previous = zeroHash;
    const events = this.events();
    for (const event of events) {
      const expectedSequence = events.indexOf(event) + 1;
      if (event.sequence !== expectedSequence) {
        errors.push(
          `Event sequence ${event.sequence} does not match expected ${expectedSequence}.`,
        );
      }
      if (event.previousSha256 !== previous) {
        errors.push(`Event ${event.sequence} has an unexpected previous hash.`);
      }
      const expectedHash = sha256(canonicalJson(eventMaterial(event)));
      if (event.sha256 !== expectedHash) {
        errors.push(`Event ${event.sequence} hash does not match its content.`);
      }
      previous = event.sha256;
    }
    const evidenceRows = this.database
      .prepare("SELECT sha256, bytes FROM evidence ORDER BY sha256")
      .all();
    for (const row of evidenceRows) {
      const hash = stringValue(row, "sha256");
      const expectedBytes = numberValue(row, "bytes");
      const path = evidencePath(this.root, hash);
      try {
        const content = readFileSync(path);
        if (content.length !== expectedBytes) {
          errors.push(`Evidence ${hash} byte length does not match.`);
        }
        if (sha256(content) !== hash) {
          errors.push(`Evidence ${hash} hash does not match its content.`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        errors.push(`Evidence ${hash} cannot be read: ${detail}`);
      }
    }
    return {
      valid: errors.length === 0,
      eventCount: events.length,
      evidenceCount: evidenceRows.length,
      errors,
    };
  }

  exportBundle(destination: string): ExportManifest {
    const target = resolve(destination);
    const verification = this.verify();
    if (!verification.valid) {
      throw new Error(
        `Cannot export an invalid ledger: ${verification.errors.join(" ")}`,
      );
    }
    mkdirSync(join(target, "evidence", "sha256"), { recursive: true });
    const eventLines = this.events()
      .map((event) => canonicalJson(event))
      .join("\n");
    const evidence = this.evidenceReferences();
    for (const reference of evidence) {
      writeFileSync(
        join(target, "evidence", "sha256", reference.sha256),
        readFileSync(evidencePath(this.root, reference.sha256)),
      );
    }
    writeFileSync(
      join(target, "events.ndjson"),
      eventLines.length === 0 ? "" : `${eventLines}\n`,
    );
    const manifest: ExportManifest = {
      schemaVersion: "workstream-bundle/0.1",
      createdAt: this.clock(),
      eventsSha256: sha256(eventLines),
      evidence,
    };
    writeFileSync(join(target, "manifest.json"), canonicalJson(manifest));
    return manifest;
  }

  importBundle(bundle: string): ExportManifest {
    if (this.events().length !== 0) {
      throw new Error("Import requires an empty workstream store.");
    }
    const source = resolve(bundle);
    this.assertBundlePaths(source);
    const manifest = this.readManifest(source);
    const eventText = readFileSync(join(source, "events.ndjson"), "utf8");
    const eventLines = eventText === "" ? [] : eventText.trimEnd().split("\n");
    const canonicalEventText = eventLines.join("\n");
    if (sha256(canonicalEventText) !== manifest.eventsSha256) {
      throw new Error("Bundle events do not match the manifest digest.");
    }
    const events = eventLines.map((line, index) =>
      this.parseBundleEvent(line, index + 1),
    );
    this.verifyImportedChain(events);
    for (const reference of manifest.evidence) {
      const content = readFileSync(
        join(source, "evidence", "sha256", reference.sha256),
      );
      if (
        content.length !== reference.bytes ||
        sha256(content) !== reference.sha256
      ) {
        throw new Error(
          `Bundle evidence ${reference.sha256} does not match its manifest entry.`,
        );
      }
    }
    this.transaction(() => {
      for (const reference of manifest.evidence) {
        const content = readFileSync(
          join(source, "evidence", "sha256", reference.sha256),
        );
        const target = evidencePath(this.root, reference.sha256);
        writeFileSync(target, content, { flag: "wx" });
        this.database
          .prepare("INSERT INTO evidence (sha256, bytes) VALUES (?, ?)")
          .run(reference.sha256, reference.bytes);
      }
      for (const event of events) {
        this.insertImportedEvent(event);
        this.applyProjection(event);
      }
    });
    const result = this.verify();
    if (!result.valid) {
      throw new Error(
        `Imported ledger cannot be verified: ${result.errors.join(" ")}`,
      );
    }
    return manifest;
  }

  evidenceReferences(): readonly EvidenceReference[] {
    return this.database
      .prepare("SELECT sha256, bytes FROM evidence ORDER BY sha256")
      .all()
      .map((row) => {
        const hash = stringValue(row, "sha256");
        return {
          sha256: hash,
          bytes: numberValue(row, "bytes"),
          path: `evidence/sha256/${hash}`,
        };
      });
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY,
        actor TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        previous_sha256 TEXT NOT NULL,
        event_sha256 TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        claimant TEXT,
        mandate_evidence_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence (
        sha256 TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_evidence (
        work_id TEXT NOT NULL REFERENCES work_items(id),
        evidence_hash TEXT NOT NULL REFERENCES evidence(sha256),
        kind TEXT NOT NULL,
        PRIMARY KEY (work_id, evidence_hash, kind)
      );
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id TEXT NOT NULL REFERENCES work_items(id),
        kind TEXT NOT NULL,
        verdict TEXT NOT NULL,
        evidence_hash TEXT NOT NULL REFERENCES evidence(sha256)
      );
    `);
  }

  private append(
    actor: Actor,
    type: string,
    payload: Record<string, unknown>,
  ): LedgerEvent {
    const latest = this.database
      .prepare(
        "SELECT sequence, event_sha256 FROM events ORDER BY sequence DESC LIMIT 1",
      )
      .get();
    const sequence =
      latest === undefined ? 1 : numberValue(latest, "sequence") + 1;
    const previousSha256 =
      latest === undefined ? zeroHash : stringValue(latest, "event_sha256");
    const eventWithoutHash: Omit<LedgerEvent, "sha256"> = {
      sequence,
      actor,
      timestamp: this.clock(),
      type,
      payload,
      previousSha256,
    };
    const event: LedgerEvent = {
      ...eventWithoutHash,
      sha256: sha256(canonicalJson(eventMaterial(eventWithoutHash))),
    };
    this.database
      .prepare(
        "INSERT INTO events (sequence, actor, occurred_at, event_type, payload_json, previous_sha256, event_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.sequence,
        actorText(event.actor),
        event.timestamp,
        event.type,
        canonicalJson(event.payload),
        event.previousSha256,
        event.sha256,
      );
    return event;
  }

  private transaction(action: () => void): void {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      action();
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  private storeEvidence(content: Uint8Array): EvidenceReference {
    const hash = sha256(content);
    const path = evidencePath(this.root, hash);
    if (statExists(path)) {
      const existing = readFileSync(path);
      if (sha256(existing) !== hash) {
        throw new Error(
          `Existing evidence ${hash} does not match its address.`,
        );
      }
    } else {
      const temporary = `${path}.tmp-${process.pid}`;
      writeFileSync(temporary, content, { flag: "wx" });
      renameSync(temporary, path);
    }
    return {
      sha256: hash,
      bytes: content.length,
      path: relative(this.root, path).replaceAll("\\", "/"),
    };
  }

  private registerEvidence(evidence: EvidenceReference): void {
    this.database
      .prepare("INSERT OR IGNORE INTO evidence (sha256, bytes) VALUES (?, ?)")
      .run(evidence.sha256, evidence.bytes);
  }

  private requireEvidence(hash: string): void {
    if (!isSha256(hash)) {
      throw new Error("Evidence hash must be a SHA-256 hex digest.");
    }
    const row = this.database
      .prepare("SELECT sha256 FROM evidence WHERE sha256 = ?")
      .get(hash);
    if (row === undefined) {
      throw new Error(`Evidence ${hash} is not registered.`);
    }
  }

  private requireWork(id: string): WorkItem {
    const work = this.work(id);
    if (work === null) {
      throw new Error(`Work ${id} does not exist.`);
    }
    return work;
  }

  private requireIdentifier(value: string, label: string): void {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(value)) {
      throw new Error(`${label} must be a lowercase identifier.`);
    }
  }

  private requireText(value: string, label: string): void {
    if (value.trim().length === 0) {
      throw new Error(`${label} must not be empty.`);
    }
  }

  private readManifest(root: string): ExportManifest {
    const parsed: unknown = JSON.parse(
      readFileSync(join(root, "manifest.json"), "utf8"),
    );
    if (!isRecord(parsed) || parsed.schemaVersion !== "workstream-bundle/0.1") {
      throw new Error("Bundle manifest has an unsupported schema.");
    }
    if (
      typeof parsed.createdAt !== "string" ||
      typeof parsed.eventsSha256 !== "string" ||
      !isSha256(parsed.eventsSha256)
    ) {
      throw new Error("Bundle manifest is malformed.");
    }
    if (!Array.isArray(parsed.evidence)) {
      throw new Error("Bundle manifest evidence is malformed.");
    }
    const evidence = parsed.evidence.map((entry): EvidenceReference => {
      if (
        !isRecord(entry) ||
        typeof entry.sha256 !== "string" ||
        typeof entry.bytes !== "number" ||
        typeof entry.path !== "string"
      ) {
        throw new Error("Bundle evidence entry is malformed.");
      }
      if (
        !isSha256(entry.sha256) ||
        entry.bytes < 0 ||
        entry.path !== `evidence/sha256/${entry.sha256}`
      ) {
        throw new Error("Bundle evidence entry is unsafe.");
      }
      return { sha256: entry.sha256, bytes: entry.bytes, path: entry.path };
    });
    const sorted = evidence
      .slice()
      .sort((left, right) => left.sha256.localeCompare(right.sha256));
    if (
      canonicalJson(sorted) !== canonicalJson(evidence) ||
      new Set(evidence.map((entry) => entry.sha256)).size !== evidence.length
    ) {
      throw new Error("Bundle evidence entries must be unique and sorted.");
    }
    return {
      schemaVersion: "workstream-bundle/0.1",
      createdAt: parsed.createdAt,
      eventsSha256: parsed.eventsSha256,
      evidence,
    };
  }

  private parseBundleEvent(
    line: string,
    expectedSequence: number,
  ): LedgerEvent {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) {
      throw new Error("Bundle event is not an object.");
    }
    const sequence = parsed.sequence;
    const actor = parsed.actor;
    const timestamp = parsed.timestamp;
    const type = parsed.type;
    const payload = parsed.payload;
    const previousSha256 = parsed.previousSha256;
    const hash = parsed.sha256;
    if (
      typeof sequence !== "number" ||
      sequence !== expectedSequence ||
      !isRecord(actor) ||
      typeof actor.kind !== "string" ||
      typeof actor.id !== "string" ||
      !isActorKind(actor.kind) ||
      typeof timestamp !== "string" ||
      typeof type !== "string" ||
      !isRecord(payload) ||
      typeof previousSha256 !== "string" ||
      typeof hash !== "string" ||
      !isSha256(previousSha256) ||
      !isSha256(hash)
    ) {
      throw new Error("Bundle event is malformed.");
    }
    return {
      sequence,
      actor: { kind: actor.kind, id: actor.id },
      timestamp,
      type,
      payload,
      previousSha256,
      sha256: hash,
    };
  }

  private verifyImportedChain(events: readonly LedgerEvent[]): void {
    let previous = zeroHash;
    for (const event of events) {
      if (
        event.previousSha256 !== previous ||
        event.sha256 !== sha256(canonicalJson(eventMaterial(event)))
      ) {
        throw new Error(
          `Bundle event ${event.sequence} does not form a valid hash chain.`,
        );
      }
      previous = event.sha256;
    }
  }

  private insertImportedEvent(event: LedgerEvent): void {
    this.database
      .prepare(
        "INSERT INTO events (sequence, actor, occurred_at, event_type, payload_json, previous_sha256, event_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.sequence,
        actorText(event.actor),
        event.timestamp,
        event.type,
        canonicalJson(event.payload),
        event.previousSha256,
        event.sha256,
      );
  }

  private applyProjection(event: LedgerEvent): void {
    const payload = event.payload;
    if (event.type === "workstream.initialized") {
      return;
    }
    if (event.type === "project.created") {
      this.database
        .prepare(
          "INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          requireText(payload, "id"),
          requireText(payload, "name"),
          requireText(payload, "description"),
          requireText(payload, "createdAt"),
        );
      return;
    }
    if (event.type === "work.created") {
      const createdAt = requireText(payload, "createdAt");
      this.database
        .prepare(
          "INSERT INTO work_items (id, project_id, title, status, claimant, mandate_evidence_hash, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)",
        )
        .run(
          requireText(payload, "id"),
          requireText(payload, "projectId"),
          requireText(payload, "title"),
          "ready",
          createdAt,
          createdAt,
        );
      return;
    }
    if (event.type === "mandate.issued") {
      this.database
        .prepare("UPDATE work_items SET mandate_evidence_hash = ? WHERE id = ?")
        .run(
          requireText(payload, "evidenceHash"),
          requireText(payload, "workId"),
        );
      return;
    }
    if (event.type === "work.claimed") {
      this.database
        .prepare("UPDATE work_items SET claimant = ?, status = ? WHERE id = ?")
        .run(
          requireText(payload, "claimant"),
          "claimed",
          requireText(payload, "workId"),
        );
      return;
    }
    if (event.type === "evidence.attached") {
      this.database
        .prepare(
          "INSERT INTO work_evidence (work_id, evidence_hash, kind) VALUES (?, ?, ?)",
        )
        .run(
          requireText(payload, "workId"),
          requireText(payload, "evidenceHash"),
          requireText(payload, "kind"),
        );
      return;
    }
    if (event.type === "handoff.created") {
      return;
    }
    if (event.type === "test.recorded") {
      const verdict = requireText(payload, "verdict");
      const status = verdict === "PASS" ? "testing" : "blocked";
      this.database
        .prepare(
          "INSERT INTO observations (work_id, kind, verdict, evidence_hash) VALUES (?, ?, ?, ?)",
        )
        .run(
          requireText(payload, "workId"),
          "test",
          verdict,
          requireText(payload, "evidenceHash"),
        );
      this.database
        .prepare("UPDATE work_items SET status = ? WHERE id = ?")
        .run(status, requireText(payload, "workId"));
      return;
    }
    if (event.type === "judge.recorded") {
      const verdict = requireText(payload, "verdict");
      const status = verdict === "Pass" ? "awaiting-gate" : "blocked";
      this.database
        .prepare(
          "INSERT INTO observations (work_id, kind, verdict, evidence_hash) VALUES (?, ?, ?, ?)",
        )
        .run(
          requireText(payload, "workId"),
          "judge",
          verdict,
          requireText(payload, "evidenceHash"),
        );
      this.database
        .prepare("UPDATE work_items SET status = ? WHERE id = ?")
        .run(status, requireText(payload, "workId"));
      return;
    }
    if (event.type === "gate.decided") {
      const current = this.requireWork(requireText(payload, "workId"));
      const decision = requireText(payload, "decision");
      if (!isGateDecision(decision)) {
        throw new Error("Bundle gate decision is unknown.");
      }
      const target = nextGateStatus(current.status, decision);
      if (target.kind === "error") {
        throw new Error(target.message);
      }
      this.database
        .prepare("UPDATE work_items SET status = ? WHERE id = ?")
        .run(target.value, current.id);
      return;
    }
    throw new Error(`Bundle event type ${event.type} is unsupported.`);
  }

  private assertBundlePaths(root: string): void {
    const required = [
      join(root, "manifest.json"),
      join(root, "events.ndjson"),
      join(root, "evidence"),
      join(root, "evidence", "sha256"),
    ];
    for (const path of required) {
      if (!statExists(path)) {
        throw new Error(
          `Bundle path is missing: ${relative(root, path) || "."}`,
        );
      }
      if (statSync(path).isSymbolicLink()) {
        throw new Error("Bundle symlinks are not accepted.");
      }
    }
  }
}

const statExists = (path: string): boolean => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};

const isGateDecision = (value: string): value is GateDecision =>
  ["accept", "reject", "stop"].some((decision) => decision === value);
