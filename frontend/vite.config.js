import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Proxy API + websocket to the backend so the frontend never hardcodes a host.
// API_URL points a second dashboard at another backend (e.g. a sandbox on :3099).
const API = process.env.API_URL || 'http://localhost:3001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/socket.io': { target: API, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.js'],
  },
});
