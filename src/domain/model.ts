export type ActorKind =
  | "human"
  | "architect-agent"
  | "independent-tester"
  | "llm-judge"
  | "skeptic-agent";

export interface Actor {
  readonly id: string;
  readonly kind: ActorKind;
}

export type WorkStatus =
  | "ready"
  | "claimed"
  | "testing"
  | "awaiting-gate"
  | "accepted"
  | "rejected"
  | "stopped"
  | "blocked";

export type TestVerdict = "PASS" | "FAIL" | "BLOCKED";

export type JudgeVerdict = "Pass" | "Fail" | "Inconclusive" | "ToolFailure";

export type GateDecision = "accept" | "reject" | "stop";

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
}

export type CompassStatus = "draft" | "approved" | "superseded";

export interface CompassStatement {
  readonly id: string;
  readonly text: string;
  readonly evidenceHash: string;
}

export interface CompassVersion {
  readonly id: string;
  readonly projectId: string;
  readonly owner: string;
  readonly title: string;
  readonly version: number;
  readonly status: CompassStatus;
  readonly createdAt: string;
  readonly approvedAt: string | null;
  readonly supersededBy: string | null;
  readonly sourceVisionEvidenceHash: string | null;
  readonly principles: readonly CompassStatement[];
  readonly nonGoals: readonly CompassStatement[];
}

export type IdeaStatus = "inbox" | "shaped" | "rejected" | "deferred";

export interface Idea {
  readonly id: string;
  readonly projectId: string;
  readonly problem: string;
  readonly affectedUser: string;
  readonly expectedResult: string;
  readonly evidenceHash: string;
  readonly assumption: string;
  readonly risk: string;
  readonly costEstimate: string;
  readonly rejectionReason: string;
  readonly expiresAt: string;
  readonly status: IdeaStatus;
  readonly createdAt: string;
}

export type AssumptionConfidence = "low" | "medium" | "high";
export type AssumptionResult = "open" | "validated" | "invalidated";

export interface Assumption {
  readonly id: string;
  readonly projectId: string;
  readonly statement: string;
  readonly owner: string;
  readonly confidence: AssumptionConfidence;
  readonly testMethod: string;
  readonly expiresAt: string;
  readonly result: AssumptionResult;
  readonly resultEvidenceHash: string | null;
  readonly expired: boolean;
  readonly createdAt: string;
}

export type TradeoffDecision = "accept" | "reject" | "defer" | null;

export interface TradeoffCard {
  readonly id: string;
  readonly projectId: string;
  readonly question: string;
  readonly yesCase: string;
  readonly noCase: string;
  readonly evidenceHash: string;
  readonly decision: TradeoffDecision;
  readonly decisionReason: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
}

export type DecisionOutcome = "accept" | "reject" | "defer" | "stop";

export interface Decision {
  readonly id: string;
  readonly projectId: string;
  readonly subject: string;
  readonly outcome: DecisionOutcome;
  readonly reason: string;
  readonly evidenceHash: string;
  readonly supersedesDecisionId: string | null;
  readonly supersededBy: string | null;
  readonly createdAt: string;
}

export interface MilestoneContract {
  readonly id: string;
  readonly projectId: string;
  readonly userProblem: string;
  readonly smallestUsefulResult: string;
  readonly nonGoals: readonly string[];
  readonly acceptanceTests: readonly string[];
  readonly evidenceRequired: readonly string[];
  readonly risks: readonly string[];
  readonly rollbackCondition: string;
  readonly humanGate: string;
  readonly createdAt: string;
}

export type ShapeBriefStatus = "draft" | "approved";

export interface ShapeBrief {
  readonly id: string;
  readonly projectId: string;
  readonly ideaId: string;
  readonly owner: string;
  readonly userProblem: string;
  readonly targetUser: string;
  readonly desiredOutcome: string;
  readonly evidenceHashes: readonly string[];
  readonly assumptionIds: readonly string[];
  readonly effortLimit: string;
  readonly solutionOutline: string;
  readonly userJourney: string;
  readonly nonGoals: readonly string[];
  readonly risks: readonly string[];
  readonly openQuestions: readonly string[];
  readonly successCriteria: readonly string[];
  readonly scopeExpansionPaths: readonly string[];
  readonly rabbitHoles: readonly string[];
  readonly status: ShapeBriefStatus;
  readonly createdAt: string;
  readonly approvedAt: string | null;
}

export interface ShapeBriefInput {
  readonly ideaId: string;
  readonly owner: string;
  readonly userProblem: string;
  readonly targetUser: string;
  readonly desiredOutcome: string;
  readonly evidenceHashes: readonly string[];
  readonly assumptionIds: readonly string[];
  readonly effortLimit: string;
  readonly solutionOutline: string;
  readonly userJourney: string;
  readonly nonGoals: readonly string[];
  readonly risks: readonly string[];
  readonly openQuestions: readonly string[];
  readonly successCriteria: readonly string[];
  readonly scopeExpansionPaths: readonly string[];
  readonly rabbitHoles: readonly string[];
}

export type LaunchReadinessStatus = "draft" | "authorized";

