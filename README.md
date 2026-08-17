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
local browser server. It does not need an account, a network connection, or a
hosted service. Its governing limit is:

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

## M0 and M1 commands

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

## Guardrails

Only `human:<id>` can create projects, issue mandates, or decide a gate. An
Architect agent can claim only ready work. It cannot claim blocked work. An
agent cannot self-approve a work item.

M0 and M1 do not contain commands that merge, tag, publish, release, deploy,
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

M0 and M1 are licensed under [Apache-2.0](LICENSE).
