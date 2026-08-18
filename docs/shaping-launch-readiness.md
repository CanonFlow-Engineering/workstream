# Shape and Launch Readiness

M2B turns a human-selected local Compass idea into a bounded proposal and
prepares the evidence for a later human launch decision. It does not launch,
publish, release, deploy, tag, notify, or create any other external effect.

## Shape brief

A Shape brief is an append-only ledger record that names a selected idea and
its named human owner. It must contain:

- the user problem, target user, and desired outcome;
- project-linked evidence and stated assumption identifiers;
- an effort or cost limit, solution outline, and user journey;
- non-goals, risks, open questions, measurable success criteria;
- likely scope-expansion paths and excluded rabbit holes.

The selected idea must already be `shaped` by a human. Only the named human
owner can approve the brief. Approval is a local workflow event, not proof of
user value and not permission to build beyond the recorded scope.

## Launch-readiness record

A launch-readiness record can be prepared only from an approved Shape brief.
It requires candidate evidence, a user-facing change note, known limits, a
support owner, rollback procedure, verification evidence, a privacy and
security declaration, and a checklist.

The named human owner can record local authorization after inspection. That
event never invokes a package registry, version-control host, deployment,
release system, network client, command runner, or credential. A later launch
requires a separate human mandate and an implementation outside this scope.

## Outcome review

An Outcome Review copies the Shape brief's success criteria as its immutable
expected measure. A human later records an observed result, changed assumption,
and one `keep`, `change`, or `stop` decision. The original expected measure is
preserved so learning does not rewrite the prediction after the fact.

## Safety and portability

The SQLite ledger and its content-addressed evidence remain the source of
truth. Shape, readiness, authorization, and outcome events are replayed during
bundle import only after manifest, hash-chain, and evidence verification.

Actor labels are trusted-local workflow labels, not identity authentication.
The Skeptic can challenge direction but cannot approve a Shape brief or
authorize readiness. There is no GitHub integration, remote synchronization,
credential handling, account system, hosted service, command execution,
publication, release, deployment, or automatic launch action.
