import { defineConfig } from '@vite-pwa/assets-generator/config'

// 图标生成器默认给 apple-touch-icon 留 30% 的白色内边距（padding 0.3 + 白底），
// 结果主屏上是「白框里套一个奶白图标」，两层圆角很难看。
// 这里全部改成不留边、底色用图标自己的奶白，maskable 例外——
// 安卓会按圆形裁剪，得留一点安全区，但底色同样是奶白，不能是白。
const CREAM = '#f7f0e4'

export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    transparent: { sizes: [64, 192, 512], favicons: [[48, 'favicon.ico']], padding: 0 },
    maskable: { sizes: [512], padding: 0.12, resizeOptions: { background: CREAM } },
    apple: { sizes: [180], padding: 0, resizeOptions: { background: CREAM } },
  },
  images: ['public/logo.svg'],
})
