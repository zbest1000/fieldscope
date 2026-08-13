/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Fieldscope chrome. The whole shell re-colors when ARMED (§4.1).
        ink: '#0b0f14',
        panel: '#111821',
        panel2: '#0e141b',
        edge: '#1e2a37',
        hazard: '#f59e0b',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
