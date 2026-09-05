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
      // ★ 图标文件名带 -v2：图标不像 JS 那样自动带哈希，名字不变的话 Safari 会一直用缓存里那张，
      // 连「从主屏删掉再重新添加」都救不回来（实测：换成暖色图标后主屏还是蓝的）。
      // 以后再换图标，把后缀 +1，别原地覆盖。
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180-v2.png'],
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
        background_color: '#faf7f2',
        theme_color: '#faf7f2',
        icons: [
          { src: 'pwa-64x64-v2.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192-v2.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512-v2.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512-v2.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
