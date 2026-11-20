import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const productionBuild = command === 'build'
  const fallback = productionBuild ? 'https://chattingapp-n4ig.onrender.com' : 'http://localhost:4000'
  const api = new URL(env.VITE_API_URL || fallback)
  if (productionBuild && (api.protocol !== 'https:' || api.username || api.password ||
      api.hostname === 'localhost' || api.hostname.endsWith('.localhost') || /^127\./.test(api.hostname) || api.hostname === '[::1]')) {
    throw new Error('A production build requires a hosted HTTPS API.')
  }
  const websocket = new URL(api.origin)
  websocket.protocol = 'wss:'
  return {
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify(api.origin) },
    plugins: [
      react(),
      {
        name: 'orbit-content-security-policy',
        apply: 'build',
        transformIndexHtml() {
          return [{ tag: 'meta', injectTo: 'head-prepend', attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: [
              "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
              "media-src 'self' blob:", "font-src 'self'", "object-src 'none'", "base-uri 'none'",
              "form-action 'none'", "frame-src 'none'", "worker-src 'none'",
              `connect-src 'self' ${api.origin} ${websocket.origin}`,
            ].join('; '),
          } }]
        },
      },
    ],
  }
})
