import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// /api/* → backend local (cổng 3001). Lên AWS thì đổi sang URL API Gateway qua VITE_API_BASE.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3001', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});
