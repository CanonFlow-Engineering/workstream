# M2C Decision Audit and Handoff Pack

M2C is a local, deterministic review layer over the existing append-only
ledger. It does not add a remote service, identity system, command runner, or
external-action path.

## Decision Audit

`workstream audit <project-id>` reads one project projection and returns stable
findings. A finding has a rule ID, `Blocker`, `Attention`, or `Information`
severity, a local subject identifier, a cause, and a next local action.

| Rule      | Condition                                                                | Severity    |
| --------- | ------------------------------------------------------------------------ | ----------- |
| `WSA-A01` | Shape or Launch data exists without an approved Compass                  | Blocker     |
| `WSA-A02` | An approved Shape uses an expired, invalidated, or missing assumption    | Blocker     |
| `WSA-A03` | A selected idea has expired                                              | Attention   |
| `WSA-A04` | A Launch Readiness record is not locally authorized                      | Attention   |
| `WSA-A05` | Authorized Launch Readiness has no Outcome Review template               | Attention   |
| `WSA-A06` | A decision has been superseded and is not current direction              | Information |
| `WSA-A07` | Work awaits a human gate                                                 | Attention   |
| `WSA-A08` | A human gate lacks passing Tester or Judge evidence                      | Blocker     |
| `WSA-A09` | A referenced evidence object is absent or fails verification             | Blocker     |
| `WSA-A10` | Shape, Launch, or Outcome text conflicts with a current Compass non-goal | Attention   |

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

## Draft templates

The built-in `npm-package`, `assay-rule-policy-change`,
`protocol-standards-integration`, and `release-preparation-milestone` templates
create only human-owned local drafts. Their prompt text makes missing evidence
visible. A template cannot approve a Compass, Shape, decision, or launch
record, and it cannot create an external effect.
