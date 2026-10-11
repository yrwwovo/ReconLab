/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 主色：磷光绿（地下终端辉光）
        primary: {
          deep: '#03150c',
          dark: '#0a4d2c',
          main: '#00ff88',
          light: '#6bffb8',
          mist: '#b6ffd9',
          glow: 'rgba(0, 255, 136, 0.34)',
        },
        // 告警：血红（只给 critical / 驳回 / 越权）
        blood: {
          deep: '#2b0308',
          dark: '#7a0d1a',
          main: '#ff2b3d',
          light: '#ff7a86',
          mist: '#ffc2c8',
          glow: 'rgba(255, 43, 61, 0.34)',
        },
        // 次级告警：琥珀
        amber: {
          deep: '#2a1c02',
          dark: '#7a5303',
          main: '#ffb000',
          light: '#ffd06b',
          mist: '#ffeab8',
          glow: 'rgba(255, 176, 0, 0.3)',
        },
        // 表面：沥青黑（带绿调的灰）
        surface: {
          void: '#030605',
          deep: '#050b08',
          panel: '#071009',
          elev: '#0b1710',
          edge: '#14291d',
          light: '#1b3524',
        },
        // 文字
        text: {
          dim: '#4e6b5c',
          dark: '#7d9b8a',
          main: '#b8d6c4',
          light: '#e8fff3',
          white: '#ffffff',
        },
        // 严重度色阶
        sev: {
          critical: '#ff2b3d',
          high: '#ff6b3d',
          medium: '#ffb000',
          low: '#38d9ff',
          info: '#6b8b7c',
        },
      },
      fontFamily: {
        ui: ['"Share Tech Mono"', '"IBM Plex Mono"', 'ui-monospace', 'monospace'],
        mono: ['"IBM Plex Mono"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
        title: ['"Share Tech Mono"', '"IBM Plex Mono"', 'ui-monospace', 'monospace'],
        body: ['"IBM Plex Mono"', '"Noto Sans SC"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        hud: '2px',
      },
      animation: {
        'blink': 'blink 1.05s step-end infinite',
        'scan': 'scan 6s linear infinite',
        'flicker': 'flicker 4.5s steps(1, end) infinite',
        'glitch-x': 'glitch-x 3.4s steps(1, end) infinite',
        'ticker': 'ticker 42s linear infinite',
        'radar': 'radar 3.6s linear infinite',
        'ring': 'ring 2.6s ease-out infinite',
        'drift': 'drift 14s linear infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        scan: {
          '0%': { transform: 'translateY(-120%)' },
          '100%': { transform: 'translateY(2400%)' },
        },
        flicker: {
          '0%, 96%, 100%': { opacity: '1' },
          '97%': { opacity: '0.82' },
          '98%': { opacity: '0.96' },
          '99%': { opacity: '0.74' },
        },
        'glitch-x': {
          '0%, 92%, 100%': { transform: 'translate(0, 0)', opacity: '1' },
          '93%': { transform: 'translate(-2px, 1px)', opacity: '0.86' },
          '94%': { transform: 'translate(2px, -1px)', opacity: '0.94' },
          '95%': { transform: 'translate(-1px, 0)', opacity: '0.8' },
          '96%': { transform: 'translate(1px, 1px)', opacity: '1' },
        },
        ticker: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        radar: {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        ring: {
          '0%': { transform: 'scale(0.35)', opacity: '0.7' },
          '100%': { transform: 'scale(1.6)', opacity: '0' },
        },
        drift: {
          '0%': { transform: 'translateY(0)' },
          '100%': { transform: 'translateY(-50%)' },
        },
      },
      backgroundImage: {
        'grid-tactical':
          'linear-gradient(rgba(0,255,136,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,136,0.05) 1px, transparent 1px)',
      },
      backgroundSize: {
        'grid-32': '32px 32px',
      },
    },
  },
  plugins: [],
}
