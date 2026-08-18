#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "./adapters/canonical.js";
import { parseActor, WorkstreamStore } from "./adapters/workstream-store.js";
import { startLocalServer } from "./server.js";
import type {
  Actor,
  AssumptionConfidence,
  AssumptionInput,
  CompassDraftInput,
  CompassStatement,
  DecisionOutcome,
  GateDecision,
  JudgeVerdict,
  LaunchReadinessInput,
  MilestoneContractInput,
  OutcomeDecision,
  ShapeBriefInput,
  TestVerdict,
  TemplateKind,
} from "./domain/model.js";

const help = readFileSync(new URL("./cli-help.md", import.meta.url), "utf8");

interface ParsedArguments {
  readonly positional: readonly string[];
  readonly port: number;
  readonly root: string;
  readonly actor: Actor | null;
}

const optionValue = (
  arguments_: readonly string[],
  option: string,
): string | null => {
  const index = arguments_.indexOf(option);
  if (index < 0) {
    return null;
  }
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
};

const parseArguments = (arguments_: readonly string[]): ParsedArguments => {
  const root = optionValue(arguments_, "--root") ?? ".";
  const portValue = optionValue(arguments_, "--port");
  const actorValue = optionValue(arguments_, "--actor");
  const positional: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const item = arguments_[index];
    if (item === "--root" || item === "--actor" || item === "--port") {
      index += 1;
      continue;
    }
    if (item !== undefined) {
      positional.push(item);
    }
  }
  return {
    positional,
    port: portValue === null ? 3210 : Number(portValue),
    root: resolve(root),
    actor: actorValue === null ? null : parseActor(actorValue),
  };
};

const requireActor = (actor: Actor | null): Actor => {
  if (actor === null) {
    throw new Error("--actor kind:id is required for this command.");
  }
  return actor;
};

const requireArgument = (
  arguments_: readonly string[],
  index: number,
  name: string,
): string => {
  const value = arguments_[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readInput = (path: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error("Input JSON must be an object.");
  }
  return parsed;
};

const inputText = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Input ${key} must be non-empty text.`);
  }
  return value;
};

const inputStringList = (
  input: Record<string, unknown>,
  key: string,
): readonly string[] => {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Input ${key} must be a non-empty text list.`);
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`Input ${key} must be a non-empty text list.`);
    }
    strings.push(item);
  }
  return strings;
};

