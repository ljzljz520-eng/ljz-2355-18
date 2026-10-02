#!/usr/bin/env node
// 初始化 PostgreSQL（执行 server/db/schema.sql）。
// 用法：DATABASE_URL=postgres://user:pass@localhost:5432/docs npm run review:db:init
import { PgRepo } from '../store/pg.js'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL 环境变量未设置，例如：')
  console.error('  DATABASE_URL=postgres://postgres:postgres@localhost:5432/docs npm run review:db:init')
  process.exit(1)
}

const repo = new PgRepo({ connectionString })
try {
  await repo.init()
  console.log('[db] schema applied successfully')
} catch (e) {
  console.error('[db] init failed:', e.message)
  process.exit(1)
} finally {
  await repo.close()
}
