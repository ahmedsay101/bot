/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Space Grotesk", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"]
      },
      colors: {
        ink: {
          900: "#06070a",
          800: "#0c0f14",
          700: "#141a22"
        }
      }
    },
  },
  plugins: [],
}