const inputStatements = (
  input: Record<string, unknown>,
  key: string,
): readonly CompassStatement[] => {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Input ${key} must be a non-empty statement list.`);
  }
  const statements: CompassStatement[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error(`Input ${key} has an invalid statement.`);
    }
    statements.push({
      evidenceHash: inputText(item, "evidenceHash"),
      id: inputText(item, "id"),
      text: inputText(item, "text"),
    });
  }
  return statements;
};

const compassInput = (input: Record<string, unknown>): CompassDraftInput => ({
  nonGoals: inputStatements(input, "nonGoals"),
  owner: inputText(input, "owner"),
  principles: inputStatements(input, "principles"),
  title: inputText(input, "title"),
});

const assumptionInput = (input: Record<string, unknown>): AssumptionInput => {
  const confidence = inputText(input, "confidence");
  if (
    confidence !== "low" &&
    confidence !== "medium" &&
    confidence !== "high"
  ) {
    throw new Error("Input confidence is invalid.");
  }
  return {
    confidence: confidence satisfies AssumptionConfidence,
    expiresAt: inputText(input, "expiresAt"),
    owner: inputText(input, "owner"),
    statement: inputText(input, "statement"),
    testMethod: inputText(input, "testMethod"),
  };
};

const milestoneInput = (
  input: Record<string, unknown>,
): MilestoneContractInput => ({
  acceptanceTests: inputStringList(input, "acceptanceTests"),
  evidenceRequired: inputStringList(input, "evidenceRequired"),
  humanGate: inputText(input, "humanGate"),
  nonGoals: inputStringList(input, "nonGoals"),
  risks: inputStringList(input, "risks"),
  rollbackCondition: inputText(input, "rollbackCondition"),
  smallestUsefulResult: inputText(input, "smallestUsefulResult"),
  userProblem: inputText(input, "userProblem"),
});

const shapeBriefInput = (input: Record<string, unknown>): ShapeBriefInput => ({
  assumptionIds: inputStringList(input, "assumptionIds"),
  desiredOutcome: inputText(input, "desiredOutcome"),
  effortLimit: inputText(input, "effortLimit"),
  evidenceHashes: inputStringList(input, "evidenceHashes"),
  ideaId: inputText(input, "ideaId"),
  nonGoals: inputStringList(input, "nonGoals"),
  openQuestions: inputStringList(input, "openQuestions"),
  owner: inputText(input, "owner"),
  rabbitHoles: inputStringList(input, "rabbitHoles"),
  risks: inputStringList(input, "risks"),
  scopeExpansionPaths: inputStringList(input, "scopeExpansionPaths"),
  solutionOutline: inputText(input, "solutionOutline"),
  successCriteria: inputStringList(input, "successCriteria"),
  targetUser: inputText(input, "targetUser"),
  userJourney: inputText(input, "userJourney"),
  userProblem: inputText(input, "userProblem"),
});

const launchReadinessInput = (
  input: Record<string, unknown>,
): LaunchReadinessInput => ({
  candidateEvidenceHash: inputText(input, "candidateEvidenceHash"),
  changeNote: inputText(input, "changeNote"),
  knownLimits: inputStringList(input, "knownLimits"),
  owner: inputText(input, "owner"),
  privacySecurityDeclaration: inputText(input, "privacySecurityDeclaration"),
  releaseChecklist: inputStringList(input, "releaseChecklist"),
  rollbackProcedure: inputText(input, "rollbackProcedure"),
  shapeBriefId: inputText(input, "shapeBriefId"),
  supportOwner: inputText(input, "supportOwner"),
  verificationEvidenceHashes: inputStringList(
    input,
    "verificationEvidenceHashes",
  ),
});

const testVerdicts = ["PASS", "FAIL", "BLOCKED"];
const judgeVerdicts = ["Pass", "Fail", "Inconclusive", "ToolFailure"];
const gateDecisions = ["accept", "reject", "stop"];

const isTestVerdict = (value: string): value is TestVerdict =>
  testVerdicts.some((item) => item === value);
const isJudgeVerdict = (value: string): value is JudgeVerdict =>
  judgeVerdicts.some((item) => item === value);
const isGateDecision = (value: string): value is GateDecision =>
  gateDecisions.some((item) => item === value);

const isTemplateKind = (value: string): value is TemplateKind =>
  [
    "npm-package",
    "assay-rule-policy-change",
    "protocol-standards-integration",
    "release-preparation-milestone",
  ].some((item) => item === value);

const emit = (value: unknown): void => {
  process.stdout.write(`${canonicalJson(value)}\n`);
};

const withStore = (
  root: string,
  action: (store: WorkstreamStore) => unknown,
): void => {
  const store = new WorkstreamStore(root);
  try {
    emit(action(store));
  } finally {
    store.close();
  }
};

const main = (): number => {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw[0] === "--help" || raw[0] === "-h") {
    process.stdout.write(help);
    return 0;
  }
  const parsed = parseArguments(raw);
  const [command, subcommand, ...arguments_] = parsed.positional;
  if (command === "init") {
    const root = subcommand === undefined ? parsed.root : resolve(subcommand);
    withStore(root, (store) => ({
      event: store.initialize(requireActor(parsed.actor)),
      root,
    }));
    return 0;
  }
  if (command === "serve") {
    const root = subcommand === undefined ? parsed.root : resolve(subcommand);
    startLocalServer(root, parsed.port, (address) =>
      emit({
        address,
        githubIntegration: "dry-run-only",
        mode: "local-browser",
        root,
      }),
    );
    return 0;
  }
  if (command === "compass" && subcommand === "evidence") {
    withStore(parsed.root, (store) => ({
      evidence: store.attachProjectEvidence(
        requireActor(parsed.actor),
        requireArgument(arguments_, 0, "Project id"),
        requireArgument(arguments_, 1, "Evidence kind"),
        readFileSync(requireArgument(arguments_, 2, "Evidence file")),
      ),
    }));
    return 0;
  }
  if (command === "compass" && subcommand === "create") {
    withStore(parsed.root, (store) => ({
      compass: store.createCompass(
        requireActor(parsed.actor),
        requireArgument(arguments_, 1, "Compass id"),
        requireArgument(arguments_, 0, "Project id"),
        compassInput(
          readInput(requireArgument(arguments_, 2, "Compass JSON file")),
        ),
      ),
    }));
    return 0;
  }
  if (command === "compass" && subcommand === "approve") {
    withStore(parsed.root, (store) => ({
      compass: store.approveCompass(
        requireActor(parsed.actor),
        requireArgument(arguments_, 0, "Compass id"),
      ),
    }));
    return 0;
  }
  if (command === "compass" && subcommand === "supersede") {
    withStore(parsed.root, (store) => ({
      compass: store.supersedeCompass(
        requireActor(parsed.actor),
        requireArgument(arguments_, 0, "Current Compass id"),
        requireArgument(arguments_, 1, "Replacement Compass id"),
      ),
    }));
    return 0;
  }
  if (command === "vision" && subcommand === "export") {
    withStore(parsed.root, (store) => ({
      vision: store.exportVision(
        requireArgument(arguments_, 0, "Project id"),
        requireArgument(arguments_, 1, "VISION.md destination"),
      ),
    }));
    return 0;
  }
  if (command === "vision" && subcommand === "import") {
    withStore(parsed.root, (store) => ({
      compass: store.importVision(
        requireActor(parsed.actor),
        requireArgument(arguments_, 1, "Compass id"),
        requireArgument(arguments_, 0, "Project id"),
        requireArgument(arguments_, 2, "VISION.md source"),
      ),
    }));
    return 0;
  }
  if (command === "idea" && subcommand === "create") {
    withStore(parsed.root, (store) => {
      const input = readInput(requireArgument(arguments_, 2, "Idea JSON file"));
      return {
        idea: store.createIdea(
          requireActor(parsed.actor),
          requireArgument(arguments_, 1, "Idea id"),
          requireArgument(arguments_, 0, "Project id"),
          {
            affectedUser: inputText(input, "affectedUser"),
            assumption: inputText(input, "assumption"),
            costEstimate: inputText(input, "costEstimate"),
            evidenceHash: inputText(input, "evidenceHash"),
            expectedResult: inputText(input, "expectedResult"),
            expiresAt: inputText(input, "expiresAt"),
            problem: inputText(input, "problem"),
            rejectionReason: inputText(input, "rejectionReason"),
            risk: inputText(input, "risk"),
          },
        ),
      };
    });
    return 0;
  }
  if (command === "idea" && subcommand === "review") {
    const status = requireArgument(arguments_, 1, "Idea status");
    if (status !== "shaped" && status !== "rejected" && status !== "deferred") {
      throw new Error("Idea status must be shaped, rejected, or deferred.");
    }
    withStore(parsed.root, (store) => ({
      idea: store.reviewIdea(
        requireActor(parsed.actor),
        requireArgument(arguments_, 0, "Idea id"),
        status,
      ),
    }));
    return 0;
  }
  if (command === "assumption" && subcommand === "create") {
    withStore(parsed.root, (store) => ({
      assumption: store.createAssumption(
        requireActor(parsed.actor),
        requireArgument(arguments_, 1, "Assumption id"),
        requireArgument(arguments_, 0, "Project id"),
        assumptionInput(
          readInput(requireArgument(arguments_, 2, "Assumption JSON file")),
        ),
      ),
    }));
    return 0;
  }
  if (command === "assumption" && subcommand === "result") {
    const result = requireArgument(arguments_, 1, "Assumption result");
    if (result !== "validated" && result !== "invalidated") {
      throw new Error("Assumption result must be validated or invalidated.");
    }
    withStore(parsed.root, (store) => ({
      assumption: store.recordAssumptionResult(
        requireActor(parsed.actor),
        requireArgument(arguments_, 0, "Assumption id"),
        result,
        requireArgument(arguments_, 2, "Evidence SHA-256"),
      ),
    }));
    return 0;
  }
  if (command === "tradeoff" && subcommand === "create") {
    withStore(parsed.root, (store) => {
      const input = readInput(
        requireArgument(arguments_, 2, "Trade-off JSON file"),
      );
      return {
        tradeoff: store.createTradeoff(
          requireActor(parsed.actor),
          requireArgument(arguments_, 1, "Trade-off id"),
          requireArgument(arguments_, 0, "Project id"),
          inputText(input, "question"),
          inputText(input, "yesCase"),
          inputText(input, "noCase"),
          inputText(input, "evidenceHash"),
        ),
      };
    });
    return 0;
  }
  if (command === "tradeoff" && subcommand === "decide") {
    const decision = requireArgument(arguments_, 1, "Trade-off decision");
    if (
      decision !== "accept" &&
      decision !== "reject" &&
      decision !== "defer"
    ) {
      throw new Error("Trade-off decision must be accept, reject, or defer.");
    }
    withStore(parsed.root, (store) => ({
      tradeoff: store.decideTradeoff(
        requireActor(parsed.actor),
        requireArgument(arguments_, 0, "Trade-off id"),
        decision,
        requireArgument(arguments_, 2, "Decision reason"),
      ),
    }));
    return 0;
  }
  if (command === "decision" && subcommand === "record") {
    withStore(parsed.root, (store) => {
      const input = readInput(
        requireArgument(arguments_, 2, "Decision JSON file"),
      );
      const outcome = inputText(input, "outcome");
      if (
        outcome !== "accept" &&
        outcome !== "reject" &&
        outcome !== "defer" &&
        outcome !== "stop"
      ) {
        throw new Error("Decision outcome is invalid.");
      }
      const supersedes = input.supersedesDecisionId;
      if (
        supersedes !== undefined &&
        supersedes !== null &&
        typeof supersedes !== "string"
      ) {
        throw new Error("Decision supersedesDecisionId must be text or null.");
      }
      return {
        decision: store.recordDecision(
          requireActor(parsed.actor),
          requireArgument(arguments_, 1, "Decision id"),
          requireArgument(arguments_, 0, "Project id"),
          inputText(input, "subject"),
          outcome satisfies DecisionOutcome,
          inputText(input, "reason"),
          inputText(input, "evidenceHash"),
          supersedes ?? null,
        ),
      };
    });
    return 0;
  }
  if (command === "milestone" && subcommand === "create") {
    withStore(parsed.root, (store) => ({
      milestone: store.createMilestone(
        requireActor(parsed.actor),
        requireArgument(arguments_, 1, "Milestone id"),
        requireArgument(arguments_, 0, "Project id"),
        milestoneInput(
          readInput(requireArgument(arguments_, 2, "Milestone JSON file")),
        ),
      ),
    }));
    return 0;
  }
  if (command === "shape" && subcommand === "create") {
    withStore(parsed.root, (store) => ({
      shapeBrief: store.createShapeBrief(
        requireActor(parsed.actor),
        requireArgument(arguments_, 1, "Shape brief id"),
        requireArgument(arguments_, 0, "Project id"),
        shapeBriefInput(
          readInput(requireArgument(arguments_, 2, "Shape brief JSON file")),
        ),
      ),
    }));
    return 0;
  }
  if (command === "shape" && subcommand === "approve") {
    withStore(parsed.root, (store) => ({
      shapeBrief: store.approveShapeBrief(
        requireActor(parsed.actor),
        requireArgument(arguments_, 0, "Shape brief id"),
      ),
    }));
    return 0;
  }
  if (command === "launch" && subcommand === "create") {
    withStore(parsed.root, (store) => ({
      launchReadiness: store.createLaunchReadiness(
        requireActor(parsed.actor),
        requireArgument(arguments_, 1, "Launch readiness id"),
        requireArgument(arguments_, 0, "Project id"),
        launchReadinessInput(
          readInput(
            requireArgument(arguments_, 2, "Launch readiness JSON file"),
          ),
        ),
      ),
    }));
    return 0;
  }
  if (command === "launch" && subcommand === "authorize") {
    withStore(parsed.root, (store) => ({
      launchReadiness: store.authorizeLaunchReadiness(
        requireActor(parsed.actor),
        requireArgument(arguments_, 0, "Launch readiness id"),
      ),
    }));
    return 0;
  }
  if (command === "outcome" && subcommand === "create") {
    withStore(parsed.root, (store) => ({
      outcomeReview: store.createOutcomeReview(
        requireActor(parsed.actor),
        requireArgument(arguments_, 1, "Outcome review id"),
        requireArgument(arguments_, 0, "Project id"),
        requireArgument(arguments_, 2, "Shape brief id"),
      ),
    }));
    return 0;
  }
  if (command === "outcome" && subcommand === "record") {
    withStore(parsed.root, (store) => {
      const input = readInput(
        requireArgument(arguments_, 1, "Outcome review JSON file"),
      );
      const decision = inputText(input, "decision");
      if (decision !== "keep" && decision !== "change" && decision !== "stop") {
        throw new Error(
          "Outcome review decision must be keep, change, or stop.",
        );
      }
      return {
        outcomeReview: store.recordOutcomeReview(
          requireActor(parsed.actor),
          requireArgument(arguments_, 0, "Outcome review id"),
          inputText(input, "observedResult"),
          inputText(input, "changedAssumption"),
          decision satisfies OutcomeDecision,
        ),
      };
    });
    return 0;
  }
  if (command === "template" && subcommand === "create") {
    const templateKind = requireArgument(arguments_, 1, "Template kind");
    if (!isTemplateKind(templateKind)) {
      throw new Error("Template kind is invalid.");
    }
    withStore(parsed.root, (store) => ({
      templateDraft: store.createTemplateDraft(
        requireActor(parsed.actor),
        requireArgument(arguments_, 2, "Template draft id"),
        requireArgument(arguments_, 0, "Project id"),
        templateKind,
      ),
    }));
    return 0;
  }
  if (command === "audit") {
    withStore(parsed.root, (store) => ({
      findings: store.audit(
        requireArgument(parsed.positional, 1, "Project id"),
      ),
    }));
    return 0;
  }
  if (command === "handoff" && subcommand === "export") {
    withStore(parsed.root, (store) => ({
      handoff: store.exportHandoff(
        requireArgument(arguments_, 0, "Project id"),
        requireArgument(arguments_, 1, "Handoff directory"),
      ),
    }));
    return 0;
  }
  if (command === "handoff" && subcommand === "verify") {
    withStore(parsed.root, (store) => ({
      handoff: store.verifyHandoffPack(
        requireArgument(arguments_, 0, "Project id"),
        requireArgument(arguments_, 1, "Handoff JSON file"),
      ),
    }));
    return 0;
  }
  if (command === "project" && subcommand === "create") {
    withStore(parsed.root, (store) => {
      const id = requireArgument(arguments_, 0, "Project id");
      const name = requireArgument(arguments_, 1, "Project name");
      const description = arguments_.slice(2).join(" ") || name;
      return {
        project: store.createProject(
          requireActor(parsed.actor),
          id,
          name,
          description,
        ),
      };
    });
    return 0;
  }
  if (command === "work" && subcommand === "create") {
    withStore(parsed.root, (store) => ({
      work: store.createWork(
        requireActor(parsed.actor),
        requireArgument(arguments_, 1, "Work id"),
        requireArgument(arguments_, 0, "Project id"),
        requireArgument(arguments_, 2, "Work title"),
      ),
    }));
    return 0;
  }
  if (command === "mandate" && subcommand === "issue") {
    withStore(parsed.root, (store) => {
      const workId = requireArgument(arguments_, 0, "Work id");
      const file = requireArgument(arguments_, 1, "Mandate file");
      return {
        evidence: store.issueMandate(
          requireActor(parsed.actor),
          workId,
          readFileSync(file),
        ),
      };
    });
    return 0;
  }
  if (command === "work" && subcommand === "claim") {
    withStore(parsed.root, (store) => ({
      work: store.claimWork(
        requireActor(parsed.actor),
        requireArgument(arguments_, 0, "Work id"),
      ),
    }));
    return 0;
  }
  if (command === "evidence" && subcommand === "attach") {
    withStore(parsed.root, (store) => ({
      evidence: store.attachEvidence(
        requireActor(parsed.actor),
        requireArgument(arguments_, 0, "Work id"),
        requireArgument(arguments_, 1, "Evidence kind"),
        readFileSync(requireArgument(arguments_, 2, "Evidence file")),
      ),
    }));
    return 0;
  }
  if (command === "handoff" && subcommand === "create") {
    withStore(parsed.root, (store) => ({
      event: store.createHandoff(
        requireActor(parsed.actor),
        requireArgument(arguments_, 0, "Work id"),
        parseActor(requireArgument(arguments_, 1, "Recipient")),
        requireArgument(arguments_, 2, "Handoff summary"),
      ),
    }));
    return 0;
  }
  if (command === "test" && subcommand === "record") {
    withStore(parsed.root, (store) => {
      const verdict = requireArgument(arguments_, 1, "Test verdict");
      if (!isTestVerdict(verdict)) {
        throw new Error("Test verdict must be PASS, FAIL, or BLOCKED.");
      }
      return {
        work: store.recordTest(
          requireActor(parsed.actor),
          requireArgument(arguments_, 0, "Work id"),
          verdict,
          requireArgument(arguments_, 2, "Evidence hash"),
        ),
      };
    });
    return 0;
  }
  if (command === "judge" && subcommand === "record") {
    withStore(parsed.root, (store) => {
      const verdict = requireArgument(arguments_, 1, "Judge verdict");
      if (!isJudgeVerdict(verdict)) {
        throw new Error(
          "Judge verdict must be Pass, Fail, Inconclusive, or ToolFailure.",
        );
      }
      return {
        work: store.recordJudge(
          requireActor(parsed.actor),
          requireArgument(arguments_, 0, "Work id"),
          verdict,
          requireArgument(arguments_, 2, "Evidence hash"),
        ),
      };
    });
    return 0;
  }
  if (command === "gate" && subcommand === "decide") {
    withStore(parsed.root, (store) => {
      const decision = requireArgument(arguments_, 1, "Gate decision");
      if (!isGateDecision(decision)) {
        throw new Error("Gate decision must be accept, reject, or stop.");
      }
      return {
        work: store.decideGate(
          requireActor(parsed.actor),
          requireArgument(arguments_, 0, "Work id"),
          decision,
        ),
      };
    });
    return 0;
  }
  if (command === "export") {
    withStore(parsed.root, (store) => ({
      manifest: store.exportBundle(
        requireArgument(parsed.positional, 1, "Bundle directory"),
      ),
    }));
    return 0;
  }
  if (command === "import") {
    const bundle = requireArgument(parsed.positional, 1, "Bundle directory");
    const target =
      arguments_[0] === undefined ? parsed.root : resolve(arguments_[0]);
    withStore(target, (store) => ({
      manifest: store.importBundle(bundle),
      target,
    }));
    return 0;
  }
  if (command === "verify") {
    const root = subcommand === undefined ? parsed.root : resolve(subcommand);
    const store = new WorkstreamStore(root);
    try {
      const verification = store.verify();
      emit({ verification });
      return verification.valid ? 0 : 1;
    } finally {
      store.close();
    }
  }
  if (command === "work" && subcommand === "show") {
    withStore(parsed.root, (store) => {
      const workId = requireArgument(arguments_, 0, "Work id");
      return { work: store.work(workId), activity: store.activity(workId) };
    });
    return 0;
  }
  if (command === "work" && subcommand === "queue") {
    withStore(parsed.root, (store) => ({ work: store.queue() }));
    return 0;
  }
  if (command === "work" && subcommand === "blocked") {
    withStore(parsed.root, (store) => ({ work: store.blocked() }));
    return 0;
  }
  if (command === "activity") {
    withStore(parsed.root, (store) => ({
      activity:
        subcommand === undefined
          ? store.activity()
          : store.activity(subcommand),
    }));
    return 0;
  }
  throw new Error(help);
};

try {
  process.exitCode = main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`workstream: ${message}\n`);
  process.exitCode = 2;
}
