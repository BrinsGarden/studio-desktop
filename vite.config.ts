import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Serve and ship the ONNX Runtime WebAssembly files next to the app (under ort/),
 * so the AI cutout doesn't depend on a third-party CDN and always matches the bundled version.
 */
function ortAssets(): Plugin {
  // prefer the copy transformers.js depends on, if npm nested it
  const ortDir = ['node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist', 'node_modules/onnxruntime-web/dist']
    .map((p) => join(import.meta.dirname, p))
    .find((p) => existsSync(p))!
  const files = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']
  return {
    name: 'ort-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/\/ort\/([^?]+)/)
        if (!m || !files.includes(m[1])) return next()
        res.setHeader('Content-Type', m[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        createReadStream(join(ortDir, m[1])).pipe(res)
      })
    },
    generateBundle() {
      for (const f of files) this.emitFile({ type: 'asset', fileName: `ort/${f}`, source: readFileSync(join(ortDir, f)) })
    },
  }
}

// base './' lets the built site run from GitHub Pages (or any subfolder)
export default defineConfig({
  base: './',
  plugins: [react(), ortAssets()],
  worker: { format: 'es' },
  test: {
    environment: 'node',
  },
} as never)
