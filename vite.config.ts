import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// 生产构建把 CSP 写进单文件 HTML：禁止任何外部连接，只允许本地文件资源。
// Vite 开发服务器需要 WebSocket 热更新，因此只在 build 阶段注入。
const offlineCsp = (): Plugin => ({
  name: 'ielts-simulator-offline-csp',
  apply: 'build',
  transformIndexHtml(html) {
    const policy = [
      "default-src 'none'",
      "script-src 'unsafe-inline' 'unsafe-eval'",
      "style-src 'unsafe-inline'",
      'img-src file: data: blob:',
      'media-src file: data: blob:',
      'font-src data:',
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ')
    return html.replace('</head>', `    <meta http-equiv="Content-Security-Policy" content="${policy}" />\n  </head>`)
  },
})

export default defineConfig({
  root: path.join(dirname, 'app'),
  base: './',
  // 题库和音频留在便携目录，不复制进构建产物
  publicDir: false,
  plugins: [react(), viteSingleFile(), offlineCsp()],
  resolve: {
    alias: { '@': path.join(dirname, 'app', 'src') },
  },
  build: {
    outDir: path.join(dirname, 'dist'),
    emptyOutDir: true,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 10000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
