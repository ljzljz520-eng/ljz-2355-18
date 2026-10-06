import fs from 'node:fs'
import path from 'node:path'
import { formatInZone, zonedDatePart } from './time.js'

/**
 * 由复审领域状态生成前端只读清单（VitePress 构建/签收后刷新）。
 * 静态站没有运行时后端：后台任务执行后重跑本构建器，页脚即刻反映真实状态。
 */
export function buildManifest(service, { generatedAt = service.now, extraPages = [] } = {}) {
  const entries = []
  for (const doc of service.repo.list('docs')) {
    if (!doc.currentReleaseId) continue
    const release = service.repo.get('releases', doc.currentReleaseId)
    const status = service.statusOf(release.id, generatedAt)
    const owner = doc.ownerId ? service.repo.get('users', doc.ownerId) : null
    const signoffs = service.repo.list('signoffs').filter(s => s.releaseId === release.id)
    const latestSignoff = signoffs.at(-1)
    const signoffUser = latestSignoff?.signedById ? service.repo.get('users', latestSignoff.signedById) : null

    let overdueExplanation = null
    if (status.task) overdueExplanation = service.explainOverdue(status.task.id, generatedAt)

    entries.push({
      docId: doc.id,
      path: doc.path,
      title: doc.title,
      version: release.version,
      publishedAt: release.publishedAt,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      // 声明范围 + 覆盖图
      scope: release.declaredScope.map(t => ({ id: t.id, label: t.label, kind: t.kind })),
      coverage: {
        total: status.coverage.total,
        passed: status.coverage.passed,
        failed: status.coverage.failed,
        pending: status.coverage.pending.map(p => ({
          targetId: p.targetId, label: p.label,
          revalidateReason: p.revalidate?.reason ?? null,
          changedBlocks: p.revalidate?.changedBlocks ?? null
        }))
      },
      // 公开日期：反映真实完成范围；不完整时为 null，站点只显示"信息需核实"提示
      publicDate: release.publicDate,
      lastPublicDate: release.lastPublicDate ?? null,
      signedAt: latestSignoff?.signedAt ?? null,
      signedBy: signoffUser ? { id: signoffUser.id, name: signoffUser.name } : null,
      signoffCount: signoffs.length,
      level: status.level,
      overdue: status.overdue,
      dueDate: status.task?.dueDate ?? null,
      taskId: status.task?.id ?? null,
      unassigned: status.task ? !status.task.assigneeId : !doc.ownerId,
      // 维护者可见的"为什么超期"
      overdueReasons: overdueExplanation?.reasons ?? [],
      generatedAt: generatedAt.toISOString()
    })
  }
  for (const page of extraPages) entries.push(page)

  return {
    zone: service.zone,
    generatedAt: generatedAt.toISOString(),
    generatedDay: zonedDatePart(service.zone, generatedAt),
    generatedAtLabel: formatInZone(generatedAt, service.zone),
    entries
  }
}

export function writeManifest(manifest, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2))
  return file
}
