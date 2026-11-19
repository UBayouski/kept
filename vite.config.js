import { defineConfig } from 'vite';

// Pages: the app (review screen), the feasibility slice, the candidate-linking experiment, and the capture evaluation.
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', slice: 'slice.html', linking: 'linking.html', eval: 'eval.html' },
    },
  },
});
