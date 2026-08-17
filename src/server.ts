import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { parseActor, WorkstreamStore } from "./adapters/workstream-store.js";
import type {
  Actor,
  CompassStatement,
  GateDecision,
  JudgeVerdict,
  TestVerdict,
} from "./domain/model.js";

const maximumRequestBytes = 1_048_576;
const localHost = "127.0.0.1";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (body: JsonRecord, field: string): string => {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
};

const actor = (body: JsonRecord): Actor => parseActor(text(body, "actor"));

const stringList = (body: JsonRecord, field: string): readonly string[] => {
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty list of text.`);
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`${field} must be a non-empty list of text.`);
    }
    strings.push(item);
  }
  return strings;
};

const statements = (
  body: JsonRecord,
  field: string,
): readonly CompassStatement[] => {
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty statement list.`);
  }
  return value.map((entry): CompassStatement => {
    if (!isRecord(entry)) {
      throw new Error(`${field} contains an invalid statement.`);
    }
    return {
      evidenceHash: text(entry, "evidenceHash"),
      id: text(entry, "id"),
      text: text(entry, "text"),
    };
  });
};

const isTestVerdict = (value: string): value is TestVerdict =>
  value === "PASS" || value === "FAIL" || value === "BLOCKED";

const isJudgeVerdict = (value: string): value is JudgeVerdict =>
  value === "Pass" ||
  value === "Fail" ||
  value === "Inconclusive" ||
  value === "ToolFailure";

const isGateDecision = (value: string): value is GateDecision =>
  value === "accept" || value === "reject" || value === "stop";

const ideaReviewStatus = (
  value: string,
): "shaped" | "rejected" | "deferred" => {
  if (value === "shaped" || value === "rejected" || value === "deferred") {
    return value;
  }
  throw new Error("Idea review status is invalid.");
};

const assumptionConfidence = (value: string): "low" | "medium" | "high" => {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new Error("Assumption confidence is invalid.");
};

const assumptionResult = (value: string): "validated" | "invalidated" => {
  if (value === "validated" || value === "invalidated") {
    return value;
  }
  throw new Error("Assumption result is invalid.");
};

const tradeoffDecision = (value: string): "accept" | "reject" | "defer" => {
  if (value === "accept" || value === "reject" || value === "defer") {
    return value;
  }
  throw new Error("Trade-off decision is invalid.");
};

const decisionOutcome = (
  value: string,
): "accept" | "reject" | "defer" | "stop" => {
  if (
    value === "accept" ||
    value === "reject" ||
    value === "defer" ||
    value === "stop"
  ) {
    return value;
  }
  throw new Error("Decision outcome is invalid.");
};

const outcomeDecision = (value: string): "keep" | "change" | "stop" => {
  if (value === "keep" || value === "change" || value === "stop") {
    return value;
  }
  throw new Error("Outcome review decision is invalid.");
};

