/** Tailwind 只用来写布局与间距；preflight 关掉，避免它的全局重置
 *  （border-style、heading 归零等）干扰 CodeMirror 自绘的编辑器 DOM。 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        fm: {
          bg: "var(--bg)",
          surface: "var(--surface)",
          fg: "var(--fg)",
          secondary: "var(--secondary)",
          muted: "var(--muted)",
          faint: "var(--faint)",
          border: "var(--border)",
          "border-strong": "var(--border-strong)",
          accent: "var(--accent)",
          danger: "var(--danger)",
        },
      },
      fontFamily: {
        mono: "var(--mono)",
      },
    },
  },
  plugins: [],
};
