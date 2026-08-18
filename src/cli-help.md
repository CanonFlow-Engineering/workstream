workstream — local-first evidence ledger

Usage:

- Use `workstream init [path] --actor human:<id>`.
- Use `workstream serve [path] [--port 3210]` to open the loopback-only local browser interface.
- Use `workstream project create <project-id> <name> [description] --actor human:<id>`.
- Use `workstream compass evidence <project-id> <kind> <file> --actor human:<id>`.
- Use `workstream compass create <project-id> <compass-id> <compass-json> --actor human:<id>`.
- Use `workstream compass approve <compass-id> --actor human:<owner-id>`.
- Use `workstream compass supersede <current-compass-id> <replacement-compass-id> --actor human:<owner-id>`.
- Use `workstream vision export <project-id> <VISION.md-destination>`.
- Use `workstream vision import <project-id> <compass-id> <VISION.md-source> --actor human:<owner-id>`.
- Use `workstream idea create <project-id> <idea-id> <idea-json> --actor <kind>:<id>`.
- Use `workstream idea review <idea-id> <shaped|rejected|deferred> --actor human:<id>`.
- Use `workstream assumption create <project-id> <assumption-id> <assumption-json> --actor <kind>:<id>`.
- Use `workstream assumption result <assumption-id> <validated|invalidated> <evidence-sha256> --actor human:<id>`.
- Use `workstream tradeoff create <project-id> <trade-off-id> <trade-off-json> --actor <kind>:<id>`.
- Use `workstream tradeoff decide <trade-off-id> <accept|reject|defer> <reason> --actor human:<id>`.
- Use `workstream decision record <project-id> <decision-id> <decision-json> --actor human:<id>`.
- Use `workstream milestone create <project-id> <milestone-id> <milestone-json> --actor human:<id>`.
- Use `workstream shape create <project-id> <shape-brief-id> <shape-brief-json> --actor <kind>:<id>`.
- Use `workstream shape approve <shape-brief-id> --actor human:<owner-id>`.
- Use `workstream launch create <project-id> <launch-readiness-id> <launch-readiness-json> --actor <kind>:<id>`.
- Use `workstream launch authorize <launch-readiness-id> --actor human:<owner-id>`.
- Use `workstream outcome create <project-id> <outcome-review-id> <shape-brief-id> --actor human:<id>`.
- Use `workstream outcome record <outcome-review-id> <outcome-review-json> --actor human:<id>`.
- Use `workstream work create <project-id> <work-id> <title> --actor human:<id>`.
- Use `workstream mandate issue <work-id> <mandate-file> --actor human:<id>`.
- Use `workstream work claim <work-id> --actor architect-agent:<id>`.
- Use `workstream evidence attach <work-id> <kind> <file> --actor <kind>:<id>`.
- Use `workstream handoff create <work-id> <recipient-kind:id> <summary> --actor <kind>:<id>`.
- Use `workstream test record <work-id> <PASS|FAIL|BLOCKED> <evidence-sha256> --actor independent-tester:<id>`.
- Use `workstream judge record <work-id> <Pass|Fail|Inconclusive|ToolFailure> <evidence-sha256> --actor llm-judge:<id>`.
- Use `workstream gate decide <work-id> <accept|reject|stop> --actor human:<id>`.
- Use `workstream export <bundle-directory> [--root path]`.
- Use `workstream import <bundle-directory> [target-path]`.
- Use `workstream verify [path]`.
- Use `workstream work show <work-id> [--root path]`.
- Use `workstream work queue [--root path]`.
- Use `workstream work blocked [--root path]`.
- Use `workstream activity [work-id] [--root path]`.

Compass JSON uses `title`, `owner`, `principles`, and `nonGoals`. Each Compass
statement has `id`, `text`, and a project-linked `evidenceHash`. The generated
`VISION.md` is a projection of an approved Compass; importing it creates a new
draft linked to the imported file as local evidence.

Shape JSON names a selected shaped idea, named human owner, project-linked
evidence, assumption identifiers, bounded effort, solution and journey, and
explicit non-goals, risks, questions, success criteria, scope-expansion paths,
and rabbit holes. Launch-readiness JSON names an approved Shape brief, owner,
candidate and verification evidence, change note, limits, support owner,
rollback procedure, privacy and security declaration, and checklist. Outcome
records preserve the Shape success criteria as their expected measure.

The CLI writes only local SQLite state and content-addressed evidence. The browser server binds to `127.0.0.1` only. Actor IDs are ledger labels, not authentication. The human gate is a trusted-local workflow control and does not authorize external actions. The Skeptic role can record local direction work but cannot build, test, Judge, or approve a Compass, Shape, or launch-readiness record. GitHub output is dry-run only; M2B adds no two-way synchronization, credentials, command execution, or remote action capability. A local launch-readiness authorization never publishes, releases, deploys, tags, or writes to GitHub.
