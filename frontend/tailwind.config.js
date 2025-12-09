/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'trading-dark': '#0a0e1a',
        'trading-card': '#1a1f2e',
        'trading-border': '#2d3748',
        'trading-green': '#00d4aa',
        'trading-red': '#ff6b6b',
        'trading-blue': '#4299e1',
        'trading-text': '#e2e8f0',
        'trading-text-muted': '#94a3b8'
      },
      fontFamily: {
        'mono': ['JetBrains Mono', 'Monaco', 'Consolas', 'monospace']
      }
    },
  },
  plugins: [],
}