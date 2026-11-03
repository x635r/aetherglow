import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        abyss: '#04060c',
        ink: '#080b14',
        slate: { 950: '#0b0f1a' },
        glow: {
          gold: '#ffb340',
          amber: '#ff7a18',
          ember: '#ff4d2d',
          rose: '#ff3d6e',
          violet: '#a855f7',
          cyan: '#38e8d0',
          ice: '#7dd3fc',
        },
      },
      fontFamily: {
        display: ['"Chakra Petch"', '"Orbitron"', 'system-ui', 'sans-serif'],
        sans: ['"Inter"', '"Noto Sans SC"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        glass: '0 1px 0 0 rgba(255,255,255,0.06) inset, 0 24px 60px -24px rgba(0,0,0,0.85)',
        ember: '0 0 60px -12px rgba(255,122,24,0.55)',
      },
      backdropBlur: { xs: '2px' },
      animation: {
        'slow-spin': 'spin 26s linear infinite',
        'pulse-soft': 'pulseSoft 3.4s ease-in-out infinite',
        drift: 'drift 22s ease-in-out infinite',
        'fade-up': 'fadeUp .5s cubic-bezier(.22,1,.36,1) both',
        shimmer: 'shimmer 2.6s linear infinite',
      },
      keyframes: {
        pulseSoft: {
          '0%,100%': { opacity: '0.55', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.04)' },
        },
        drift: {
          '0%,100%': { transform: 'translate3d(0,0,0) scale(1)' },
          '33%': { transform: 'translate3d(3%,-2%,0) scale(1.06)' },
          '66%': { transform: 'translate3d(-2%,3%,0) scale(1.03)' },
        },
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: { from: { backgroundPosition: '200% 0' }, to: { backgroundPosition: '-200% 0' } },
      },
    },
  },
  plugins: [],
} satisfies Config;
