import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 本地开发：前端 5173，后端 PocketBase 默认跑在 8090，/api 走代理避免跨域
const PB_TARGET = process.env.VITE_PB_URL || 'http://127.0.0.1:8090'
// 对话式作战台的编排服务（console/server.py），默认 8091
const CONSOLE_TARGET = process.env.VITE_CONSOLE_URL || 'http://127.0.0.1:8091'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/phantomveil': { target: 'http://127.0.0.1:8092', changeOrigin: true,
        rewrite: path => path.replace(/^\/phantomveil/, '') },
      '/api': { target: PB_TARGET, changeOrigin: true },
      // SSE 要关掉缓冲，否则事件会被攒着不发
      '/console': { target: CONSOLE_TARGET, changeOrigin: true, ws: false },
    },
  },
})
