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
  Assumption,
  AssumptionConfidence,
  AssumptionInput,
  AssumptionResult,
  CompassDraftInput,
  CompassSnapshot,
  CompassStatement,
  CompassStatus,
  CompassVersion,
  Decision,
  DecisionOutcome,
  EvidenceReference,
  ExportManifest,
  GateDecision,
  Idea,
  IdeaInput,
  IdeaStatus,
  JudgeVerdict,
  LedgerEvent,
  MilestoneContract,
  MilestoneContractInput,
  LaunchReadiness,
  LaunchReadinessInput,
  LaunchReadinessStatus,
  OutcomeDecision,
  OutcomeReview,
  Project,
  ShapeBrief,
  ShapeBriefInput,
  ShapeBriefStatus,
  TestVerdict,
  TradeoffCard,
  TradeoffDecision,
  VerificationReport,
  WorkEvidenceReference,
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
  "skeptic-agent",
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

const compassStatuses: readonly CompassStatus[] = [
  "draft",
  "approved",
  "superseded",
];
const ideaStatuses: readonly IdeaStatus[] = [
  "inbox",
  "shaped",
  "rejected",
  "deferred",
];
const assumptionConfidences: readonly AssumptionConfidence[] = [
  "low",
  "medium",
  "high",
];
const assumptionResults: readonly AssumptionResult[] = [
  "open",
  "validated",
  "invalidated",
];
const decisionOutcomes: readonly DecisionOutcome[] = [
  "accept",
  "reject",
  "defer",
  "stop",
];
const tradeoffDecisions: readonly Exclude<TradeoffDecision, null>[] = [
  "accept",
  "reject",
  "defer",
];
const shapeBriefStatuses: readonly ShapeBriefStatus[] = ["draft", "approved"];
const launchReadinessStatuses: readonly LaunchReadinessStatus[] = [
  "draft",
  "authorized",
];
const outcomeDecisions: readonly Exclude<OutcomeDecision, null>[] = [
  "keep",
  "change",
  "stop",
];

const requiredEnum = <T extends string>(
  value: string,
  values: readonly T[],
  label: string,
): T => {
  const matched = values.find((candidate) => candidate === value);
  if (matched === undefined) {
    throw new Error(`${label} is unknown.`);
  }
  return matched;
};

