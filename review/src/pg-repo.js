// ============================================================================
// ReviewRepository 的 PostgreSQL 实现（pg 驱动）
// 与 sql/001_review_management.sql 配套；方法签名与 memory-repo.js 一致，
// test/acceptance.test.js 的同一套领域行为可换库回归。
//
//   import pg from 'pg'
//   const repo = new PgReviewRepository(new pg.Pool({ connectionString: ... }))
//
// 关键 SQL 不变量：
//   - uq_review_task_active_merge 部分唯一索引 → 两类触发合并/幂等建单
//   - review_trigger_ledger 主键 + ON CONFLICT DO NOTHING → 扫描/依赖/提醒重跑安全
//   - trg_owner_history_no_update → 责任交接只追加
//   - claims.full_scope + v_doc_public_review → 公开日期反映真实完成范围
// ============================================================================

const TASK_COLS = `id::text, doc_id AS "docId", release_id AS "releaseId", status,
  owner_id AS "ownerId", extract(epoch from due_at)*1000 AS "dueAt",
  created_via AS via, merge_key AS "mergeKey",
  extract(epoch from created_at)*1000 AS "createdAt", round_no AS round`
const SCOPE_COLS = `id::text, doc_id AS "docId", kind, ref, label, required,
  dep_fingerprint AS "depFingerprint"`
const CLAIM_COLS = `id::text, task_id AS "taskId", doc_id AS "docId", release_id AS "releaseId",
  signed_by AS "signedBy", signed_by_name AS "signedByName",
  extract(epoch from signed_at)*1000 AS "signedAt", doc_revision AS "docRevision",
  claimed_scope_fingerprint AS "scopeFingerprint", full_scope AS "fullScope", note`
const RESULT_COLS = `id::text, claim_id AS "claimId", task_id AS "taskId",
  scope_id::text AS "scopeId", result, checker, evidence, fail_reason AS "failReason",
  checked_fingerprint AS "checkedFingerprint",
  extract(epoch from checked_at)*1000 AS "checkedAt"`

export class PgReviewRepository {
  /** @param {import('pg').Pool} pool */
  constructor(pool) { this.pool = pool }
  async q(text, params = []) { return (await this.pool.query(text, params)).rows }
  async one(text, params = []) { return (await this.q(text, params))[0] || null }

  // ---------- 文档 / 人员 / 范围 ----------
  upsertDoc({ id, revision, locale, updatedAt }) {
    return this.one(`INSERT INTO docs (id, latest_revision, locale, updated_at)
      VALUES ($1,$2,$3,to_timestamp($4/1000.0))
      ON CONFLICT (id) DO UPDATE SET latest_revision=EXCLUDED.latest_revision,
        locale=EXCLUDED.locale, updated_at=EXCLUDED.updated_at
      RETURNING id, latest_revision AS revision, locale`, [id, revision, locale, updatedAt])
  }
  getDoc(id) { return this.one(`SELECT id, latest_revision AS revision, locale FROM docs WHERE id=$1`, [id]) }
  listDocs() { return this.q(`SELECT id, latest_revision AS revision, locale FROM docs`) }

  upsertPerson({ id, name, active, teamId }) {
    return this.one(`INSERT INTO people (id,name,active,team_id) VALUES ($1,$2,$3,$4)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, active=EXCLUDED.active, team_id=EXCLUDED.team_id
      RETURNING id,name,active,team_id AS "teamId"`, [id, name, active, teamId])
  }
  getPerson(id) {
    if (!id) return null
    return this.one(`SELECT id,name,active,team_id AS "teamId" FROM people WHERE id=$1`, [id])
  }

  async replaceScopes(docId, scopes) {
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN')
      await c.query('DELETE FROM doc_review_scopes WHERE doc_id=$1', [docId])
      for (const s of scopes) {
        await c.query(`INSERT INTO doc_review_scopes (doc_id,kind,ref,label,required,dep_fingerprint)
          VALUES ($1,$2,$3,$4,$5,$6)`, [docId, s.kind, s.ref, s.label, s.required, s.depFingerprint])
      }
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    return this.listScopes(docId)
  }
  listScopes(docId) { return this.q(`SELECT ${SCOPE_COLS} FROM doc_review_scopes WHERE doc_id=$1 ORDER BY ref`, [docId]) }

  // ---------- 触发台账（幂等） ----------
  hasTrigger(idemKey) {
    return this.one(`SELECT 1 AS x FROM review_trigger_ledger WHERE idempotency_key=$1`, [idemKey]).then(Boolean)
  }
  async recordTrigger({ idemKey, kind, ref, taskIds = [], payloadHash = '', ranAt }) {
    await this.q(`INSERT INTO review_trigger_ledger
        (idempotency_key,kind,ref,task_id,payload_hash,ran_at)
      VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0))
      ON CONFLICT (idempotency_key) DO NOTHING`,
      [idemKey, kind, ref, taskIds[0] || null, payloadHash, ranAt])
    return this.one(`SELECT * FROM review_trigger_ledger WHERE idempotency_key=$1`, [idemKey])
  }

