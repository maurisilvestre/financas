import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Em desenvolvimento (npm run dev), a API é o serviço "web" do compose, em 127.0.0.1:8737.
// changeOrigin: false mantém o Host e a Origin do próprio Vite, que a API aceita
// (ela só fala com 127.0.0.1/localhost e exige Origin igual ao Host nas escritas).
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:8737', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