const statementsFromRows = (
  rows: readonly SqlRow[],
): readonly CompassStatement[] =>
  rows.map((row) => ({
    id: stringValue(row, "statement_id"),
    text: stringValue(row, "statement_text"),
    evidenceHash: stringValue(row, "evidence_hash"),
  }));

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

  attachProjectEvidence(
    actor: Actor,
    projectId: string,
    kind: string,
    content: Uint8Array,
  ): EvidenceReference {
    const permission = requireHuman(actor, "Project evidence attachment");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    this.requireProject(projectId);
    this.requireText(kind, "Evidence kind");
    const evidence = this.storeEvidence(content);
    this.transaction(() => {
      this.registerEvidence(evidence);
      this.append(actor, "project.evidence.attached", {
        evidenceHash: evidence.sha256,
        kind,
        projectId,
      });
      this.database
        .prepare(
          "INSERT INTO project_evidence (project_id, evidence_hash, kind) VALUES (?, ?, ?)",
        )
        .run(projectId, evidence.sha256, kind);
    });
    return evidence;
  }

  createCompass(
    actor: Actor,
    id: string,
    projectId: string,
    input: CompassDraftInput,
  ): CompassVersion {
    return this.createCompassDraft(actor, id, projectId, input, null);
  }

  approveCompass(actor: Actor, compassId: string): CompassVersion {
    const compass = this.requireCompass(compassId);
    const permission = requireHuman(actor, "Compass approval");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    if (actor.id !== compass.owner) {
      throw new Error("Compass approval requires its named human owner.");
    }
    if (compass.status !== "draft") {
      throw new Error("Only a Compass draft can be approved.");
    }
    const active = this.activeCompass(compass.projectId);
    if (active !== null) {
      throw new Error("Approve a replacement through Compass supersession.");
    }
    const approvedAt = this.clock();
    this.transaction(() => {
      this.append(actor, "compass.approved", { approvedAt, compassId });
      this.database
        .prepare(
          "UPDATE compasses SET status = ?, approved_at = ? WHERE id = ?",
        )
        .run("approved", approvedAt, compassId);
    });
    return this.requireCompass(compassId);
  }

  supersedeCompass(
    actor: Actor,
    previousCompassId: string,
    replacementCompassId: string,
  ): CompassVersion {
    const previous = this.requireCompass(previousCompassId);
    const replacement = this.requireCompass(replacementCompassId);
    const permission = requireHuman(actor, "Compass supersession");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    if (
      actor.id !== previous.owner ||
      actor.id !== replacement.owner ||
      previous.projectId !== replacement.projectId
    ) {
      throw new Error(
        "Compass supersession requires the named owner of both project versions.",
      );
    }
    if (previous.status !== "approved" || replacement.status !== "draft") {
      throw new Error(
        "Compass supersession requires an approved version and a replacement draft.",
      );
    }
    const approvedAt = this.clock();
    this.transaction(() => {
      this.append(actor, "compass.superseded", {
        compassId: previousCompassId,
        supersededAt: approvedAt,
        supersededBy: replacementCompassId,
      });
      this.database
        .prepare(
          "UPDATE compasses SET status = ?, superseded_by = ? WHERE id = ?",
        )
        .run("superseded", replacementCompassId, previousCompassId);
      this.append(actor, "compass.approved", {
        approvedAt,
        compassId: replacementCompassId,
        supersedesCompassId: previousCompassId,
      });
      this.database
        .prepare(
          "UPDATE compasses SET status = ?, approved_at = ? WHERE id = ?",
        )
        .run("approved", approvedAt, replacementCompassId);
    });
    return this.requireCompass(replacementCompassId);
  }

  exportVision(projectId: string, destination: string): string {
    const compass = this.activeCompass(projectId);
    if (compass === null) {
      throw new Error("VISION.md export requires an approved Compass version.");
    }
    const text = this.renderVision(compass);
    writeFileSync(resolve(destination), text, "utf8");
    return text;
  }

  vision(projectId: string): string {
    const compass = this.activeCompass(projectId);
    if (compass === null) {
      throw new Error(
        "VISION.md projection requires an approved Compass version.",
      );
    }
    return this.renderVision(compass);
  }

  importVision(
    actor: Actor,
    id: string,
    projectId: string,
    source: string,
  ): CompassVersion {
    return this.importVisionContent(
      actor,
      id,
      projectId,
      readFileSync(resolve(source)),
    );
  }

  importVisionContent(
    actor: Actor,
    id: string,
    projectId: string,
    content: Uint8Array,
  ): CompassVersion {
    const permission = requireHuman(actor, "VISION.md import");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    this.requireProject(projectId);
    const parsed = this.parseVision(new TextDecoder().decode(content));
    const evidence = this.attachProjectEvidence(
      actor,
      projectId,
      "vision-source",
      content,
    );
    const compass = this.createCompassDraft(
      actor,
      id,
      projectId,
      {
        owner: actor.id,
        title: parsed.title,
        principles: parsed.principles.map((text, index) => ({
          evidenceHash: evidence.sha256,
          id: `principle-${index + 1}`,
          text,
        })),
        nonGoals: parsed.nonGoals.map((text, index) => ({
          evidenceHash: evidence.sha256,
          id: `non-goal-${index + 1}`,
          text,
        })),
      },
      evidence.sha256,
    );
    this.append(actor, "vision.imported", {
      compassId: compass.id,
      evidenceHash: evidence.sha256,
      projectId,
    });
    return compass;
  }

  createIdea(
    actor: Actor,
    id: string,
    projectId: string,
    input: IdeaInput,
  ): Idea {
    this.requireProject(projectId);
    this.requireIdentifier(id, "Idea id");
    this.requireIdeaInput(projectId, input);
    const createdAt = this.clock();
    this.transaction(() => {
      this.append(actor, "idea.created", {
        ...input,
        createdAt,
        id,
        projectId,
      });
      this.database
        .prepare(
          "INSERT INTO ideas (id, project_id, problem, affected_user, expected_result, evidence_hash, assumption, risk, cost_estimate, rejection_reason, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          projectId,
          input.problem,
          input.affectedUser,
          input.expectedResult,
          input.evidenceHash,
          input.assumption,
          input.risk,
          input.costEstimate,
          input.rejectionReason,
          input.expiresAt,
          "inbox",
          createdAt,
        );
    });
    return this.requireIdea(id);
  }

  reviewIdea(
    actor: Actor,
    ideaId: string,
    status: Exclude<IdeaStatus, "inbox">,
  ): Idea {
    const permission = requireHuman(actor, "Idea selection");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    if (!ideaStatuses.some((candidate) => candidate === status)) {
      throw new Error("Idea review status is invalid.");
    }
    const idea = this.requireIdea(ideaId);
    if (idea.status !== "inbox") {
      throw new Error("An idea can be selected only once.");
    }
    this.transaction(() => {
      this.append(actor, "idea.reviewed", { ideaId, status });
      this.database
        .prepare("UPDATE ideas SET status = ? WHERE id = ?")
        .run(status, ideaId);
    });
    return this.requireIdea(ideaId);
  }

  createAssumption(
    actor: Actor,
    id: string,
    projectId: string,
    input: AssumptionInput,
  ): Assumption {
    this.requireProject(projectId);
    this.requireIdentifier(id, "Assumption id");
    this.requireAssumptionInput(input);
    const createdAt = this.clock();
    this.transaction(() => {
      this.append(actor, "assumption.created", {
        ...input,
        createdAt,
        id,
        projectId,
      });
      this.database
        .prepare(
          "INSERT INTO assumptions (id, project_id, statement, owner, confidence, test_method, expires_at, result, result_evidence_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        )
        .run(
          id,
          projectId,
          input.statement,
          input.owner,
          input.confidence,
          input.testMethod,
          input.expiresAt,
          "open",
          createdAt,
        );
    });
    return this.requireAssumption(id);
  }

  recordAssumptionResult(
    actor: Actor,
    assumptionId: string,
    result: Exclude<AssumptionResult, "open">,
    evidenceHash: string,
  ): Assumption {
    const permission = requireHuman(actor, "Assumption result recording");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    if (result !== "validated" && result !== "invalidated") {
      throw new Error("Assumption result is invalid.");
    }
    const assumption = this.requireAssumption(assumptionId);
    if (assumption.result !== "open") {
      throw new Error("An assumption result is immutable.");
    }
    this.requireProjectEvidence(assumption.projectId, evidenceHash);
    this.transaction(() => {
      this.append(actor, "assumption.result.recorded", {
        assumptionId,
        evidenceHash,
        result,
      });
      this.database
        .prepare(
          "UPDATE assumptions SET result = ?, result_evidence_hash = ? WHERE id = ?",
        )
        .run(result, evidenceHash, assumptionId);
    });
    return this.requireAssumption(assumptionId);
  }

  createTradeoff(
    actor: Actor,
    id: string,
    projectId: string,
    question: string,
    yesCase: string,
    noCase: string,
    evidenceHash: string,
  ): TradeoffCard {
    this.requireProject(projectId);
    this.requireIdentifier(id, "Trade-off id");
    this.requireText(question, "Trade-off question");
    this.requireText(yesCase, "Yes case");
    this.requireText(noCase, "No case");
    this.requireProjectEvidence(projectId, evidenceHash);
    const createdAt = this.clock();
    this.transaction(() => {
      this.append(actor, "tradeoff.created", {
        createdAt,
        evidenceHash,
        id,
        noCase,
        projectId,
        question,
        yesCase,
      });
      this.database
        .prepare(
          "INSERT INTO tradeoffs (id, project_id, question, yes_case, no_case, evidence_hash, decision, decision_reason, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)",
        )
        .run(id, projectId, question, yesCase, noCase, evidenceHash, createdAt);
    });
    return this.requireTradeoff(id);
  }

  decideTradeoff(
    actor: Actor,
    tradeoffId: string,
    decision: Exclude<TradeoffDecision, null>,
    reason: string,
  ): TradeoffCard {
    const permission = requireHuman(actor, "Trade-off decision");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    if (!["accept", "reject", "defer"].some((value) => value === decision)) {
      throw new Error("Trade-off decision is invalid.");
    }
    this.requireText(reason, "Trade-off decision reason");
    const tradeoff = this.requireTradeoff(tradeoffId);
    if (tradeoff.decision !== null) {
      throw new Error("A trade-off decision is immutable.");
    }
    const decidedAt = this.clock();
    this.transaction(() => {
      this.append(actor, "tradeoff.decided", {
        decidedAt,
        decision,
        reason,
        tradeoffId,
      });
      this.database
        .prepare(
          "UPDATE tradeoffs SET decision = ?, decision_reason = ?, decided_at = ? WHERE id = ?",
        )
        .run(decision, reason, decidedAt, tradeoffId);
    });
    return this.requireTradeoff(tradeoffId);
  }

  recordDecision(
    actor: Actor,
    id: string,
    projectId: string,
    subject: string,
    outcome: DecisionOutcome,
    reason: string,
    evidenceHash: string,
    supersedesDecisionId: string | null = null,
  ): Decision {
    const permission = requireHuman(actor, "Decision recording");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    this.requireProject(projectId);
    this.requireIdentifier(id, "Decision id");
    this.requireText(subject, "Decision subject");
    this.requireText(reason, "Decision reason");
    if (!decisionOutcomes.some((candidate) => candidate === outcome)) {
      throw new Error("Decision outcome is invalid.");
    }
    this.requireProjectEvidence(projectId, evidenceHash);
    if (supersedesDecisionId !== null) {
      const previous = this.requireDecision(supersedesDecisionId);
      if (previous.projectId !== projectId || previous.supersededBy !== null) {
        throw new Error("The prior decision cannot be superseded.");
      }
    }
    const createdAt = this.clock();
    this.transaction(() => {
      this.append(actor, "decision.recorded", {
        createdAt,
        evidenceHash,
        id,
        outcome,
        projectId,
        reason,
        subject,
        supersedesDecisionId,
      });
      this.database
        .prepare(
          "INSERT INTO decisions (id, project_id, subject, outcome, reason, evidence_hash, supersedes_decision_id, superseded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        )
        .run(
          id,
          projectId,
          subject,
          outcome,
          reason,
          evidenceHash,
          supersedesDecisionId,
          createdAt,
        );
      if (supersedesDecisionId !== null) {
        this.database
          .prepare("UPDATE decisions SET superseded_by = ? WHERE id = ?")
          .run(id, supersedesDecisionId);
      }
    });
    return this.requireDecision(id);
  }

  createMilestone(
    actor: Actor,
    id: string,
    projectId: string,
    input: MilestoneContractInput,
  ): MilestoneContract {
    const permission = requireHuman(actor, "Milestone contract creation");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    this.requireProject(projectId);
    this.requireIdentifier(id, "Milestone id");
    this.requireMilestoneInput(input);
    const createdAt = this.clock();
    this.transaction(() => {
      this.append(actor, "milestone.created", {
        ...input,
        createdAt,
        id,
        projectId,
      });
      this.database
        .prepare(
          "INSERT INTO milestones (id, project_id, user_problem, smallest_useful_result, non_goals_json, acceptance_tests_json, evidence_required_json, risks_json, rollback_condition, human_gate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          projectId,
          input.userProblem,
          input.smallestUsefulResult,
          canonicalJson(input.nonGoals),
          canonicalJson(input.acceptanceTests),
          canonicalJson(input.evidenceRequired),
          canonicalJson(input.risks),
          input.rollbackCondition,
          input.humanGate,
          createdAt,
        );
    });
    return this.requireMilestone(id);
  }

  createShapeBrief(
    actor: Actor,
    id: string,
    projectId: string,
    input: ShapeBriefInput,
  ): ShapeBrief {
    this.requireProject(projectId);
    this.requireIdentifier(id, "Shape brief id");
    this.requireShapeBriefInput(projectId, input);
    const createdAt = this.clock();
    this.transaction(() => {
      this.append(actor, "shape.created", {
        ...input,
        createdAt,
        id,
        projectId,
      });
      this.database
        .prepare(
          "INSERT INTO shape_briefs (id, project_id, idea_id, owner, user_problem, target_user, desired_outcome, evidence_hashes_json, assumption_ids_json, effort_limit, solution_outline, user_journey, non_goals_json, risks_json, open_questions_json, success_criteria_json, scope_expansion_paths_json, rabbit_holes_json, status, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        )
        .run(
          id,
          projectId,
          input.ideaId,
          input.owner,
          input.userProblem,
          input.targetUser,
          input.desiredOutcome,
          canonicalJson(input.evidenceHashes),
          canonicalJson(input.assumptionIds),
          input.effortLimit,
          input.solutionOutline,
          input.userJourney,
          canonicalJson(input.nonGoals),
          canonicalJson(input.risks),
          canonicalJson(input.openQuestions),
          canonicalJson(input.successCriteria),
          canonicalJson(input.scopeExpansionPaths),
          canonicalJson(input.rabbitHoles),
          "draft",
          createdAt,
        );
    });
    return this.requireShapeBrief(id);
  }

  approveShapeBrief(actor: Actor, shapeBriefId: string): ShapeBrief {
    const shape = this.requireShapeBrief(shapeBriefId);
    const permission = requireHuman(actor, "Shape brief approval");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    if (actor.id !== shape.owner) {
      throw new Error("Shape brief approval requires its named human owner.");
    }
    if (shape.status !== "draft") {
      throw new Error("Only a Shape brief draft can be approved.");
    }
    const approvedAt = this.clock();
    this.transaction(() => {
      this.append(actor, "shape.approved", { approvedAt, shapeBriefId });
      this.database
        .prepare(
          "UPDATE shape_briefs SET status = ?, approved_at = ? WHERE id = ?",
        )
        .run("approved", approvedAt, shapeBriefId);
    });
    return this.requireShapeBrief(shapeBriefId);
  }

  createLaunchReadiness(
    actor: Actor,
    id: string,
    projectId: string,
    input: LaunchReadinessInput,
  ): LaunchReadiness {
    this.requireProject(projectId);
    this.requireIdentifier(id, "Launch readiness id");
    this.requireLaunchReadinessInput(projectId, input);
    const createdAt = this.clock();
    this.transaction(() => {
      this.append(actor, "launch-readiness.created", {
        ...input,
        createdAt,
        id,
        projectId,
      });
      this.database
        .prepare(
          "INSERT INTO launch_readiness (id, project_id, shape_brief_id, owner, candidate_evidence_hash, change_note, known_limits_json, support_owner, rollback_procedure, verification_evidence_hashes_json, privacy_security_declaration, release_checklist_json, status, created_at, authorized_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        )
        .run(
          id,
          projectId,
          input.shapeBriefId,
          input.owner,
          input.candidateEvidenceHash,
          input.changeNote,
          canonicalJson(input.knownLimits),
          input.supportOwner,
          input.rollbackProcedure,
          canonicalJson(input.verificationEvidenceHashes),
          input.privacySecurityDeclaration,
          canonicalJson(input.releaseChecklist),
          "draft",
          createdAt,
        );
    });
    return this.requireLaunchReadiness(id);
  }

  authorizeLaunchReadiness(
    actor: Actor,
    launchReadinessId: string,
  ): LaunchReadiness {
    const readiness = this.requireLaunchReadiness(launchReadinessId);
    const permission = requireHuman(actor, "Launch readiness authorization");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    if (actor.id !== readiness.owner) {
      throw new Error(
        "Launch readiness authorization requires its named human owner.",
      );
    }
    if (readiness.status !== "draft") {
      throw new Error(
        "Only a draft launch-readiness record can be authorized.",
      );
    }
    const authorizedAt = this.clock();
    this.transaction(() => {
      this.append(actor, "launch-readiness.authorized", {
        authorizedAt,
        launchReadinessId,
      });
      this.database
        .prepare(
          "UPDATE launch_readiness SET status = ?, authorized_at = ? WHERE id = ?",
        )
        .run("authorized", authorizedAt, launchReadinessId);
    });
    return this.requireLaunchReadiness(launchReadinessId);
  }

  createOutcomeReview(
    actor: Actor,
    id: string,
    projectId: string,
    shapeBriefId: string,
  ): OutcomeReview {
    const permission = requireHuman(actor, "Outcome review creation");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    this.requireProject(projectId);
    this.requireIdentifier(id, "Outcome review id");
    const shape = this.requireShapeBrief(shapeBriefId);
    if (shape.projectId !== projectId) {
      throw new Error("Outcome review Shape brief belongs to another project.");
    }
    const createdAt = this.clock();
    this.transaction(() => {
      this.append(actor, "outcome-review.created", {
        createdAt,
        expectedMeasure: shape.successCriteria,
        id,
        projectId,
        shapeBriefId,
      });
      this.database
        .prepare(
          "INSERT INTO outcome_reviews (id, project_id, shape_brief_id, expected_measure_json, observed_result, changed_assumption, decision, created_at, recorded_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)",
        )
        .run(
          id,
          projectId,
          shapeBriefId,
          canonicalJson(shape.successCriteria),
          createdAt,
        );
    });
    return this.requireOutcomeReview(id);
  }

  recordOutcomeReview(
    actor: Actor,
    outcomeReviewId: string,
    observedResult: string,
    changedAssumption: string,
    decision: Exclude<OutcomeDecision, null>,
  ): OutcomeReview {
    const permission = requireHuman(actor, "Outcome review recording");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    this.requireText(observedResult, "Observed result");
    this.requireText(changedAssumption, "Changed assumption");
    if (!outcomeDecisions.some((value) => value === decision)) {
      throw new Error("Outcome review decision is invalid.");
    }
    const review = this.requireOutcomeReview(outcomeReviewId);
    if (review.recordedAt !== null) {
      throw new Error("An outcome review result is immutable.");
    }
    const recordedAt = this.clock();
    this.transaction(() => {
      this.append(actor, "outcome-review.recorded", {
        changedAssumption,
        decision,
        observedResult,
        outcomeReviewId,
        recordedAt,
      });
      this.database
        .prepare(
          "UPDATE outcome_reviews SET observed_result = ?, changed_assumption = ?, decision = ?, recorded_at = ? WHERE id = ?",
        )
        .run(
          observedResult,
          changedAssumption,
          decision,
          recordedAt,
          outcomeReviewId,
        );
    });
    return this.requireOutcomeReview(outcomeReviewId);
  }

  project(id: string): Project | null {
    const row = this.database
      .prepare(
        "SELECT id, name, description, created_at FROM projects WHERE id = ?",
      )
      .get(id);
    return row === undefined ? null : projectFromRow(row);
  }

  projects(): readonly Project[] {
    return this.database
      .prepare(
        "SELECT id, name, description, created_at FROM projects ORDER BY created_at, id",
      )
      .all()
      .map(projectFromRow);
  }

  compass(id: string): CompassVersion | null {
    const row = this.database
      .prepare(
        "SELECT id, project_id, owner, title, version, status, created_at, approved_at, superseded_by, source_vision_evidence_hash FROM compasses WHERE id = ?",
      )
      .get(id);
    return row === undefined ? null : this.compassFromRow(row);
  }

  compasses(projectId?: string): readonly CompassVersion[] {
    const rows =
      projectId === undefined
        ? this.database
            .prepare(
              "SELECT id, project_id, owner, title, version, status, created_at, approved_at, superseded_by, source_vision_evidence_hash FROM compasses ORDER BY project_id, version, id",
            )
            .all()
        : this.database
            .prepare(
              "SELECT id, project_id, owner, title, version, status, created_at, approved_at, superseded_by, source_vision_evidence_hash FROM compasses WHERE project_id = ? ORDER BY version, id",
            )
            .all(projectId);
    return rows.map((row) => this.compassFromRow(row));
  }

  ideas(projectId?: string): readonly Idea[] {
    const rows =
      projectId === undefined
        ? this.database
            .prepare(
              "SELECT id, project_id, problem, affected_user, expected_result, evidence_hash, assumption, risk, cost_estimate, rejection_reason, expires_at, status, created_at FROM ideas ORDER BY created_at, id",
            )
            .all()
        : this.database
            .prepare(
              "SELECT id, project_id, problem, affected_user, expected_result, evidence_hash, assumption, risk, cost_estimate, rejection_reason, expires_at, status, created_at FROM ideas WHERE project_id = ? ORDER BY created_at, id",
            )
            .all(projectId);
    return rows.map((row) => ({
      id: stringValue(row, "id"),
      projectId: stringValue(row, "project_id"),
      problem: stringValue(row, "problem"),
      affectedUser: stringValue(row, "affected_user"),
      expectedResult: stringValue(row, "expected_result"),
      evidenceHash: stringValue(row, "evidence_hash"),
      assumption: stringValue(row, "assumption"),
      risk: stringValue(row, "risk"),
      costEstimate: stringValue(row, "cost_estimate"),
      rejectionReason: stringValue(row, "rejection_reason"),
      expiresAt: stringValue(row, "expires_at"),
      status: requiredEnum(
        stringValue(row, "status"),
        ideaStatuses,
        "Idea status",
      ),
      createdAt: stringValue(row, "created_at"),
    }));
  }

  assumptions(projectId?: string): readonly Assumption[] {
    const rows =
      projectId === undefined
        ? this.database
            .prepare(
              "SELECT id, project_id, statement, owner, confidence, test_method, expires_at, result, result_evidence_hash, created_at FROM assumptions ORDER BY created_at, id",
            )
            .all()
        : this.database
            .prepare(
              "SELECT id, project_id, statement, owner, confidence, test_method, expires_at, result, result_evidence_hash, created_at FROM assumptions WHERE project_id = ? ORDER BY created_at, id",
            )
            .all(projectId);
    const now = this.clock();
    return rows.map((row) => ({
      id: stringValue(row, "id"),
      projectId: stringValue(row, "project_id"),
      statement: stringValue(row, "statement"),
      owner: stringValue(row, "owner"),
      confidence: requiredEnum(
        stringValue(row, "confidence"),
        assumptionConfidences,
        "Assumption confidence",
      ),
      testMethod: stringValue(row, "test_method"),
      expiresAt: stringValue(row, "expires_at"),
      result: requiredEnum(
        stringValue(row, "result"),
        assumptionResults,
        "Assumption result",
      ),
      resultEvidenceHash: nullableStringValue(row, "result_evidence_hash"),
      expired: stringValue(row, "expires_at") < now,
      createdAt: stringValue(row, "created_at"),
    }));
  }

  tradeoffs(projectId?: string): readonly TradeoffCard[] {
    const rows =
      projectId === undefined
        ? this.database
            .prepare(
              "SELECT id, project_id, question, yes_case, no_case, evidence_hash, decision, decision_reason, decided_at, created_at FROM tradeoffs ORDER BY created_at, id",
            )
            .all()
        : this.database
            .prepare(
              "SELECT id, project_id, question, yes_case, no_case, evidence_hash, decision, decision_reason, decided_at, created_at FROM tradeoffs WHERE project_id = ? ORDER BY created_at, id",
            )
            .all(projectId);
    return rows.map((row) => ({
      id: stringValue(row, "id"),
      projectId: stringValue(row, "project_id"),
      question: stringValue(row, "question"),
      yesCase: stringValue(row, "yes_case"),
      noCase: stringValue(row, "no_case"),
      evidenceHash: stringValue(row, "evidence_hash"),
      decision:
        row.decision === null
          ? null
          : requiredEnum(
              stringValue(row, "decision"),
              tradeoffDecisions,
              "Trade-off decision",
            ),
      decisionReason: nullableStringValue(row, "decision_reason"),
      decidedAt: nullableStringValue(row, "decided_at"),
      createdAt: stringValue(row, "created_at"),
    }));
  }

  decisions(projectId?: string): readonly Decision[] {
    const rows =
      projectId === undefined
        ? this.database
            .prepare(
              "SELECT id, project_id, subject, outcome, reason, evidence_hash, supersedes_decision_id, superseded_by, created_at FROM decisions ORDER BY created_at, id",
            )
            .all()
        : this.database
            .prepare(
              "SELECT id, project_id, subject, outcome, reason, evidence_hash, supersedes_decision_id, superseded_by, created_at FROM decisions WHERE project_id = ? ORDER BY created_at, id",
            )
            .all(projectId);
    return rows.map((row) => ({
      id: stringValue(row, "id"),
      projectId: stringValue(row, "project_id"),
      subject: stringValue(row, "subject"),
      outcome: requiredEnum(
        stringValue(row, "outcome"),
        decisionOutcomes,
        "Decision outcome",
      ),
      reason: stringValue(row, "reason"),
      evidenceHash: stringValue(row, "evidence_hash"),
      supersedesDecisionId: nullableStringValue(row, "supersedes_decision_id"),
      supersededBy: nullableStringValue(row, "superseded_by"),
      createdAt: stringValue(row, "created_at"),
    }));
  }

  milestones(projectId?: string): readonly MilestoneContract[] {
    const rows =
      projectId === undefined
        ? this.database
            .prepare(
              "SELECT id, project_id, user_problem, smallest_useful_result, non_goals_json, acceptance_tests_json, evidence_required_json, risks_json, rollback_condition, human_gate, created_at FROM milestones ORDER BY created_at, id",
            )
            .all()
        : this.database
            .prepare(
              "SELECT id, project_id, user_problem, smallest_useful_result, non_goals_json, acceptance_tests_json, evidence_required_json, risks_json, rollback_condition, human_gate, created_at FROM milestones WHERE project_id = ? ORDER BY created_at, id",
            )
            .all(projectId);
    return rows.map((row) => ({
      id: stringValue(row, "id"),
      projectId: stringValue(row, "project_id"),
      userProblem: stringValue(row, "user_problem"),
      smallestUsefulResult: stringValue(row, "smallest_useful_result"),
      nonGoals: this.parseStringList(stringValue(row, "non_goals_json")),
      acceptanceTests: this.parseStringList(
        stringValue(row, "acceptance_tests_json"),
      ),
      evidenceRequired: this.parseStringList(
        stringValue(row, "evidence_required_json"),
      ),
      risks: this.parseStringList(stringValue(row, "risks_json")),
      rollbackCondition: stringValue(row, "rollback_condition"),
      humanGate: stringValue(row, "human_gate"),
      createdAt: stringValue(row, "created_at"),
    }));
  }

  shapeBriefs(projectId?: string): readonly ShapeBrief[] {
    const rows =
      projectId === undefined
        ? this.database
            .prepare(
              "SELECT id, project_id, idea_id, owner, user_problem, target_user, desired_outcome, evidence_hashes_json, assumption_ids_json, effort_limit, solution_outline, user_journey, non_goals_json, risks_json, open_questions_json, success_criteria_json, scope_expansion_paths_json, rabbit_holes_json, status, created_at, approved_at FROM shape_briefs ORDER BY created_at, id",
            )
            .all()
        : this.database
            .prepare(
              "SELECT id, project_id, idea_id, owner, user_problem, target_user, desired_outcome, evidence_hashes_json, assumption_ids_json, effort_limit, solution_outline, user_journey, non_goals_json, risks_json, open_questions_json, success_criteria_json, scope_expansion_paths_json, rabbit_holes_json, status, created_at, approved_at FROM shape_briefs WHERE project_id = ? ORDER BY created_at, id",
            )
            .all(projectId);
    return rows.map((row) => this.shapeBriefFromRow(row));
  }

  launchReadinessRecords(projectId?: string): readonly LaunchReadiness[] {
    const rows =
      projectId === undefined
        ? this.database
            .prepare(
              "SELECT id, project_id, shape_brief_id, owner, candidate_evidence_hash, change_note, known_limits_json, support_owner, rollback_procedure, verification_evidence_hashes_json, privacy_security_declaration, release_checklist_json, status, created_at, authorized_at FROM launch_readiness ORDER BY created_at, id",
            )
            .all()
        : this.database
            .prepare(
              "SELECT id, project_id, shape_brief_id, owner, candidate_evidence_hash, change_note, known_limits_json, support_owner, rollback_procedure, verification_evidence_hashes_json, privacy_security_declaration, release_checklist_json, status, created_at, authorized_at FROM launch_readiness WHERE project_id = ? ORDER BY created_at, id",
            )
            .all(projectId);
    return rows.map((row) => this.launchReadinessFromRow(row));
  }

  outcomeReviews(projectId?: string): readonly OutcomeReview[] {
    const rows =
      projectId === undefined
        ? this.database
            .prepare(
              "SELECT id, project_id, shape_brief_id, expected_measure_json, observed_result, changed_assumption, decision, created_at, recorded_at FROM outcome_reviews ORDER BY created_at, id",
            )
            .all()
        : this.database
            .prepare(
              "SELECT id, project_id, shape_brief_id, expected_measure_json, observed_result, changed_assumption, decision, created_at, recorded_at FROM outcome_reviews WHERE project_id = ? ORDER BY created_at, id",
            )
            .all(projectId);
    return rows.map((row) => this.outcomeReviewFromRow(row));
  }

  compassSnapshot(projectId?: string): CompassSnapshot {
    return {
      assumptions: this.assumptions(projectId),
      compasses: this.compasses(projectId),
      decisions: this.decisions(projectId),
      ideas: this.ideas(projectId),
      launchReadiness: this.launchReadinessRecords(projectId),
      milestones: this.milestones(projectId),
      outcomeReviews: this.outcomeReviews(projectId),
      shapeBriefs: this.shapeBriefs(projectId),
      tradeoffs: this.tradeoffs(projectId),
    };
  }

  work(id: string): WorkItem | null {
    const row = this.database
      .prepare(
        "SELECT id, project_id, title, status, claimant, mandate_evidence_hash, created_at, updated_at FROM work_items WHERE id = ?",
      )
      .get(id);
    return row === undefined ? null : workFromRow(row);
  }

  workItems(): readonly WorkItem[] {
    return this.database
      .prepare(
        "SELECT id, project_id, title, status, claimant, mandate_evidence_hash, created_at, updated_at FROM work_items ORDER BY updated_at DESC, id",
      )
      .all()
      .map(workFromRow);
  }

  workEvidence(workId: string): readonly WorkEvidenceReference[] {
    this.requireWork(workId);
    return this.database
      .prepare(
        "SELECT evidence.sha256 AS sha256, evidence.bytes AS bytes, 'mandate' AS kind FROM work_items INNER JOIN evidence ON evidence.sha256 = work_items.mandate_evidence_hash WHERE work_items.id = ? UNION ALL SELECT evidence.sha256 AS sha256, evidence.bytes AS bytes, work_evidence.kind AS kind FROM work_evidence INNER JOIN evidence ON evidence.sha256 = work_evidence.evidence_hash WHERE work_evidence.work_id = ? ORDER BY kind, sha256",
      )
      .all(workId, workId)
      .map((row) => {
        const hash = stringValue(row, "sha256");
        return {
          sha256: hash,
          bytes: numberValue(row, "bytes"),
          path: `evidence/sha256/${hash}`,
          kind: stringValue(row, "kind"),
        };
      });
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
    const eventText = eventLines.length === 0 ? "" : `${eventLines}\n`;
    const evidence = this.evidenceReferences();
    for (const reference of evidence) {
      writeFileSync(
        join(target, "evidence", "sha256", reference.sha256),
        readFileSync(evidencePath(this.root, reference.sha256)),
      );
    }
    writeFileSync(join(target, "events.ndjson"), eventText);
    const manifest: ExportManifest = {
      schemaVersion: "workstream-bundle/0.1",
      createdAt: this.clock(),
      eventsSha256: sha256(eventText),
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
    if (sha256(eventText) !== manifest.eventsSha256) {
      throw new Error("Bundle events do not match the manifest digest.");
    }
    if (eventText !== "" && !eventText.endsWith("\n")) {
      throw new Error("Bundle events must use newline-delimited records.");
    }
    const eventLines =
      eventText === ""
        ? []
        : eventText.slice(0, Math.max(0, eventText.length - 1)).split("\n");
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

  private createCompassDraft(
    actor: Actor,
    id: string,
    projectId: string,
    input: CompassDraftInput,
    sourceVisionEvidenceHash: string | null,
  ): CompassVersion {
    const permission = requireHuman(actor, "Compass creation");
    if (permission.kind === "error") {
      throw new Error(permission.message);
    }
    this.requireProject(projectId);
    this.requireIdentifier(id, "Compass id");
    this.requireText(input.title, "Compass title");
    this.requireText(input.owner, "Compass owner");
    this.requireStatements(projectId, input.principles, "principles");
    this.requireStatements(projectId, input.nonGoals, "non-goals");
    if (sourceVisionEvidenceHash !== null) {
      this.requireProjectEvidence(projectId, sourceVisionEvidenceHash);
    }
    const version = this.nextCompassVersion(projectId);
    const createdAt = this.clock();
    this.transaction(() => {
      this.append(actor, "compass.created", {
        createdAt,
        id,
        nonGoals: input.nonGoals,
        owner: input.owner,
        principles: input.principles,
        projectId,
        sourceVisionEvidenceHash,
        title: input.title,
        version,
      });
      this.database
        .prepare(
          "INSERT INTO compasses (id, project_id, owner, title, version, status, created_at, approved_at, superseded_by, source_vision_evidence_hash) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
        )
        .run(
          id,
          projectId,
          input.owner,
          input.title,
          version,
          "draft",
          createdAt,
          sourceVisionEvidenceHash,
        );
      this.insertCompassStatements(id, "principle", input.principles);
      this.insertCompassStatements(id, "non-goal", input.nonGoals);
    });
    return this.requireCompass(id);
  }

  private compassFromRow(row: SqlRow): CompassVersion {
    const id = stringValue(row, "id");
    const statements = this.database
      .prepare(
        "SELECT statement_id, statement_text, evidence_hash, kind FROM compass_statements WHERE compass_id = ? ORDER BY kind, statement_id",
      )
      .all(id);
    return {
      id,
      projectId: stringValue(row, "project_id"),
      owner: stringValue(row, "owner"),
      title: stringValue(row, "title"),
      version: numberValue(row, "version"),
      status: requiredEnum(
        stringValue(row, "status"),
        compassStatuses,
        "Compass status",
      ),
      createdAt: stringValue(row, "created_at"),
      approvedAt: nullableStringValue(row, "approved_at"),
      supersededBy: nullableStringValue(row, "superseded_by"),
      sourceVisionEvidenceHash: nullableStringValue(
        row,
        "source_vision_evidence_hash",
      ),
      principles: statementsFromRows(
        statements.filter(
          (statement) => stringValue(statement, "kind") === "principle",
        ),
      ),
      nonGoals: statementsFromRows(
        statements.filter(
          (statement) => stringValue(statement, "kind") === "non-goal",
        ),
      ),
    };
  }

  private activeCompass(projectId: string): CompassVersion | null {
    const row = this.database
      .prepare(
        "SELECT id, project_id, owner, title, version, status, created_at, approved_at, superseded_by, source_vision_evidence_hash FROM compasses WHERE project_id = ? AND status = ?",
      )
      .get(projectId, "approved");
    return row === undefined ? null : this.compassFromRow(row);
  }

  private requireCompass(id: string): CompassVersion {
    const compass = this.compass(id);
    if (compass === null) {
      throw new Error(`Compass ${id} does not exist.`);
    }
    return compass;
  }

  private requireProject(id: string): Project {
    const project = this.project(id);
    if (project === null) {
      throw new Error(`Project ${id} does not exist.`);
    }
    return project;
  }

  private requireIdea(id: string): Idea {
    const idea = this.ideas().find((candidate) => candidate.id === id);
    if (idea === undefined) {
      throw new Error(`Idea ${id} does not exist.`);
    }
    return idea;
  }

  private requireAssumption(id: string): Assumption {
    const assumption = this.assumptions().find(
      (candidate) => candidate.id === id,
    );
    if (assumption === undefined) {
      throw new Error(`Assumption ${id} does not exist.`);
    }
    return assumption;
  }

  private requireTradeoff(id: string): TradeoffCard {
    const tradeoff = this.tradeoffs().find((candidate) => candidate.id === id);
    if (tradeoff === undefined) {
      throw new Error(`Trade-off ${id} does not exist.`);
    }
    return tradeoff;
  }

  private requireDecision(id: string): Decision {
    const decision = this.decisions().find((candidate) => candidate.id === id);
    if (decision === undefined) {
      throw new Error(`Decision ${id} does not exist.`);
    }
    return decision;
  }

  private requireMilestone(id: string): MilestoneContract {
    const milestone = this.milestones().find(
      (candidate) => candidate.id === id,
    );
    if (milestone === undefined) {
      throw new Error(`Milestone ${id} does not exist.`);
    }
    return milestone;
  }

  private shapeBriefFromRow(row: SqlRow): ShapeBrief {
    return {
      id: stringValue(row, "id"),
      projectId: stringValue(row, "project_id"),
      ideaId: stringValue(row, "idea_id"),
      owner: stringValue(row, "owner"),
      userProblem: stringValue(row, "user_problem"),
      targetUser: stringValue(row, "target_user"),
      desiredOutcome: stringValue(row, "desired_outcome"),
      evidenceHashes: this.parseStringList(
        stringValue(row, "evidence_hashes_json"),
      ),
      assumptionIds: this.parseStringList(
        stringValue(row, "assumption_ids_json"),
      ),
      effortLimit: stringValue(row, "effort_limit"),
      solutionOutline: stringValue(row, "solution_outline"),
      userJourney: stringValue(row, "user_journey"),
      nonGoals: this.parseStringList(stringValue(row, "non_goals_json")),
      risks: this.parseStringList(stringValue(row, "risks_json")),
      openQuestions: this.parseStringList(
        stringValue(row, "open_questions_json"),
      ),
      successCriteria: this.parseStringList(
        stringValue(row, "success_criteria_json"),
      ),
      scopeExpansionPaths: this.parseStringList(
        stringValue(row, "scope_expansion_paths_json"),
      ),
      rabbitHoles: this.parseStringList(stringValue(row, "rabbit_holes_json")),
      status: requiredEnum(
        stringValue(row, "status"),
        shapeBriefStatuses,
        "Shape brief status",
      ),
      createdAt: stringValue(row, "created_at"),
      approvedAt: nullableStringValue(row, "approved_at"),
    };
  }

  private requireShapeBrief(id: string): ShapeBrief {
    const shape = this.shapeBriefs().find((candidate) => candidate.id === id);
    if (shape === undefined) {
      throw new Error(`Shape brief ${id} does not exist.`);
    }
    return shape;
  }

  private launchReadinessFromRow(row: SqlRow): LaunchReadiness {
    return {
      id: stringValue(row, "id"),
      projectId: stringValue(row, "project_id"),
      shapeBriefId: stringValue(row, "shape_brief_id"),
      owner: stringValue(row, "owner"),
      candidateEvidenceHash: stringValue(row, "candidate_evidence_hash"),
      changeNote: stringValue(row, "change_note"),
      knownLimits: this.parseStringList(stringValue(row, "known_limits_json")),
      supportOwner: stringValue(row, "support_owner"),
      rollbackProcedure: stringValue(row, "rollback_procedure"),
      verificationEvidenceHashes: this.parseStringList(
        stringValue(row, "verification_evidence_hashes_json"),
      ),
      privacySecurityDeclaration: stringValue(
        row,
        "privacy_security_declaration",
      ),
      releaseChecklist: this.parseStringList(
        stringValue(row, "release_checklist_json"),
      ),
      status: requiredEnum(
        stringValue(row, "status"),
        launchReadinessStatuses,
        "Launch readiness status",
      ),
      createdAt: stringValue(row, "created_at"),
      authorizedAt: nullableStringValue(row, "authorized_at"),
    };
  }

  private requireLaunchReadiness(id: string): LaunchReadiness {
    const readiness = this.launchReadinessRecords().find(
      (candidate) => candidate.id === id,
    );
    if (readiness === undefined) {
      throw new Error(`Launch readiness ${id} does not exist.`);
    }
    return readiness;
  }

  private outcomeReviewFromRow(row: SqlRow): OutcomeReview {
    const decision = nullableStringValue(row, "decision");
    return {
      id: stringValue(row, "id"),
      projectId: stringValue(row, "project_id"),
      shapeBriefId: stringValue(row, "shape_brief_id"),
      expectedMeasure: this.parseStringList(
        stringValue(row, "expected_measure_json"),
      ),
      observedResult: nullableStringValue(row, "observed_result"),
      changedAssumption: nullableStringValue(row, "changed_assumption"),
      decision:
        decision === null
          ? null
          : requiredEnum(decision, outcomeDecisions, "Outcome review decision"),
      createdAt: stringValue(row, "created_at"),
      recordedAt: nullableStringValue(row, "recorded_at"),
    };
  }

  private requireOutcomeReview(id: string): OutcomeReview {
    const review = this.outcomeReviews().find(
      (candidate) => candidate.id === id,
    );
    if (review === undefined) {
      throw new Error(`Outcome review ${id} does not exist.`);
    }
    return review;
  }

  private nextCompassVersion(projectId: string): number {
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM compasses WHERE project_id = ?",
      )
      .get(projectId);
    if (row === undefined) {
      throw new Error("Compass version projection is unavailable.");
    }
    return numberValue(row, "version") + 1;
  }

  private insertCompassStatements(
    compassId: string,
    kind: "principle" | "non-goal",
    statements: readonly CompassStatement[],
  ): void {
    const insert = this.database.prepare(
      "INSERT INTO compass_statements (compass_id, kind, statement_id, statement_text, evidence_hash) VALUES (?, ?, ?, ?, ?)",
    );
    for (const statement of statements) {
      insert.run(
        compassId,
        kind,
        statement.id,
        statement.text,
        statement.evidenceHash,
      );
    }
  }

  private requireStatements(
    projectId: string,
    statements: readonly CompassStatement[],
    label: string,
  ): void {
    if (statements.length === 0) {
      throw new Error(`Compass ${label} must not be empty.`);
    }
    const ids = new Set<string>();
    for (const statement of statements) {
      this.requireIdentifier(statement.id, "Compass statement id");
      this.requireText(statement.text, "Compass statement text");
      if (ids.has(statement.id)) {
        throw new Error("Compass statement ids must be unique.");
      }
      ids.add(statement.id);
      this.requireProjectEvidence(projectId, statement.evidenceHash);
    }
  }

  private requireProjectEvidence(projectId: string, hash: string): void {
    this.requireEvidence(hash);
    const row = this.database
      .prepare(
        "SELECT evidence_hash FROM project_evidence WHERE project_id = ? AND evidence_hash = ?",
      )
      .get(projectId, hash);
    if (row === undefined) {
      throw new Error(
        `Evidence ${hash} is not linked to project ${projectId}.`,
      );
    }
  }

  private requireIdeaInput(projectId: string, input: IdeaInput): void {
    this.requireText(input.problem, "Idea problem");
    this.requireText(input.affectedUser, "Idea affected user");
    this.requireText(input.expectedResult, "Idea expected result");
    this.requireText(input.assumption, "Idea assumption");
    this.requireText(input.risk, "Idea risk");
    this.requireText(input.costEstimate, "Idea cost estimate");
    this.requireText(input.rejectionReason, "Idea rejection reason");
    this.requireTimestamp(input.expiresAt, "Idea expiry");
    this.requireProjectEvidence(projectId, input.evidenceHash);
  }

  private requireAssumptionInput(input: AssumptionInput): void {
    this.requireText(input.statement, "Assumption statement");
    this.requireText(input.owner, "Assumption owner");
    if (!assumptionConfidences.some((value) => value === input.confidence)) {
      throw new Error("Assumption confidence is invalid.");
    }
    this.requireText(input.testMethod, "Assumption test method");
    this.requireTimestamp(input.expiresAt, "Assumption expiry");
  }

  private requireMilestoneInput(input: MilestoneContractInput): void {
    this.requireText(input.userProblem, "Milestone user problem");
    this.requireText(
      input.smallestUsefulResult,
      "Milestone smallest useful result",
    );
    this.requireText(input.rollbackCondition, "Milestone rollback condition");
    this.requireText(input.humanGate, "Milestone human gate");
    const lists = new Map<string, readonly string[]>([
      ["Milestone non-goals", input.nonGoals],
      ["Milestone acceptance tests", input.acceptanceTests],
      ["Milestone evidence required", input.evidenceRequired],
      ["Milestone risks", input.risks],
    ]);
    for (const [label, values] of lists) {
      if (values === undefined || values.length === 0) {
        throw new Error(`${label} must not be empty.`);
      }
      for (const value of values) {
        this.requireText(value, label);
      }
    }
  }

  private requireShapeBriefInput(
    projectId: string,
    input: ShapeBriefInput,
  ): void {
    this.requireIdentifier(input.ideaId, "Selected idea id");
    const idea = this.requireIdea(input.ideaId);
    if (idea.projectId !== projectId || idea.status !== "shaped") {
      throw new Error("Shape brief requires a human-selected project idea.");
    }
    this.requireText(input.owner, "Shape brief owner");
    const textFields = new Map<string, string>([
      ["Shape brief user problem", input.userProblem],
      ["Shape brief target user", input.targetUser],
      ["Shape brief desired outcome", input.desiredOutcome],
      ["Shape brief effort limit", input.effortLimit],
      ["Shape brief solution outline", input.solutionOutline],
      ["Shape brief user journey", input.userJourney],
    ]);
    for (const [label, value] of textFields) {
      this.requireText(value, label);
    }
    this.requireTextList(input.evidenceHashes, "Shape brief evidence links");
    for (const hash of input.evidenceHashes) {
      this.requireProjectEvidence(projectId, hash);
    }
    this.requireTextList(input.assumptionIds, "Shape brief assumptions");
    for (const assumptionId of input.assumptionIds) {
      const assumption = this.requireAssumption(assumptionId);
      if (assumption.projectId !== projectId) {
        throw new Error("Shape brief assumption belongs to another project.");
      }
    }
    const lists = new Map<string, readonly string[]>([
      ["Shape brief non-goals", input.nonGoals],
      ["Shape brief risks", input.risks],
      ["Shape brief open questions", input.openQuestions],
      ["Shape brief success criteria", input.successCriteria],
      ["Shape brief scope-expansion paths", input.scopeExpansionPaths],
      ["Shape brief rabbit holes", input.rabbitHoles],
    ]);
    for (const [label, values] of lists) {
      this.requireTextList(values, label);
    }
  }

  private requireLaunchReadinessInput(
    projectId: string,
    input: LaunchReadinessInput,
  ): void {
    this.requireIdentifier(
      input.shapeBriefId,
      "Launch readiness Shape brief id",
    );
    const shape = this.requireShapeBrief(input.shapeBriefId);
    if (shape.projectId !== projectId || shape.status !== "approved") {
      throw new Error(
        "Launch readiness requires an approved project Shape brief.",
      );
    }
    this.requireText(input.owner, "Launch readiness owner");
    this.requireProjectEvidence(projectId, input.candidateEvidenceHash);
    const textFields = new Map<string, string>([
      ["Launch readiness change note", input.changeNote],
      ["Launch readiness support owner", input.supportOwner],
      ["Launch readiness rollback procedure", input.rollbackProcedure],
      [
        "Launch readiness privacy and security declaration",
        input.privacySecurityDeclaration,
      ],
    ]);
    for (const [label, value] of textFields) {
      this.requireText(value, label);
    }
    this.requireTextList(input.knownLimits, "Launch readiness known limits");
    this.requireTextList(
      input.verificationEvidenceHashes,
      "Launch readiness verification evidence",
    );
    for (const hash of input.verificationEvidenceHashes) {
      this.requireProjectEvidence(projectId, hash);
    }
    this.requireTextList(
      input.releaseChecklist,
      "Launch readiness release checklist",
    );
  }

  private requireTextList(values: readonly string[], label: string): void {
    if (values.length === 0) {
      throw new Error(`${label} must not be empty.`);
    }
    for (const value of values) {
      this.requireText(value, label);
    }
  }

  private requireTimestamp(value: string, label: string): void {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
      throw new Error(`${label} must use an ISO-8601 UTC timestamp.`);
    }
  }

  private parseStringList(value: string): readonly string[] {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== "string")
    ) {
      throw new Error("Milestone list projection is malformed.");
    }
    return parsed;
  }

  private renderVision(compass: CompassVersion): string {
    const renderStatements = (
      title: string,
      statements: readonly CompassStatement[],
    ): string =>
      `## ${title}\n\n${statements
        .map(
          (statement) =>
            `- ${statement.text}\n  - Evidence: sha256:${statement.evidenceHash}`,
        )
        .join("\n")}\n`;
    return [
      "<!-- workstream-vision/0.1 -->",
      `<!-- project: ${compass.projectId}; compass: ${compass.id}; version: ${compass.version} -->`,
      `# ${compass.title}`,
      "",
      "Generated local Compass projection. The ledger remains the source of truth.",
      "",
      "## Owner",
      "",
      compass.owner,
      "",
      renderStatements("Principles", compass.principles).trimEnd(),
      "",
      renderStatements("Non-goals", compass.nonGoals).trimEnd(),
      "",
    ].join("\n");
  }

  private parseVision(value: string): {
    readonly title: string;
    readonly principles: readonly string[];
    readonly nonGoals: readonly string[];
  } {
    if (!value.startsWith("<!-- workstream-vision/0.1 -->\n")) {
      throw new Error(
        "VISION.md is not a generated workstream vision projection.",
      );
    }
    const title = /^# (.+)$/mu.exec(value)?.[1]?.trim();
    const section = (name: string): readonly string[] => {
      const expression = new RegExp(
        `^## ${name}\\n\\n([\\s\\S]*?)(?=^## |$)`,
        "mu",
      );
      const content = expression.exec(value)?.[1] ?? "";
      return content
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).trim())
        .filter((line) => line.length > 0);
    };
    const principles = section("Principles");
    const nonGoals = section("Non-goals");
    if (
      title === undefined ||
      title.length === 0 ||
      principles.length === 0 ||
      nonGoals.length === 0
    ) {
      throw new Error(
        "VISION.md is missing a title, principles, or non-goals.",
      );
    }
    return { title, principles, nonGoals };
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
      CREATE TABLE IF NOT EXISTS project_evidence (
        project_id TEXT NOT NULL REFERENCES projects(id),
        evidence_hash TEXT NOT NULL REFERENCES evidence(sha256),
        kind TEXT NOT NULL,
        PRIMARY KEY (project_id, evidence_hash, kind)
      );
      CREATE TABLE IF NOT EXISTS compasses (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        owner TEXT NOT NULL,
        title TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        superseded_by TEXT UNIQUE,
        source_vision_evidence_hash TEXT REFERENCES evidence(sha256),
        UNIQUE (project_id, version)
      );
      CREATE TABLE IF NOT EXISTS compass_statements (
        compass_id TEXT NOT NULL REFERENCES compasses(id),
        kind TEXT NOT NULL,
        statement_id TEXT NOT NULL,
        statement_text TEXT NOT NULL,
        evidence_hash TEXT NOT NULL REFERENCES evidence(sha256),
        PRIMARY KEY (compass_id, kind, statement_id)
      );
      CREATE TABLE IF NOT EXISTS ideas (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        problem TEXT NOT NULL,
        affected_user TEXT NOT NULL,
        expected_result TEXT NOT NULL,
        evidence_hash TEXT NOT NULL REFERENCES evidence(sha256),
        assumption TEXT NOT NULL,
        risk TEXT NOT NULL,
        cost_estimate TEXT NOT NULL,
        rejection_reason TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assumptions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        statement TEXT NOT NULL,
        owner TEXT NOT NULL,
        confidence TEXT NOT NULL,
        test_method TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        result TEXT NOT NULL,
        result_evidence_hash TEXT REFERENCES evidence(sha256),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tradeoffs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        question TEXT NOT NULL,
        yes_case TEXT NOT NULL,
        no_case TEXT NOT NULL,
        evidence_hash TEXT NOT NULL REFERENCES evidence(sha256),
        decision TEXT,
        decision_reason TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        subject TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_hash TEXT NOT NULL REFERENCES evidence(sha256),
        supersedes_decision_id TEXT REFERENCES decisions(id),
        superseded_by TEXT UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        user_problem TEXT NOT NULL,
        smallest_useful_result TEXT NOT NULL,
        non_goals_json TEXT NOT NULL,
        acceptance_tests_json TEXT NOT NULL,
        evidence_required_json TEXT NOT NULL,
        risks_json TEXT NOT NULL,
        rollback_condition TEXT NOT NULL,
        human_gate TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shape_briefs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        idea_id TEXT NOT NULL REFERENCES ideas(id),
        owner TEXT NOT NULL,
        user_problem TEXT NOT NULL,
        target_user TEXT NOT NULL,
        desired_outcome TEXT NOT NULL,
        evidence_hashes_json TEXT NOT NULL,
        assumption_ids_json TEXT NOT NULL,
        effort_limit TEXT NOT NULL,
        solution_outline TEXT NOT NULL,
        user_journey TEXT NOT NULL,
        non_goals_json TEXT NOT NULL,
        risks_json TEXT NOT NULL,
        open_questions_json TEXT NOT NULL,
        success_criteria_json TEXT NOT NULL,
        scope_expansion_paths_json TEXT NOT NULL,
        rabbit_holes_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS launch_readiness (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        shape_brief_id TEXT NOT NULL REFERENCES shape_briefs(id),
        owner TEXT NOT NULL,
        candidate_evidence_hash TEXT NOT NULL REFERENCES evidence(sha256),
        change_note TEXT NOT NULL,
        known_limits_json TEXT NOT NULL,
        support_owner TEXT NOT NULL,
        rollback_procedure TEXT NOT NULL,
        verification_evidence_hashes_json TEXT NOT NULL,
        privacy_security_declaration TEXT NOT NULL,
        release_checklist_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        authorized_at TEXT
      );
      CREATE TABLE IF NOT EXISTS outcome_reviews (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        shape_brief_id TEXT NOT NULL REFERENCES shape_briefs(id),
        expected_measure_json TEXT NOT NULL,
        observed_result TEXT,
        changed_assumption TEXT,
        decision TEXT,
        created_at TEXT NOT NULL,
        recorded_at TEXT
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

  private optionalText(
    payload: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = payload[key];
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `Event payload ${key} must be a non-empty string or null.`,
      );
    }
    return value;
  }

  private requirePayloadNumber(
    payload: Record<string, unknown>,
    key: string,
  ): number {
    const value = payload[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`Event payload ${key} must be a positive integer.`);
    }
    return value;
  }

  private requireStringPayload(
    payload: Record<string, unknown>,
    key: string,
  ): readonly string[] {
    const value = payload[key];
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`Event payload ${key} must be a non-empty string list.`);
    }
    const strings: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || item.length === 0) {
        throw new Error(`Event payload ${key} contains invalid text.`);
      }
      strings.push(item);
    }
    return strings;
  }

  private requireStatementPayload(
    payload: Record<string, unknown>,
    key: string,
  ): readonly CompassStatement[] {
    const value = payload[key];
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(
        `Event payload ${key} must be a non-empty statement list.`,
      );
    }
    const statements: CompassStatement[] = [];
    for (const entry of value) {
      if (!isRecord(entry)) {
        throw new Error(`Event payload ${key} has an invalid statement.`);
      }
      const id = entry.id;
      const text = entry.text;
      const evidenceHash = entry.evidenceHash;
      if (
        typeof id !== "string" ||
        typeof text !== "string" ||
        typeof evidenceHash !== "string" ||
        !isSha256(evidenceHash)
      ) {
        throw new Error(`Event payload ${key} has an invalid statement.`);
      }
      statements.push({ id, text, evidenceHash });
    }
    return statements;
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
    if (event.type === "project.evidence.attached") {
      this.database
        .prepare(
          "INSERT INTO project_evidence (project_id, evidence_hash, kind) VALUES (?, ?, ?)",
        )
        .run(
          requireText(payload, "projectId"),
          requireText(payload, "evidenceHash"),
          requireText(payload, "kind"),
        );
      return;
    }
    if (event.type === "compass.created") {
      const projectId = requireText(payload, "projectId");
      const id = requireText(payload, "id");
      const sourceVisionEvidenceHash = this.optionalText(
        payload,
        "sourceVisionEvidenceHash",
      );
      this.database
        .prepare(
          "INSERT INTO compasses (id, project_id, owner, title, version, status, created_at, approved_at, superseded_by, source_vision_evidence_hash) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
        )
        .run(
          id,
          projectId,
          requireText(payload, "owner"),
          requireText(payload, "title"),
          this.requirePayloadNumber(payload, "version"),
          "draft",
          requireText(payload, "createdAt"),
          sourceVisionEvidenceHash,
        );
      this.insertCompassStatements(
        id,
        "principle",
        this.requireStatementPayload(payload, "principles"),
      );
      this.insertCompassStatements(
        id,
        "non-goal",
        this.requireStatementPayload(payload, "nonGoals"),
      );
      return;
    }
    if (event.type === "compass.approved") {
      this.database
        .prepare(
          "UPDATE compasses SET status = ?, approved_at = ? WHERE id = ?",
        )
        .run(
          "approved",
          requireText(payload, "approvedAt"),
          requireText(payload, "compassId"),
        );
      return;
    }
    if (event.type === "compass.superseded") {
      this.database
        .prepare(
          "UPDATE compasses SET status = ?, superseded_by = ? WHERE id = ?",
        )
        .run(
          "superseded",
          requireText(payload, "supersededBy"),
          requireText(payload, "compassId"),
        );
      return;
    }
    if (event.type === "vision.imported") {
      return;
    }
    if (event.type === "idea.created") {
      this.database
        .prepare(
          "INSERT INTO ideas (id, project_id, problem, affected_user, expected_result, evidence_hash, assumption, risk, cost_estimate, rejection_reason, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          requireText(payload, "id"),
          requireText(payload, "projectId"),
          requireText(payload, "problem"),
          requireText(payload, "affectedUser"),
          requireText(payload, "expectedResult"),
          requireText(payload, "evidenceHash"),
          requireText(payload, "assumption"),
          requireText(payload, "risk"),
          requireText(payload, "costEstimate"),
          requireText(payload, "rejectionReason"),
          requireText(payload, "expiresAt"),
          "inbox",
          requireText(payload, "createdAt"),
        );
      return;
    }
    if (event.type === "idea.reviewed") {
      this.database
        .prepare("UPDATE ideas SET status = ? WHERE id = ?")
        .run(requireText(payload, "status"), requireText(payload, "ideaId"));
      return;
    }
    if (event.type === "assumption.created") {
      this.database
        .prepare(
          "INSERT INTO assumptions (id, project_id, statement, owner, confidence, test_method, expires_at, result, result_evidence_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        )
        .run(
          requireText(payload, "id"),
          requireText(payload, "projectId"),
          requireText(payload, "statement"),
          requireText(payload, "owner"),
          requireText(payload, "confidence"),
          requireText(payload, "testMethod"),
          requireText(payload, "expiresAt"),
          "open",
          requireText(payload, "createdAt"),
        );
      return;
    }
    if (event.type === "assumption.result.recorded") {
      this.database
        .prepare(
          "UPDATE assumptions SET result = ?, result_evidence_hash = ? WHERE id = ?",
        )
        .run(
          requireText(payload, "result"),
          requireText(payload, "evidenceHash"),
          requireText(payload, "assumptionId"),
        );
      return;
    }
    if (event.type === "tradeoff.created") {
      this.database
        .prepare(
          "INSERT INTO tradeoffs (id, project_id, question, yes_case, no_case, evidence_hash, decision, decision_reason, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)",
        )
        .run(
          requireText(payload, "id"),
          requireText(payload, "projectId"),
          requireText(payload, "question"),
          requireText(payload, "yesCase"),
          requireText(payload, "noCase"),
          requireText(payload, "evidenceHash"),
          requireText(payload, "createdAt"),
        );
      return;
    }
    if (event.type === "tradeoff.decided") {
      this.database
        .prepare(
          "UPDATE tradeoffs SET decision = ?, decision_reason = ?, decided_at = ? WHERE id = ?",
        )
        .run(
          requireText(payload, "decision"),
          requireText(payload, "reason"),
          requireText(payload, "decidedAt"),
          requireText(payload, "tradeoffId"),
        );
      return;
    }
    if (event.type === "decision.recorded") {
      const supersedesDecisionId = this.optionalText(
        payload,
        "supersedesDecisionId",
      );
      const id = requireText(payload, "id");
      this.database
        .prepare(
          "INSERT INTO decisions (id, project_id, subject, outcome, reason, evidence_hash, supersedes_decision_id, superseded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        )
        .run(
          id,
          requireText(payload, "projectId"),
          requireText(payload, "subject"),
          requireText(payload, "outcome"),
          requireText(payload, "reason"),
          requireText(payload, "evidenceHash"),
          supersedesDecisionId,
          requireText(payload, "createdAt"),
        );
      if (supersedesDecisionId !== null) {
        this.database
          .prepare("UPDATE decisions SET superseded_by = ? WHERE id = ?")
          .run(id, supersedesDecisionId);
      }
      return;
    }
    if (event.type === "milestone.created") {
      this.database
        .prepare(
          "INSERT INTO milestones (id, project_id, user_problem, smallest_useful_result, non_goals_json, acceptance_tests_json, evidence_required_json, risks_json, rollback_condition, human_gate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          requireText(payload, "id"),
          requireText(payload, "projectId"),
          requireText(payload, "userProblem"),
          requireText(payload, "smallestUsefulResult"),
          canonicalJson(this.requireStringPayload(payload, "nonGoals")),
          canonicalJson(this.requireStringPayload(payload, "acceptanceTests")),
          canonicalJson(this.requireStringPayload(payload, "evidenceRequired")),
          canonicalJson(this.requireStringPayload(payload, "risks")),
          requireText(payload, "rollbackCondition"),
          requireText(payload, "humanGate"),
          requireText(payload, "createdAt"),
        );
      return;
    }
    if (event.type === "shape.created") {
      this.database
        .prepare(
          "INSERT INTO shape_briefs (id, project_id, idea_id, owner, user_problem, target_user, desired_outcome, evidence_hashes_json, assumption_ids_json, effort_limit, solution_outline, user_journey, non_goals_json, risks_json, open_questions_json, success_criteria_json, scope_expansion_paths_json, rabbit_holes_json, status, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        )
        .run(
          requireText(payload, "id"),
          requireText(payload, "projectId"),
          requireText(payload, "ideaId"),
          requireText(payload, "owner"),
          requireText(payload, "userProblem"),
          requireText(payload, "targetUser"),
          requireText(payload, "desiredOutcome"),
          canonicalJson(this.requireStringPayload(payload, "evidenceHashes")),
          canonicalJson(this.requireStringPayload(payload, "assumptionIds")),
          requireText(payload, "effortLimit"),
          requireText(payload, "solutionOutline"),
          requireText(payload, "userJourney"),
          canonicalJson(this.requireStringPayload(payload, "nonGoals")),
          canonicalJson(this.requireStringPayload(payload, "risks")),
          canonicalJson(this.requireStringPayload(payload, "openQuestions")),
          canonicalJson(this.requireStringPayload(payload, "successCriteria")),
          canonicalJson(
            this.requireStringPayload(payload, "scopeExpansionPaths"),
          ),
          canonicalJson(this.requireStringPayload(payload, "rabbitHoles")),
          "draft",
          requireText(payload, "createdAt"),
        );
      return;
    }
    if (event.type === "shape.approved") {
      this.database
        .prepare(
          "UPDATE shape_briefs SET status = ?, approved_at = ? WHERE id = ?",
        )
        .run(
          "approved",
          requireText(payload, "approvedAt"),
          requireText(payload, "shapeBriefId"),
        );
      return;
    }
    if (event.type === "launch-readiness.created") {
      this.database
        .prepare(
          "INSERT INTO launch_readiness (id, project_id, shape_brief_id, owner, candidate_evidence_hash, change_note, known_limits_json, support_owner, rollback_procedure, verification_evidence_hashes_json, privacy_security_declaration, release_checklist_json, status, created_at, authorized_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        )
        .run(
          requireText(payload, "id"),
          requireText(payload, "projectId"),
          requireText(payload, "shapeBriefId"),
          requireText(payload, "owner"),
          requireText(payload, "candidateEvidenceHash"),
          requireText(payload, "changeNote"),
          canonicalJson(this.requireStringPayload(payload, "knownLimits")),
          requireText(payload, "supportOwner"),
          requireText(payload, "rollbackProcedure"),
          canonicalJson(
            this.requireStringPayload(payload, "verificationEvidenceHashes"),
          ),
          requireText(payload, "privacySecurityDeclaration"),
          canonicalJson(this.requireStringPayload(payload, "releaseChecklist")),
          "draft",
          requireText(payload, "createdAt"),
        );
      return;
    }
    if (event.type === "launch-readiness.authorized") {
      this.database
        .prepare(
          "UPDATE launch_readiness SET status = ?, authorized_at = ? WHERE id = ?",
        )
        .run(
          "authorized",
          requireText(payload, "authorizedAt"),
          requireText(payload, "launchReadinessId"),
        );
      return;
    }
    if (event.type === "outcome-review.created") {
      this.database
        .prepare(
          "INSERT INTO outcome_reviews (id, project_id, shape_brief_id, expected_measure_json, observed_result, changed_assumption, decision, created_at, recorded_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)",
        )
        .run(
          requireText(payload, "id"),
          requireText(payload, "projectId"),
          requireText(payload, "shapeBriefId"),
          canonicalJson(this.requireStringPayload(payload, "expectedMeasure")),
          requireText(payload, "createdAt"),
        );
      return;
    }
    if (event.type === "outcome-review.recorded") {
      const decision = requireText(payload, "decision");
      if (!outcomeDecisions.some((value) => value === decision)) {
        throw new Error("Bundle outcome review decision is unknown.");
      }
      this.database
        .prepare(
          "UPDATE outcome_reviews SET observed_result = ?, changed_assumption = ?, decision = ?, recorded_at = ? WHERE id = ?",
        )
        .run(
          requireText(payload, "observedResult"),
          requireText(payload, "changedAssumption"),
          decision,
          requireText(payload, "recordedAt"),
          requireText(payload, "outcomeReviewId"),
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
