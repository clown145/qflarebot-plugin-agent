import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/integration/**/*.test.ts'] },
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL(
          './node_modules/@qqbot/plugin-cli/dist/stubs/cloudflare-workers.js',
          import.meta.url,
        ),
      ),
      '@qqbot/runtime/testing': fileURLToPath(
        new URL('../QFlareBot/packages/runtime/src/testing/index.ts', import.meta.url),
      ),
      '@qflarebot-test/t2i': fileURLToPath(
        new URL('../QFlareBot/plugins/t2i/src/index.ts', import.meta.url),
      ),
    },
  },
})
