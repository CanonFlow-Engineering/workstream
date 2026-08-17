# Agent operating rules

This repository records controlled work. Agents work only within a human
mandate and an assigned work item.

## Required sequence

1. A human creates the project, work item, and mandate.
2. An Architect agent claims ready work and attaches implementation evidence.
3. An Independent Tester records package-level test evidence.
4. An LLM Judge records one evidence-based verdict.
5. A human accepts, rejects, or stops the work.

## Prohibited agent actions

An agent must not self-approve work. An agent must not claim blocked work.
M0 through M2B have no agent path for merge, tag, publication, release, deployment,
user invitation, credential change, or permission change. M1's browser server
binds to loopback only and has no GitHub synchronization path. Actor IDs sent
to the local API identify ledger roles only; they are not authentication.

Do not treat a ledger event as proof beyond its attached evidence. Preserve
the local evidence bytes and use `workstream verify` before handoff.

## Compass and Skeptic role

Compass direction is local ledger data. A named human owner approves or
supersedes a Compass version. Principles and non-goals require linked evidence.
`VISION.md` is generated from an approved version; imported vision text creates
a new draft with source evidence.

A `skeptic-agent` may create local direction records, but cannot claim work,
record tests, record Judge results, or decide a gate. It cannot approve Compass
versions, Shape briefs, or launch-readiness records. A decision is not evidence
and does not authorize an external action.

## Shape and launch readiness

M2B Shape briefs, readiness records, and outcome reviews are local ledger data.
Only the named human owner approves a Shape brief or records launch-readiness
authorization. That authorization is evidence of a trusted-local workflow
decision only. It never permits a merge, tag, publication, release, deployment,
GitHub write, command execution, or another external action.

## Policy and workflow changes

Review changes to `.workstream` policy and automation with the same care as a
continuous-integration workflow. Do not execute unreviewed commands or accept
evidence from an untrusted source.
