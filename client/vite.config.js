import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3100,
    proxy: {
      '/api': 'http://localhost:5100',
      '/socket.io': { target: 'http://localhost:5100', ws: true },
    },
  },
});
