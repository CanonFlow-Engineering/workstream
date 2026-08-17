export type ActorKind =
  | "human"
  | "architect-agent"
  | "independent-tester"
  | "llm-judge";

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
