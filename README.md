# @canonflow/workstream

`@canonflow/workstream` is a local-first Node.js command-line tool for one
controlled human-and-agent work loop:

```text
Human creates mandate
→ Architect agent performs permitted work
→ Independent Tester verifies the published package
→ LLM Judge evaluates immutable evidence
→ Human accepts, rejects, or stops
```

M0 keeps all state under `.workstream/`. M1 adds an optional loopback-only
local browser server. M2A adds Compass: evidence-backed local product direction
before a delivery milestone. M2B adds Shape and Launch Readiness: a bounded
proposal, local readiness evidence, and an Outcome Review record. M2C adds a
deterministic Decision Audit and redacted Handoff Pack for local review. It does not
need an account, a network connection, or a hosted service. Its governing limit is:

```text
authority ≤ evidence ≤ observed scope
```

An accepted work item records a human decision. It does not prove that a
change is correct, secure, complete, merged, released, or published.

## Install

Workstream requires Node.js 24 LTS. The repository pins Node 24.19.0 for
authoring. Install the package only after a human release decision.

```text
npm install @canonflow/workstream
workstream --help
```

## Quick local loop

```text
workstream init . --actor human:owner
workstream project create sample "Sample project" "A local record." --actor human:owner
workstream work create sample task-1 "Document M0" --actor human:owner
workstream mandate issue task-1 templates/mandate.md --actor human:owner
workstream work claim task-1 --actor architect-agent:builder
workstream evidence attach task-1 implementation report.json --actor architect-agent:builder
workstream test record task-1 PASS <test-evidence-sha256> --actor independent-tester:tester
workstream judge record task-1 Pass <judge-evidence-sha256> --actor llm-judge:judge
workstream gate decide task-1 accept --actor human:owner
workstream verify .
```

Attach the Tester and Judge receipts before recording their results. The CLI
prints the evidence SHA-256 when an attachment succeeds.

## M1 local browser

Start a browser view for the current local project:

```text
workstream serve . --port 3210
```

The server binds to `127.0.0.1` only. It provides a Project screen, Work
board, Evidence and handoff screen, and Human approval queue. The browser
calls only this local server and stores no credentials. Actor IDs supplied to
the local API are ledger labels, not authentication. Use this interface only
on a trusted local machine.

The Human approval queue shows only work that has a passing independent test
record and a Judge `Pass` record. A human ledger actor must still select accept,
reject, or stop. This is a trusted-local workflow control only. It does not
authorize a merge, publication, release, deployment, GitHub write, or another
external action. Browser activity remains local SQLite ledger activity.

## M2A Compass

Compass records testable product direction in the same local ledger. A Compass
draft has a named human owner and evidence-linked principles and non-goals. Only
that owner can approve it or supersede an approved version with a replacement
draft. `VISION.md` is generated from an approved version; it is never the
source of truth. Importing a generated `VISION.md` creates a new draft and
stores the imported file as local source evidence.

Compass also records an idea inbox, assumptions with an expiry and test method,
trade-off cards, immutable decisions that can explicitly supersede earlier
decisions, and milestone contracts. A `skeptic-agent:<id>` can record local
direction work but cannot claim build work, record a test or Judge result, or
make a gate decision. A decision is not evidence, and a green test is not user
value.

The loopback board has a Compass screen for local evidence, draft creation,
imports, and projections. It does not add a remote action capability. See
[Compass](docs/compass.md).

## M2B Shape and Launch Readiness

Shape turns a human-selected Compass idea into a small, testable proposal. A
Shape brief names its human owner and records the user problem, target user,
outcome, evidence, assumptions, effort limit, journey, non-goals, risks, open
questions, success criteria, scope-expansion paths, and excluded rabbit holes.
Only its named human owner can approve it.

Launch Readiness records candidate evidence, a user-facing note, known limits,
support owner, rollback procedure, verification evidence, privacy and security
declaration, and release checklist. The named human may record local
authorization only after a Shape brief is approved. This is preparation for a
separate decision—not an external launch permission. It never publishes,
releases, deploys, tags, makes a GitHub write, or runs a command.

