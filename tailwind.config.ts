import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        nbBg: "var(--nb-bg)",
        nbInk: "var(--nb-ink)",
        nbAccent: "var(--nb-accent)",
        nbCaution: "var(--nb-caution)",
        nbDanger: "var(--nb-danger)",
      },
      fontFamily: {
        display: ["var(--font-archivo-black)", "Helvetica Neue", "Arial", "sans-serif"],
        body: ["var(--font-space-grotesk)", "system-ui", "sans-serif"],
      },
      borderRadius: {
        DEFAULT: "0px",
        none: "0px",
        sm: "0px",
        md: "0px",
        lg: "0px",
        xl: "0px",
        "2xl": "0px",
        full: "9999px",
      },
    },
  },
  plugins: [],
};
export default config;
