import { defineConfig } from 'vitest/config'

// 数据库集成测试单独一个配置：它要在内存里启动一个真的 Postgres（PGlite），
// 一次约 20 秒，不适合放进每次改代码都跑的 npm test，更不该卡住 npm run deploy。
// 动了 supabase/migrations/ 或 api.ts 的导入导出时手动跑一次：npm run test:db
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.dbtest.ts'], testTimeout: 180_000 },
})