  // ---------- 任务（合并 / 幂等） ----------
  async createOrMergeTask({ docId, releaseId, status, ownerId, dueAt, createdBy, via, mergeKey, createdAt }) {
    const row = await this.one(`
      INSERT INTO doc_review_tasks
        (doc_id,release_id,status,owner_id,due_at,created_by,created_via,merge_key,round_no,created_at)
      VALUES ($1,$2,$3,$4,CASE WHEN $5 IS NULL THEN NULL ELSE to_timestamp($5/1000.0) END,$6,$7,$8,
        COALESCE((SELECT max(round_no)+1 FROM doc_review_tasks WHERE merge_key=$8),1),
        to_timestamp($9/1000.0))
      ON CONFLICT (merge_key) WHERE status IN ('open','in_progress','stale')
      DO UPDATE SET merge_key = EXCLUDED.merge_key  -- no-op，命中即返回既有活跃单
      RETURNING ${TASK_COLS}, (xmax = 0) AS "isNew"`,
      [docId, releaseId, status, ownerId, dueAt ?? null, createdBy, via, mergeKey, createdAt])
    // sources：该活跃轮被哪些触发来源命中过（台账可追溯）
    row.sources = (await this.q(
      `SELECT DISTINCT kind FROM review_trigger_ledger WHERE task_id=$1`, [row.id])).map((r) => r.kind)
    row.merged = !row.isNew
    return row
  }
  getTask(id) { return this.one(`SELECT ${TASK_COLS} FROM doc_review_tasks WHERE id=$1`, [id]) }
  findActiveTask(mergeKey) {
    return this.one(`SELECT ${TASK_COLS} FROM doc_review_tasks
      WHERE merge_key=$1 AND status IN ('open','in_progress','stale') ORDER BY round_no DESC LIMIT 1`, [mergeKey])
  }
  listActiveTasks() { return this.q(`SELECT ${TASK_COLS} FROM doc_review_tasks
    WHERE status IN ('open','in_progress','stale')`) }
  updateTaskStatus(id, status) { return this.q(`UPDATE doc_review_tasks SET status=$2 WHERE id=$1`, [id, status]) }
  updateTaskOwner(id, ownerId) { return this.q(`UPDATE doc_review_tasks SET owner_id=$2 WHERE id=$1`, [id, ownerId]) }
  markStale(id) { return this.q(`UPDATE doc_review_tasks SET status='stale' WHERE id=$1 AND status <> 'signed'`, [id]) }

  // ---------- 责任交接（只追加，PG trigger 禁止 UPDATE/DELETE） ----------
  appendOwnerHistory({ taskId, docId, releaseId, fromOwner, toOwner, reason, changedBy, changedAt }) {
    return this.one(`INSERT INTO doc_review_owner_history
        (task_id,doc_id,release_id,from_owner,to_owner,reason,changed_by,changed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0))
      RETURNING id::text, from_owner AS "fromOwner", to_owner AS "toOwner", reason`,
      [taskId, docId, releaseId, fromOwner, toOwner, reason, changedBy, changedAt])
  }

  // ---------- 内容变化 ----------
  insertContentChange({ docId, revision, changedAt, changeKind, affectedScopeIds, summary }) {
    return this.one(`INSERT INTO doc_content_changes
        (doc_id,revision,changed_at,change_kind,affected_scopes,summary)
      VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5::uuid[],$6)
      RETURNING id::text, doc_id AS "docId"`,
      [docId, revision, changedAt, changeKind, affectedScopeIds, summary])
  }
  listContentChanges(docId) {
    return this.q(`SELECT id::text, doc_id AS "docId", revision,
      extract(epoch from changed_at)*1000 AS "changedAt", change_kind AS "changeKind", summary
      FROM doc_content_changes WHERE doc_id=$1 ORDER BY changed_at`, [docId])
  }