export interface LaunchReadiness {
  readonly id: string;
  readonly projectId: string;
  readonly shapeBriefId: string;
  readonly owner: string;
  readonly candidateEvidenceHash: string;
  readonly changeNote: string;
  readonly knownLimits: readonly string[];
  readonly supportOwner: string;
  readonly rollbackProcedure: string;
  readonly verificationEvidenceHashes: readonly string[];
  readonly privacySecurityDeclaration: string;
  readonly releaseChecklist: readonly string[];
  readonly status: LaunchReadinessStatus;
  readonly createdAt: string;
  readonly authorizedAt: string | null;
}

export interface LaunchReadinessInput {
  readonly shapeBriefId: string;
  readonly owner: string;
  readonly candidateEvidenceHash: string;
  readonly changeNote: string;
  readonly knownLimits: readonly string[];
  readonly supportOwner: string;
  readonly rollbackProcedure: string;
  readonly verificationEvidenceHashes: readonly string[];
  readonly privacySecurityDeclaration: string;
  readonly releaseChecklist: readonly string[];
}

export type OutcomeDecision = "keep" | "change" | "stop" | null;

export interface OutcomeReview {
  readonly id: string;
  readonly projectId: string;
  readonly shapeBriefId: string;
  readonly expectedMeasure: readonly string[];
  readonly observedResult: string | null;
  readonly changedAssumption: string | null;
  readonly decision: OutcomeDecision;
  readonly createdAt: string;
  readonly recordedAt: string | null;
}

export type AuditSeverity = "Blocker" | "Attention" | "Information";

export interface AuditFinding {
  readonly ruleId: string;
  readonly severity: AuditSeverity;
  readonly subjectId: string;
  readonly cause: string;
  readonly nextLocalAction: string;
}

export type TemplateKind =
  | "npm-package"
  | "assay-rule-policy-change"
  | "protocol-standards-integration"
  | "release-preparation-milestone";

export interface TemplateDraft {
  readonly id: string;
  readonly projectId: string;
  readonly templateKind: TemplateKind;
  readonly owner: string;
  readonly title: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly status: "draft";
  readonly createdAt: string;
}

export interface HandoffPack {
  readonly schemaVersion: "workstream-handoff/0.1";
  readonly project: Project;
  readonly eventChainSha256: string;
  readonly ledgerVerification: VerificationReport;
  readonly compass: CompassVersion | null;
  readonly ideas: readonly Idea[];
  readonly assumptions: readonly Assumption[];
  readonly tradeoffs: readonly TradeoffCard[];
  readonly decisions: readonly Decision[];
  readonly milestones: readonly MilestoneContract[];
  readonly shapeBriefs: readonly ShapeBrief[];
  readonly launchReadiness: readonly LaunchReadiness[];
  readonly outcomeReviews: readonly OutcomeReview[];
  readonly templateDrafts: readonly TemplateDraft[];
  readonly openWorkGates: readonly WorkItem[];
  readonly auditFindings: readonly AuditFinding[];
  readonly evidence: readonly EvidenceReference[];
  readonly packSha256: string;
}

export interface CompassSnapshot {
  readonly compasses: readonly CompassVersion[];
  readonly ideas: readonly Idea[];
  readonly assumptions: readonly Assumption[];
  readonly tradeoffs: readonly TradeoffCard[];
  readonly decisions: readonly Decision[];
  readonly milestones: readonly MilestoneContract[];
  readonly shapeBriefs: readonly ShapeBrief[];
  readonly launchReadiness: readonly LaunchReadiness[];
  readonly outcomeReviews: readonly OutcomeReview[];
  readonly templateDrafts: readonly TemplateDraft[];
}

export interface CompassDraftInput {
  readonly title: string;
  readonly owner: string;
  readonly principles: readonly CompassStatement[];
  readonly nonGoals: readonly CompassStatement[];
}

export interface IdeaInput {
  readonly problem: string;
  readonly affectedUser: string;
  readonly expectedResult: string;
  readonly evidenceHash: string;
  readonly assumption: string;
  readonly risk: string;
  readonly costEstimate: string;
  readonly rejectionReason: string;
  readonly expiresAt: string;
}

export interface AssumptionInput {
  readonly statement: string;
  readonly owner: string;
  readonly confidence: AssumptionConfidence;
  readonly testMethod: string;
  readonly expiresAt: string;
}

export interface MilestoneContractInput {
  readonly userProblem: string;
  readonly smallestUsefulResult: string;
  readonly nonGoals: readonly string[];
  readonly acceptanceTests: readonly string[];
  readonly evidenceRequired: readonly string[];
  readonly risks: readonly string[];
  readonly rollbackCondition: string;
  readonly humanGate: string;
}

export interface WorkItem {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: WorkStatus;
  readonly claimant: string | null;
  readonly mandateEvidenceHash: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EvidenceReference {
  readonly sha256: string;
  readonly bytes: number;
  readonly path: string;
}

export interface WorkEvidenceReference extends EvidenceReference {
  readonly kind: string;
}

export interface LedgerEvent {
  readonly sequence: number;
  readonly actor: Actor;
  readonly timestamp: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly previousSha256: string;
  readonly sha256: string;
}

export interface VerificationReport {
  readonly valid: boolean;
  readonly eventCount: number;
  readonly evidenceCount: number;
  readonly errors: readonly string[];
}

export interface ExportManifest {
  readonly schemaVersion: "workstream-bundle/0.1";
  readonly createdAt: string;
  readonly eventsSha256: string;
  readonly evidence: readonly EvidenceReference[];
}

export type Result<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly message: string };

export const zeroHash = "0".repeat(64);
