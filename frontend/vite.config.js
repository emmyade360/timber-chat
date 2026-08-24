import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
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
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.js', 'src/**/*.test.jsx'],
  },
})
