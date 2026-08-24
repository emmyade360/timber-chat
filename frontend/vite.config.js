import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// The release workflow keeps package.json in step with VERSION at the repo
// root, so reading it here means the shipped bundle always states the build it
// came from.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// https://vite.dev/config/
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'prompt',
      includeAssets: ['timber.svg'],
      manifest: {
        id: '/',
        name: 'Timber private chat',
        short_name: 'Timber',
        description: 'Private one-to-one conversations that stay on your terms.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#2c1a0e',
        theme_color: '#5c3317',
        icons: [
          { src: '/icons/timber-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icons/timber-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  test: {
    environment: 'node',
    // The vault suite runs the real scrypt (N = 2^16) once per unlock attempt,
    // and the self-destruct test spends the whole attempt limit. That is ~4.4s
    // on an idle machine, which overruns the 5s default the moment CI shares a
    // runner. The KDF is deliberately slow; the budget was the wrong part.
    testTimeout: 30_000,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.js', 'src/**/*.test.jsx'],
  },
})
