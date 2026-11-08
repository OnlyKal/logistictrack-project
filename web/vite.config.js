import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const target = process.env.VITE_API_PROXY ?? 'http://localhost:3000'

// En développement, l'API et le WebSocket passent par le serveur Vite (même origine).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target, changeOrigin: true },
      '/socket.io': { target, changeOrigin: true, ws: true },
    },
  },
})
