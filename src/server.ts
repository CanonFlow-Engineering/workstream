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

const isTestVerdict = (value: string): value is TestVerdict =>
  value === "PASS" || value === "FAIL" || value === "BLOCKED";

const isJudgeVerdict = (value: string): value is JudgeVerdict =>
  value === "Pass" ||
  value === "Fail" ||
  value === "Inconclusive" ||
  value === "ToolFailure";

const isGateDecision = (value: string): value is GateDecision =>
  value === "accept" || value === "reject" || value === "stop";

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

const handleApi = async (
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  const method = request.method ?? "GET";
  if (pathname === "/api/health" && method === "GET") {
    respondJson(response, 200, {
      githubIntegration: "dry-run-only",
      localOnly: true,
      status: "ok",
    });
    return true;
  }
  if (pathname === "/api/state" && method === "GET") {
    respondJson(response, 200, withStore(root, snapshot));
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
