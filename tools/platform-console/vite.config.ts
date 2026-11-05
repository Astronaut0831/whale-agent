import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 3101,
    proxy: {
      '/api': 'http://127.0.0.1:3100',
    },
  },
  build: {
    outDir: 'dist',
  },
});