const respondJson = (
  response: ServerResponse,
  status: number,
  value: unknown,
): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(value)}\n`);
};

const respondText = (
  response: ServerResponse,
  status: number,
  contentType: string,
  value: Uint8Array,
): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
  response.end(value);
};

const readJsonBody = async (request: IncomingMessage): Promise<JsonRecord> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumRequestBytes) {
      throw new Error("Request body exceeds the 1 MiB local API limit.");
    }
    chunks.push(buffer);
  }
  if (length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed;
};

const withStore = <T>(
  root: string,
  action: (store: WorkstreamStore) => T,
): T => {
  const store = new WorkstreamStore(root);
  try {
    return action(store);
  } finally {
    store.close();
  }
};

const snapshot = (store: WorkstreamStore): JsonRecord => ({
  initialized: store
    .events()
    .some((event) => event.type === "workstream.initialized"),
  projects: store.projects(),
  compass: store.compassSnapshot(),
  verification: store.verify(),
  work: store.workItems(),
});

const workDetail = (store: WorkstreamStore, workId: string): JsonRecord => {
  const work = store.work(workId);
  if (work === null) {
    throw new Error(`Work ${workId} does not exist.`);
  }
  return {
    activity: store.activity(workId),
    evidence: store.workEvidence(workId),
    work,
  };
};

const staticAsset = (
  path: string,
): { readonly content: Uint8Array; readonly type: string } | null => {
  if (path === "/" || path === "/index.html") {
    return {
      content: readFileSync(new URL("./ui/index.html", import.meta.url)),
      type: "text/html; charset=utf-8",
    };
  }
  if (path === "/app.js") {
    return {
      content: readFileSync(new URL("./ui/app.js", import.meta.url)),
      type: "text/javascript; charset=utf-8",
    };
  }
  if (path === "/styles.css") {
    return {
      content: readFileSync(new URL("./ui/styles.css", import.meta.url)),
      type: "text/css; charset=utf-8",
    };
  }
  return null;
};

const decodedWorkPath = (pathname: string, suffix: string): string | null => {
  const prefix = "/api/work/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const encoded = pathname.slice(
    prefix.length,
    pathname.length - suffix.length,
  );
  if (encoded.length === 0 || encoded.includes("/")) {
    return null;
  }
  return decodeURIComponent(encoded);
};

const decodedCompassPath = (
  pathname: string,
  suffix: string,
): string | null => {
  const prefix = "/api/compass/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const encoded = pathname.slice(
    prefix.length,
    pathname.length - suffix.length,
  );
  if (encoded.length === 0 || encoded.includes("/")) {
    return null;
  }
  return decodeURIComponent(encoded);
};

const decodedProjectPath = (
  pathname: string,
  suffix: string,
): string | null => {
  const prefix = "/api/projects/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const encoded = pathname.slice(
    prefix.length,
    pathname.length - suffix.length,
  );
  if (encoded.length === 0 || encoded.includes("/")) {
    return null;
  }
  return decodeURIComponent(encoded);
};

const decodedItemPath = (
  pathname: string,
  prefix: string,
  suffix: string,
): string | null => {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const encoded = pathname.slice(
    prefix.length,
    pathname.length - suffix.length,
  );
  if (encoded.length === 0 || encoded.includes("/")) {
    return null;
  }
  return decodeURIComponent(encoded);
};

const handleApi = async (
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  const method = request.method ?? "GET";
  if (pathname === "/api/health" && method === "GET") {
    respondJson(response, 200, {
      actorIdsAreAuthentication: false,
      githubIntegration: "dry-run-only",
      humanGate: "trusted-local-workflow-control",
      localOnly: true,
      status: "ok",
    });
    return true;
  }
  if (pathname === "/api/state" && method === "GET") {
    respondJson(response, 200, withStore(root, snapshot));
    return true;
  }
  const visionProjectId = decodedProjectPath(pathname, "/vision");
  if (visionProjectId !== null && method === "GET") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        projection: store.vision(visionProjectId),
      })),
    );
    return true;
  }
  const detailId = decodedWorkPath(pathname, "");
  if (detailId !== null && method === "GET") {
    respondJson(
      response,
      200,
      withStore(root, (store) => workDetail(store, detailId)),
    );
    return true;
  }
  if (method !== "POST") {
    return false;
  }

  const body = await readJsonBody(request);
  if (pathname === "/api/initialize") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        event: store.initialize(actor(body)),
        state: snapshot(store),
      })),
    );
    return true;
  }
  if (pathname === "/api/projects") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        project: store.createProject(
          actor(body),
          text(body, "id"),
          text(body, "name"),
          text(body, "description"),
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  const projectEvidenceId = decodedProjectPath(pathname, "/evidence");
  if (projectEvidenceId !== null) {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        evidence: store.attachProjectEvidence(
          actor(body),
          projectEvidenceId,
          text(body, "kind"),
          new TextEncoder().encode(text(body, "content")),
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  if (pathname === "/api/compass") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        compass: store.createCompass(
          actor(body),
          text(body, "id"),
          text(body, "projectId"),
          {
            nonGoals: statements(body, "nonGoals"),
            owner: text(body, "owner"),
            principles: statements(body, "principles"),
            title: text(body, "title"),
          },
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  if (pathname === "/api/compass/import") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        compass: store.importVisionContent(
          actor(body),
          text(body, "id"),
          text(body, "projectId"),
          new TextEncoder().encode(text(body, "content")),
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  const compassApproveId = decodedCompassPath(pathname, "/approve");
  if (compassApproveId !== null) {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        compass: store.approveCompass(actor(body), compassApproveId),
        state: snapshot(store),
      })),
    );
    return true;
  }
  const compassSupersedeId = decodedCompassPath(pathname, "/supersede");
  if (compassSupersedeId !== null) {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        compass: store.supersedeCompass(
          actor(body),
          compassSupersedeId,
          text(body, "replacementCompassId"),
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  if (pathname === "/api/ideas") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        idea: store.createIdea(
          actor(body),
          text(body, "id"),
          text(body, "projectId"),
          {
            affectedUser: text(body, "affectedUser"),
            assumption: text(body, "assumption"),
            costEstimate: text(body, "costEstimate"),
            evidenceHash: text(body, "evidenceHash"),
            expectedResult: text(body, "expectedResult"),
            expiresAt: text(body, "expiresAt"),
            problem: text(body, "problem"),
            rejectionReason: text(body, "rejectionReason"),
            risk: text(body, "risk"),
          },
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  const ideaReviewId = decodedItemPath(pathname, "/api/ideas/", "/review");
  if (ideaReviewId !== null) {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        idea: store.reviewIdea(
          actor(body),
          ideaReviewId,
          ideaReviewStatus(text(body, "status")),
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  if (pathname === "/api/assumptions") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        assumption: store.createAssumption(
          actor(body),
          text(body, "id"),
          text(body, "projectId"),
          {
            confidence: assumptionConfidence(text(body, "confidence")),
            expiresAt: text(body, "expiresAt"),
            owner: text(body, "owner"),
            statement: text(body, "statement"),
            testMethod: text(body, "testMethod"),
          },
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  const assumptionResultId = decodedItemPath(
    pathname,
    "/api/assumptions/",
    "/result",
  );
  if (assumptionResultId !== null) {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        assumption: store.recordAssumptionResult(
          actor(body),
          assumptionResultId,
          assumptionResult(text(body, "result")),
          text(body, "evidenceHash"),
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  if (pathname === "/api/tradeoffs") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        tradeoff: store.createTradeoff(
          actor(body),
          text(body, "id"),
          text(body, "projectId"),
          text(body, "question"),
          text(body, "yesCase"),
          text(body, "noCase"),
          text(body, "evidenceHash"),
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  const tradeoffDecisionId = decodedItemPath(
    pathname,
    "/api/tradeoffs/",
    "/decision",
  );
  if (tradeoffDecisionId !== null) {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        tradeoff: store.decideTradeoff(
          actor(body),
          tradeoffDecisionId,
          tradeoffDecision(text(body, "decision")),
          text(body, "reason"),
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  if (pathname === "/api/decisions") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        decision: store.recordDecision(
          actor(body),
          text(body, "id"),
          text(body, "projectId"),
          text(body, "subject"),
          decisionOutcome(text(body, "outcome")),
          text(body, "reason"),
          text(body, "evidenceHash"),
          typeof body.supersedesDecisionId === "string"
            ? body.supersedesDecisionId
            : null,
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  if (pathname === "/api/milestones") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        milestone: store.createMilestone(
          actor(body),
          text(body, "id"),
          text(body, "projectId"),
          {
            acceptanceTests: stringList(body, "acceptanceTests"),
            evidenceRequired: stringList(body, "evidenceRequired"),
            humanGate: text(body, "humanGate"),
            nonGoals: stringList(body, "nonGoals"),
            risks: stringList(body, "risks"),
            rollbackCondition: text(body, "rollbackCondition"),
            smallestUsefulResult: text(body, "smallestUsefulResult"),
            userProblem: text(body, "userProblem"),
          },
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  if (pathname === "/api/shapes") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        shapeBrief: store.createShapeBrief(
          actor(body),
          text(body, "id"),
          text(body, "projectId"),
          {
            assumptionIds: stringList(body, "assumptionIds"),
            desiredOutcome: text(body, "desiredOutcome"),
            effortLimit: text(body, "effortLimit"),
            evidenceHashes: stringList(body, "evidenceHashes"),
            ideaId: text(body, "ideaId"),
            nonGoals: stringList(body, "nonGoals"),
            openQuestions: stringList(body, "openQuestions"),
            owner: text(body, "owner"),
            rabbitHoles: stringList(body, "rabbitHoles"),
            risks: stringList(body, "risks"),
            scopeExpansionPaths: stringList(body, "scopeExpansionPaths"),
            solutionOutline: text(body, "solutionOutline"),
            successCriteria: stringList(body, "successCriteria"),
            targetUser: text(body, "targetUser"),
            userJourney: text(body, "userJourney"),
            userProblem: text(body, "userProblem"),
          },
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  const shapeApproveId = decodedItemPath(pathname, "/api/shapes/", "/approve");
  if (shapeApproveId !== null) {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        shapeBrief: store.approveShapeBrief(actor(body), shapeApproveId),
        state: snapshot(store),
      })),
    );
    return true;
  }
  if (pathname === "/api/launch-readiness") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        launchReadiness: store.createLaunchReadiness(
          actor(body),
          text(body, "id"),
          text(body, "projectId"),
          {
            candidateEvidenceHash: text(body, "candidateEvidenceHash"),
            changeNote: text(body, "changeNote"),
            knownLimits: stringList(body, "knownLimits"),
            owner: text(body, "owner"),
            privacySecurityDeclaration: text(
              body,
              "privacySecurityDeclaration",
            ),
            releaseChecklist: stringList(body, "releaseChecklist"),
            rollbackProcedure: text(body, "rollbackProcedure"),
            shapeBriefId: text(body, "shapeBriefId"),
            supportOwner: text(body, "supportOwner"),
            verificationEvidenceHashes: stringList(
              body,
              "verificationEvidenceHashes",
            ),
          },
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  const launchAuthorizeId = decodedItemPath(
    pathname,
    "/api/launch-readiness/",
    "/authorize",
  );
  if (launchAuthorizeId !== null) {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        launchReadiness: store.authorizeLaunchReadiness(
          actor(body),
          launchAuthorizeId,
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  if (pathname === "/api/outcome-reviews") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        outcomeReview: store.createOutcomeReview(
          actor(body),
          text(body, "id"),
          text(body, "projectId"),
          text(body, "shapeBriefId"),
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  const outcomeRecordId = decodedItemPath(
    pathname,
    "/api/outcome-reviews/",
    "/record",
  );
  if (outcomeRecordId !== null) {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        outcomeReview: store.recordOutcomeReview(
          actor(body),
          outcomeRecordId,
          text(body, "observedResult"),
          text(body, "changedAssumption"),
          outcomeDecision(text(body, "decision")),
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  if (pathname === "/api/work") {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        state: snapshot(store),
        work: store.createWork(
          actor(body),
          text(body, "id"),
          text(body, "projectId"),
          text(body, "title"),
        ),
      })),
    );
    return true;
  }

  const mandateId = decodedWorkPath(pathname, "/mandate");
  if (mandateId !== null) {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        evidence: store.issueMandate(
          actor(body),
          mandateId,
          new TextEncoder().encode(text(body, "content")),
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  const claimId = decodedWorkPath(pathname, "/claim");
  if (claimId !== null) {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        state: snapshot(store),
        work: store.claimWork(actor(body), claimId),
      })),
    );
    return true;
  }
  const evidenceId = decodedWorkPath(pathname, "/evidence");
  if (evidenceId !== null) {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        evidence: store.attachEvidence(
          actor(body),
          evidenceId,
          text(body, "kind"),
          new TextEncoder().encode(text(body, "content")),
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  const handoffId = decodedWorkPath(pathname, "/handoff");
  if (handoffId !== null) {
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        event: store.createHandoff(
          actor(body),
          handoffId,
          parseActor(text(body, "recipient")),
          text(body, "summary"),
        ),
        state: snapshot(store),
      })),
    );
    return true;
  }
  const testId = decodedWorkPath(pathname, "/test");
  if (testId !== null) {
    const verdict = text(body, "verdict");
    if (!isTestVerdict(verdict)) {
      throw new Error("Test verdict must be PASS, FAIL, or BLOCKED.");
    }
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        state: snapshot(store),
        work: store.recordTest(
          actor(body),
          testId,
          verdict,
          text(body, "evidenceHash"),
        ),
      })),
    );
    return true;
  }
  const judgeId = decodedWorkPath(pathname, "/judge");
  if (judgeId !== null) {
    const verdict = text(body, "verdict");
    if (!isJudgeVerdict(verdict)) {
      throw new Error("Judge verdict is invalid.");
    }
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        state: snapshot(store),
        work: store.recordJudge(
          actor(body),
          judgeId,
          verdict,
          text(body, "evidenceHash"),
        ),
      })),
    );
    return true;
  }
  const gateId = decodedWorkPath(pathname, "/gate");
  if (gateId !== null) {
    const decision = text(body, "decision");
    if (!isGateDecision(decision)) {
      throw new Error("Gate decision must be accept, reject, or stop.");
    }
    respondJson(
      response,
      200,
      withStore(root, (store) => ({
        state: snapshot(store),
        work: store.decideGate(actor(body), gateId, decision),
      })),
    );
    return true;
  }
  return false;
};

export const createLocalServer = (root: string): Server =>
  createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${localHost}`);
      if (url.pathname.startsWith("/api/")) {
        const handled = await handleApi(root, request, response, url.pathname);
        if (!handled) {
          respondJson(response, 404, { error: "Local API route not found." });
        }
        return;
      }
      if ((request.method ?? "GET") !== "GET") {
        respondJson(response, 405, {
          error: "Only GET is available for local assets.",
        });
        return;
      }
      const asset = staticAsset(url.pathname);
      if (asset === null) {
        respondJson(response, 404, { error: "Local asset not found." });
        return;
      }
      respondText(response, 200, asset.type, asset.content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respondJson(response, 400, { error: message });
    }
  });

export const startLocalServer = (
  root: string,
  port: number,
  onListening: (address: string) => void,
): Server => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  const server = createLocalServer(root);
  server.listen(port, localHost, () =>
    onListening(`http://${localHost}:${port}`),
  );
  return server;
};
