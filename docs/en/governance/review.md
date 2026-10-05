---
title: Product Documentation Review Management
---

# Product Documentation Review Management

Every product page footer shows three facts: the **owner** (last person who fully
signed off, preserved across handovers), the **verified scope** (fingerprint plus
per-item evidence), and the **date** of the latest sign-off in which **every**
declared scope item passed — reflecting the real completed scope.

<script setup lang="ts">
import { ref } from 'vue'
import { currentReview, needsVerificationReview, declaredScope } from '../../.vitepress/review-demo-data'
import { zonedDate } from '../../.vitepress/zoned-util'
const zone = ref('Asia/Shanghai')
const fmt = (iso: string) => zonedDate(new Date(iso).getTime(), zone.value)
</script>

<ZoneSwitch v-model="zone" />

## 1. Passed review: footer reflects the real scope

<ReviewStateBanner :state="currentReview" />

<CoverageGraph :declared="declaredScope"
  :covered="{
    'examples/button/basic.vue': { result: 'pass' },
    'examples/button/variant.vue': { result: 'pass' },
    'coverage/install-flow': { result: 'pass' }
  }"
  doc-title="Installation guide · declared scope" />

<ReviewFooter :state="currentReview" />

## 2. Due or key content changed: flag only, never remove history

Expiry never takes content offline or rewrites a historical sign-off. A key body
change only returns the **affected items** to "re-check"; unrelated items stay valid.

<ReviewStateBanner :state="needsVerificationReview" />

<CoverageGraph :declared="declaredScope"
  :covered="{
    'examples/button/basic.vue': { result: 'pending' },
    'examples/button/variant.vue': { result: 'pass' },
    'coverage/install-flow': { result: 'pass' }
  }"
  doc-title="Quick start · one item back to re-check" />

<ReviewFooter :state="needsVerificationReview" />

## 3. Coverage graph must satisfy the declared scope

Checking one demo is **not** a full review. The graph must cover every required
item in the declared scope; otherwise a sign-off is archived but cannot advance
the public date.

<CoverageGraph :declared="declaredScope"
  :covered="{ 'examples/button/basic.vue': { result: 'pass' } }"
  doc-title="Only one demo checked → scope not satisfied" />

## 4. Site timezone switching

Deadlines are stored as `timestamptz` and rendered in the site timezone. Current
zone: **{{ zone }}**; the installation page's latest sign-off date is
**{{ fmt('2026-09-20T07:32:00Z') }}** (the previous calendar day at UTC−08:00).

## 5. Handovers and missing successors

When an owner leaves or a team changes, only **open todos** are reassigned and an
append-only handover record is written. Historical signers are never overwritten;
the footer shows the historical signer and separately lists the current todo owner.
With no successor, the todo stays open, visible, and labeled "no successor owner".

## 6. Two kinds of backend maintenance tasks

| Trigger | Behavior |
| :--- | :--- |
| Periodic scan | Creates a maintenance task per due doc per release with a timezone-aware due date |
| Dependency change | Key body/upstream change returns affected items to re-check and opens a task |

The two are **merged** into one active task per `(doc, release)`; a trigger ledger
makes scan batches, dependency events and reminder batches idempotent on rerun —
no duplicate tickets, no duplicate reminders.

## 7. Maintainers see *why* it is overdue

Todo details spell out the reasons — past deadline, owner left without successor,
per-item failure reasons, and content-change summaries — instead of a bare yellow tag.
