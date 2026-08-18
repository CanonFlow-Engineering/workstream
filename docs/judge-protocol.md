# Judge protocol

The LLM Judge is read-only. It evaluates one exact candidate commit and writes
one immutable receipt outside the candidate source tree.

The Judge checks candidate identity and tree hash, package metadata, lockfile,
Node version, scripts, license, README, npm install reproducibility, format,
lint, typecheck, build, tests, packed artifact behavior, and import behavior.

It then runs the pinned TypeScriptAssay and STEAssay gates. A receipt with
`authoritative: false` fails the Judge gate even when its syntax is valid. The
Judge returns only `Pass`, `Fail`, `Inconclusive`, or `ToolFailure`.

The receipt records commands, versions, output hashes, gate results, verdict,
and limits. It does not modify the candidate or waive failures.

For M2B, the Judge confirms that Shape approval and launch-readiness
authorization are ledger-only records, not external-effect capabilities. It
checks that every readiness field is evidence-backed or explicitly stated, the
named human owner is enforced, the Outcome Review retains the original expected
measure, and no new remote client, credential, command-execution route, or
automatic launch behavior exists.
