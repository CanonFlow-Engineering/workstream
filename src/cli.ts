#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "./adapters/canonical.js";
import { parseActor, WorkstreamStore } from "./adapters/workstream-store.js";
import type {
  Actor,
  GateDecision,
  JudgeVerdict,
  TestVerdict,
} from "./domain/model.js";

const help = readFileSync(new URL("./cli-help.md", import.meta.url), "utf8");

interface ParsedArguments {
  readonly positional: readonly string[];
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
  const actorValue = optionValue(arguments_, "--actor");
  const positional: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const item = arguments_[index];
    if (item === "--root" || item === "--actor") {
      index += 1;
      continue;
    }
    if (item !== undefined) {
      positional.push(item);
    }
  }
  return {
    positional,
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

const testVerdicts = ["PASS", "FAIL", "BLOCKED"];
const judgeVerdicts = ["Pass", "Fail", "Inconclusive", "ToolFailure"];
const gateDecisions = ["accept", "reject", "stop"];

const isTestVerdict = (value: string): value is TestVerdict =>
  testVerdicts.some((item) => item === value);
const isJudgeVerdict = (value: string): value is JudgeVerdict =>
  judgeVerdicts.some((item) => item === value);
const isGateDecision = (value: string): value is GateDecision =>
  gateDecisions.some((item) => item === value);

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
