import { defineConfig } from 'vite';

// Three pages: the slice, the candidate-linking experiment, and the review screen.
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', linking: 'linking.html', review: 'review.html' },
    },
  },
});
