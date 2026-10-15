import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base './' lets the built site run from GitHub Pages (or any subfolder)
export default defineConfig({
  base: './',
  plugins: [react()],
  test: {
    environment: 'node',
  },
} as never)
