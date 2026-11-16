import { defineConfig } from 'vite';

// Pages: the slice, the candidate-linking experiment, the review screen, and the capture evaluation.
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', linking: 'linking.html', review: 'review.html', eval: 'eval.html' },
    },
  },
});
