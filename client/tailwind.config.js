/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Fieldscope chrome — a layered dark instrument palette. The whole shell
        // re-colors when ARMED (§4.1).
        ink: '#090d12', // app background (deepest)
        panel: '#121a24', // primary surface
        panel2: '#0d141c', // recessed surface (rails, bars)
        raised: '#18232f', // hover / raised surface
        edge: '#1f2b38', // hairline border
        edge2: '#2b3a4b', // stronger border / focus
        hazard: '#f59e0b',
        accent: '#10b981', // emerald — primary action
        // Domain accents (left rail dots, Home tier headers).
        'd-it': '#38bdf8',
        'd-industrial': '#34d399',
        'd-utility': '#a78bfa',
        'd-iiot': '#22d3ee',
        'd-rf': '#f472b6',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.4), 0 1px 8px rgba(0,0,0,0.25)',
        pop: '0 10px 30px rgba(0,0,0,0.5)',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0, transform: 'translateY(4px)' }, to: { opacity: 1, transform: 'none' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'pulse-hazard': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.55 } },
      },
      animation: {
        'fade-in': 'fade-in 0.18s ease-out',
        'pulse-hazard': 'pulse-hazard 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
