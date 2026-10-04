import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative URLs work on the GitHub Pages project path and a custom domain.
  base: './',
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        trafficVolume: fileURLToPath(new URL('./traffic-volume.html', import.meta.url)),
      },
    },
  },
})
