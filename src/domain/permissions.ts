import type { Actor, GateDecision, Result, WorkStatus } from "./model.js";

const humanOnly = (actor: Actor, action: string): Result<undefined> =>
  actor.kind === "human"
    ? { kind: "ok", value: undefined }
    : { kind: "error", message: `${action} requires a human actor.` };

export const requireHuman = (actor: Actor, action: string): Result<undefined> =>
  humanOnly(actor, action);

export const mayClaim = (
  actor: Actor,
  status: WorkStatus,
): Result<undefined> => {
  if (actor.kind !== "architect-agent") {
    return {
      kind: "error",
      message: "Only an architect agent can claim work.",
    };
  }
  if (status === "blocked") {
    return { kind: "error", message: "Blocked work cannot be claimed." };
  }
  if (status !== "ready") {
    return {
      kind: "error",
      message: `Work in ${status} state cannot be claimed.`,
    };
  }
  return { kind: "ok", value: undefined };
};

export const nextGateStatus = (
  current: WorkStatus,
  decision: GateDecision,
): Result<WorkStatus> => {
  if (decision === "accept") {
    return current === "awaiting-gate"
      ? { kind: "ok", value: "accepted" }
      : {
          kind: "error",
          message: "Acceptance requires a passing test and Judge record.",
        };
  }
  if (decision === "reject") {
    return { kind: "ok", value: "rejected" };
  }
  return { kind: "ok", value: "stopped" };
};

export const actorMayAttachEvidence = (
  actor: Actor,
  claimant: string | null,
): Result<undefined> => {
  if (actor.kind !== "architect-agent") {
    return { kind: "ok", value: undefined };
  }
  return claimant === actor.id
    ? { kind: "ok", value: undefined }
    : {
        kind: "error",
        message:
          "An architect agent may attach evidence only to its claimed work.",
      };
};
