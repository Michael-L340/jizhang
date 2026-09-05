import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }

// 部署到 GitHub Pages 子路径时用 VITE_BASE=/jizhang/ 构建；其他托管用默认 '/'
const base = process.env.VITE_BASE ?? '/'

export default defineConfig({
  base,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png'],
      manifest: {
        id: base,
        name: '记账',
        short_name: '记账',
        description: '个人记账',
        lang: 'zh-CN',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f5f1ea',
        theme_color: '#f5f1ea',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        // 不缓存任何跨域请求（尤其是 supabase），只预缓存同源构建产物
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: true,
    // 项目在 /mnt/c 下，WSL 无法收到文件变更通知，必须轮询
    watch: { usePolling: true, interval: 300 },
  },
  build: { chunkSizeWarningLimit: 1500 },
  // TZ=UTC 是故意的：开发机在 +08，和北京时间同一个偏移，
  // 「忘了写 timeZone: 'Asia/Shanghai'」这类 bug 在本机跑测试时会全绿，到不了任何人手上才发作。
  // 把测试机拧到 UTC，日期/时间的用例才真的在验时区。
  test: { environment: 'node', include: ['src/**/*.test.ts'], env: { TZ: 'UTC' } },
})
