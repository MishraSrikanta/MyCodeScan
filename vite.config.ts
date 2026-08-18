import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  /* Relative asset paths, so the built folder works from a domain root, a
     subdirectory or a CDN path without rebuilding. */
  base: './',
  server: {
    port: 5175,
    /* Reachable from a phone on the same network — the whole point of this app.
       Note that camera access still needs HTTPS or localhost; see README.md. */
    host: true,
  },
})
