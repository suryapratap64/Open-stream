/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#667eea",
        secondary: "#764ba2",
        danger: "#ff6b6b",
      },
      backgroundImage: {
        "gradient-main": "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
      },
    },
  },
  plugins: [],
};