Outcome Review preserves the original Shape success criteria as the expected
measure. A human can later record an observed result, changed assumption, and
keep, change, or stop decision. The loopback board adds distinct Shape, Launch
Readiness, and Outcome Review screens and surfaces the next local human
decision on the Project screen. See [Shape and Launch Readiness](docs/shaping-launch-readiness.md).

## M2C Decision Audit and Handoff Pack

Decision Audit reads existing local ledger records and reports stable findings
with a severity, subject ID, cause, and next local action. It makes missing
Compass direction, stale assumptions and ideas, incomplete gates, invalid
evidence, superseded decisions, unreviewed launch readiness, and explicit
Compass non-goal conflicts visible. It does not infer product value or execute
a correction.

Handoff Pack exports a project-level `handoff.json` and `handoff.md` that bind
to the exact event-chain hash and a canonical pack SHA-256. The pack includes
current local records, audit findings, and redacted evidence hashes and metadata
only—never raw evidence bytes. It is suitable for manual attachment to another
system, but Workstream makes no remote write. See [Decision Audit and Handoff Pack](docs/decision-audit-handoff.md).

## Local commands

| Command           | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| `init`            | Create local SQLite state and an initial ledger event. |
| `serve`           | Start the loopback-only local browser interface.       |
| `project create`  | Create a human-owned project record.                   |
| `work create`     | Create a ready work item.                              |
| `mandate issue`   | Store a human-issued mandate as evidence.              |
| `work claim`      | Allow an Architect agent to claim ready work.          |
| `evidence attach` | Store a content-addressed evidence object.             |
| `handoff create`  | Record a handoff between named actors.                 |
| `handoff export`  | Write a redacted project Handoff Pack.                 |
| `handoff verify`  | Check a pack against its current local event chain.    |
| `audit`           | Read deterministic Decision Audit findings.            |
| `test record`     | Record an Independent Tester result.                   |
| `judge record`    | Record an LLM Judge result.                            |
| `gate decide`     | Let a human accept, reject, or stop work.              |
| `export`          | Write a portable evidence bundle.                      |
| `import`          | Validate and import an empty local store.              |
| `verify`          | Verify the event chain and evidence bytes.             |
| `work show`       | Show one work item and its activity.                   |
| `work queue`      | Show ready work.                                       |
| `work blocked`    | Show blocked work.                                     |
| `activity`        | Show append-only ledger activity.                      |

The Compass, VISION, idea, assumption, trade-off, decision, milestone, Shape,
Launch Readiness, and Outcome Review
commands are listed in `workstream --help`. JSON input keeps complex records
explicit and replayable instead of inferring policy from free-form UI state.

## Guardrails

Only `human:<id>` can create projects, issue mandates, or decide a gate. An
Architect agent can claim only ready work. It cannot claim blocked work. An
agent cannot self-approve a work item.

M0, M1, M2A, M2B, and M2C do not contain commands that merge, tag, publish, release, deploy,
invite users, alter credentials, or change permissions. The local browser has
no command-execution path. The exported `GitHubDryRun` interface has no
network client and reports dry-run plans only.

## Evidence and portability

The SQLite ledger stores an event sequence, actor, timestamp, previous
SHA-256 hash, and event SHA-256 hash. Evidence bytes live at
`.workstream/evidence/sha256/<hash>`. `verify` recomputes each hash and checks
the chain.

`export` writes `manifest.json`, `events.ndjson`, and `evidence/sha256/`.
`import` rejects malformed schemas, changed events, unsafe evidence paths,
duplicate addresses, missing artifacts, and invalid hashes.

`workstream verify` exits with status 0 only when the event chain and evidence
bytes are valid. It exits with status 1 after it reports an invalid ledger.

See [architecture](docs/architecture.md), the [evidence contract](docs/evidence-contract.md),
the [Independent Tester plan](docs/independent-test-plan.md), and the
[Judge protocol](docs/judge-protocol.md).

## Development

```text
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

The Assay gates use a separate pinned Node 20.20.2 runner. Workstream itself
remains a Node 24 package. The runners fail closed when their actual Node
runtime differs from the published Assay toolchain. See the
[Assay boundary](docs/assay-boundary.md).

M0, M1, M2A, M2B, and M2C are licensed under [Apache-2.0](LICENSE).
