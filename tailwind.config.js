/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* The MyStokio palette, so the two apps read as one product. */
        ink: '#192837',
        brand: {
          400: '#8f6bea',
          500: '#7342e2',
          600: '#5f31c9',
        },
      },
    },
  },
  plugins: [],
}