  // ---------- 签收草稿 / 逐项证据 ----------
  // 每轮一个未提交 claim 行（committed 用 signed_at 是否 NULL 表示：草稿 checked_at 先行）。
  // 为简化模型，草稿 claim 也落库但 signed_by 为空串，commit 时再 UPDATE。
  async workingClaim(taskId, opts = {}) {
    let w = await this.one(`SELECT ${CLAIM_COLS} FROM doc_review_claims
      WHERE task_id=$1 AND signed_by='' ORDER BY created_seq DESC LIMIT 1`, [taskId])
    if (!w) {
      const t = await this.getTask(taskId)
      w = await this.one(`INSERT INTO doc_review_claims
          (task_id,doc_id,release_id,signed_by,signed_at,doc_revision,claimed_scope_fingerprint,full_scope)
        VALUES ($1,$2,$3,'',to_timestamp($4/1000.0),'','',false)
        RETURNING ${CLAIM_COLS}`, [taskId, t.docId, t.releaseId, Date.now()])
      if (opts.carryFromClaimId) {
        await this.q(`INSERT INTO doc_review_item_results
            (claim_id,task_id,scope_id,result,checker,checked_at,evidence,fail_reason,checked_fingerprint)
          SELECT $1, task_id, scope_id, result, checker, checked_at, evidence, fail_reason, checked_fingerprint
          FROM doc_review_item_results WHERE claim_id=$2`, [w.id, opts.carryFromClaimId])
      }
    }
    return w
  }
  upsertItemResult({ claimId, taskId, scopeId, result, checker, evidence, failReason, checkedFingerprint, checkedAt }) {
    return this.one(`INSERT INTO doc_review_item_results
        (claim_id,task_id,scope_id,result,checker,checked_at,evidence,fail_reason,checked_fingerprint)
      VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7,$8,$9)
      ON CONFLICT (claim_id, scope_id) DO UPDATE SET
        result=EXCLUDED.result, checker=EXCLUDED.checker, checked_at=EXCLUDED.checked_at,
        evidence=EXCLUDED.evidence, fail_reason=EXCLUDED.fail_reason,
        checked_fingerprint=EXCLUDED.checked_fingerprint
      RETURNING ${RESULT_COLS}`,
      [claimId, taskId, scopeId, result, checker, checkedAt, evidence, failReason, checkedFingerprint])
  }
  listItemResults(claimId) { return this.q(`SELECT ${RESULT_COLS} FROM doc_review_item_results WHERE claim_id=$1`, [claimId]) }

  async commitClaim({ id, taskId, docId, releaseId, signedBy, signedByName, signedAt,
                      docRevision, scopeFingerprint, fullScope, note }) {
    return this.one(`UPDATE doc_review_claims SET
        signed_by=$2, signed_by_name=$3, signed_at=to_timestamp($4/1000.0),
        doc_revision=$5, claimed_scope_fingerprint=$6, full_scope=$7, note=$8
      WHERE id=$1 RETURNING ${CLAIM_COLS}`,
      [id, signedBy, signedByName, signedAt, docRevision, scopeFingerprint, fullScope, note])
  }

  latestClaimForTask(taskId) {
    return this.one(`SELECT ${CLAIM_COLS} FROM doc_review_claims
      WHERE task_id=$1 AND signed_by<>'' ORDER BY signed_at DESC, created_seq DESC LIMIT 1`, [taskId])
  }
  latestClaimAny(docId) {
    return this.one(`SELECT ${CLAIM_COLS} FROM doc_review_claims
      WHERE doc_id=$1 AND signed_by<>'' ORDER BY signed_at DESC, created_seq DESC LIMIT 1`, [docId])
  }
  latestFullClaim(docId) {
    return this.one(`SELECT ${CLAIM_COLS} FROM doc_review_claims
      WHERE doc_id=$1 AND full_scope=true ORDER BY signed_at DESC, created_seq DESC LIMIT 1`, [docId])
  }

  // 正文/依赖变化：相关项打回 pending（证据保留可读）
  async invalidateItemResults(taskId, scopeIds, now) {
    const claim = await this.latestClaimForTask(taskId)
    if (!claim) return
    await this.q(`UPDATE doc_review_item_results SET result='pending'
      WHERE claim_id=$1 AND scope_id = ANY($2::uuid[])`,
      [claim.id, scopeIds])
  }

  // 新一轮继承上轮证据，受影响 scope 回到 pending
  async seedNewRoundFromClaim({ taskId, sourceClaimId, affectedScopeIds, now }) {
    const w = await this.workingClaim(taskId)
    await this.q(`INSERT INTO doc_review_item_results
        (claim_id,task_id,scope_id,result,checker,checked_at,evidence,fail_reason,checked_fingerprint)
      SELECT $1, task_id, scope_id,
        CASE WHEN cardinality($3::uuid[])=0 OR scope_id = ANY($3::uuid[]) THEN 'pending' ELSE result END,
        checker, checked_at, evidence, fail_reason, checked_fingerprint
      FROM doc_review_item_results WHERE claim_id=$2
      ON CONFLICT (claim_id, scope_id) DO NOTHING`,
      [w.id, sourceClaimId, affectedScopeIds])
    return w
  }
}
