import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // canvas is a native module with platform DLLs; bundling it breaks loading.
        // Keep it external so Electron loads it from node_modules with all its deps.
        external: ['canvas']
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/renderer/index.html'
        }
      }
    }
  }
})