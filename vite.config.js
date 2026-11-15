import { defineConfig } from 'vite';

// Two pages: the slice itself and the candidate-linking experiment.
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', linking: 'linking.html' },
    },
  },
});
