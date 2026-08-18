# M2C Decision Audit and Handoff Pack

M2C is a local, deterministic review layer over the existing append-only
ledger. It does not add a remote service, identity system, command runner, or
external-action path.

## Decision Audit

`workstream audit <project-id>` reads one project projection and returns stable
findings. A finding has a rule ID, `Blocker`, `Attention`, or `Information`
severity, a local subject identifier, a cause, and a next local action.

- `WSA-A01` is a Blocker when Shape or Launch data exists without an approved Compass.
- `WSA-A02` is a Blocker when an approved Shape uses an expired, invalidated, or missing assumption.
- `WSA-A03` is Attention when a selected idea has expired.
- `WSA-A04` is Attention when a Launch Readiness record is not locally authorized.
- `WSA-A05` is Attention when authorized Launch Readiness has no Outcome Review record.
- `WSA-A06` is Information when a decision has been superseded and is not current direction.
- `WSA-A07` is Attention when work awaits a human gate.
- `WSA-A08` is a Blocker when a human gate lacks passing Tester or Judge evidence.
- `WSA-A09` is a Blocker when a referenced evidence object is absent or fails verification.
- `WSA-A10` is Attention when Shape, Launch, or Outcome text conflicts with a current Compass non-goal.

The non-goal check is deliberately bounded. It recognizes an explicit positive
reuse of the text after a leading `Do not`, `Must not`, `No`, `Never`, or
`Without` prohibition. It does not infer intent or natural-language meaning.

## Handoff Pack

`workstream handoff export <project-id> <directory>` writes `handoff.json` and
`handoff.md`. Both are projections, not sources of truth. The JSON pack holds:

- the current Compass and project-local records;
- open work gates and deterministic audit findings;
- redacted evidence addresses and byte counts only;
- the source-ledger verification result and final event-chain hash; and
- a pack SHA-256 calculated from canonical pack content.

Evidence bytes are never copied into a Handoff Pack. A human may attach the
pack manually to a GitHub issue or pull request, but M2C makes no GitHub read
or write. `workstream handoff verify` rejects a modified pack or a pack that
does not bind to the current local event chain.
