import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy API + websocket to the backend so the frontend never hardcodes a host.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
});
