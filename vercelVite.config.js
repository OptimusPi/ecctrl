import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteWebMcpPlugin } from "./viteWebMcpPlugin.js";

const isCodeSandbox =
  "SANDBOX_URL" in process.env || "CODESANDBOX_HOST" in process.env;

export default defineConfig({
  plugins: [react(), viteWebMcpPlugin()],
  root: "example/",
  publicDir: "../public/",
  base: "./",
  server: {
    host: true,
    open: !isCodeSandbox, // Open if it's not a CodeSandbox
  },
  build: {
    outDir: "./exampleDist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
