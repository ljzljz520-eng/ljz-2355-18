# Documentation Re-Review Management

Product docs stay accurate only if someone is accountable after each release. This feature exposes
**owner, verified scope and completion date** in the page footer, while maintenance tasks,
responsibility handovers and review evidence live in the backend and PostgreSQL.

## What the footer shows

- **Owner** — current responsible person (updated after leave or team changes).
- **Verified scope** — the nodes actually checked in the latest sign-off.
- **Declared scope** — what the page promises to cover; the review-item coverage graph must satisfy
  it or sign-off is rejected.
- **Completed on / signed by** — real sign-off time, switchable between `Asia/Shanghai` and `UTC`;
  the underlying instant never changes.
- A green **verified** or amber **verification needed** badge, with the **reasons listed underneath**
  instead of an unexplained label.

Partial sign-offs list only the nodes that truly passed, plus the uncovered ones with notes —
checking one example never counts as reviewing the whole page.

## Tasks, merging and idempotency

Tasks come from releases (`release:<version>`), periodic cycle scans
(`cycle:<period>d:<bucketStart>`, bucket boundaries computed in the site timezone) and dependency
changes (`dep:<depId>:<depVersion>`). Repeated triggers with the same key create no duplicate tasks.
Open periodic and dependency tasks for the same page **merge into one todo**, accumulating items and
sources; a task that already carries review progress always survives the merge so evidence is never
lost. Reminders (`due_soon` / `overdue`) fire at most once per task per kind and are safe to re-run.

## Handovers and evidence

Leaving the team or being reassigned **reassigns open todos** with an audit trail, but never rewrites
historical signers. With no successor the task becomes `blocked_no_owner` (cannot be signed, never
deleted). Sign-offs, checks, evidence and handovers are append-only tables guarded by triggers.

## Expiry and content changes

Expiry only adds a "verification needed" notice — **historical content stays readable**. Material
content or dependency changes bump affected review items to a new revision, invalidating prior
conclusions; a sign-off is rejected when the page hash changed mid-review.

Run `npm run review:demo` / `npm run review:test` for the end-to-end walkthrough and acceptance cases.
