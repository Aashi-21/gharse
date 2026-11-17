/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        cream: { 50: '#fdfbf8', 100: '#faf6f1', 200: '#f2eadf', 300: '#e6d9c6' },
        ink: { DEFAULT: '#2b211c', soft: '#5c4f47', faint: '#8c7e74' },
        clay: { DEFAULT: '#b5543a', dark: '#9a4430', light: '#f6e4dc' },
        sage: { DEFAULT: '#6b7f5e', light: '#e6ece0' },
      },
      fontFamily: {
        display: ['"Fraunces Variable"', 'Georgia', 'serif'],
        sans: ['"Inter Variable"', 'system-ui', 'sans-serif'],
      },
      boxShadow: { card: '0 1px 2px rgba(43,33,28,.04), 0 8px 24px -12px rgba(43,33,28,.12)' },
    },
  },
  plugins: [],
};
