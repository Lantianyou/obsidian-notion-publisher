import { defineConfig } from "vite-plus";
export default defineConfig({
  build: {
    lib: { entry: "src/main.ts", formats: ["cjs"], fileName: () => "main.js" },
    outDir: "dist",
    minify: false,
    sourcemap: true,
    rollupOptions: { external: ["obsidian", "electron"], output: { exports: "default" } },
  },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
