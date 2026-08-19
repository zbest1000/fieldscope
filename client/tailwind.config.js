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
        // Layered depth: a soft cast shadow plus a 1px top light-highlight that
        // makes surfaces read as lit panels rather than flat fills.
        card: '0 1px 2px rgba(0,0,0,0.4), 0 2px 10px -2px rgba(0,0,0,0.35), inset 0 1px 0 0 rgba(255,255,255,0.05)',
        elevated: '0 4px 12px -2px rgba(0,0,0,0.5), 0 12px 32px -8px rgba(0,0,0,0.55), inset 0 1px 0 0 rgba(255,255,255,0.06)',
        pop: '0 16px 48px -12px rgba(0,0,0,0.7), inset 0 1px 0 0 rgba(255,255,255,0.06)',
        'glow-accent': '0 0 0 1px rgba(16,185,129,0.35), 0 6px 20px -6px rgba(16,185,129,0.5)',
        'glow-hazard': '0 0 0 1px rgba(245,158,11,0.4), 0 6px 20px -6px rgba(245,158,11,0.5)',
        'inner-hi': 'inset 0 1px 0 0 rgba(255,255,255,0.06)',
      },
      backgroundImage: {
        // Subtle top-lit gradient overlays for surface elevation.
        surface: 'linear-gradient(180deg, rgba(255,255,255,0.028), rgba(255,255,255,0) 42%)',
        'surface-raised': 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0) 55%)',
        'btn-primary': 'linear-gradient(180deg, #10b981, #059669)',
        'btn-hazard': 'linear-gradient(180deg, #fbbf24, #f59e0b)',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0, transform: 'translateY(4px)' }, to: { opacity: 1, transform: 'none' } },
        'scale-in': { from: { opacity: 0, transform: 'translateY(-6px) scale(0.985)' }, to: { opacity: 1, transform: 'none' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'pulse-hazard': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.55 } },
      },
      animation: {
        'fade-in': 'fade-in 0.18s ease-out',
        'scale-in': 'scale-in 0.16s cubic-bezier(0.16,1,0.3,1)',
        'pulse-hazard': 'pulse-hazard 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
