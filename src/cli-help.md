workstream — local-first evidence ledger

Usage:

- Use `workstream init [path] --actor human:<id>`.
- Use `workstream project create <project-id> <name> [description] --actor human:<id>`.
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

The CLI writes only local SQLite state and content-addressed evidence. GitHub output is dry-run only in M0.
