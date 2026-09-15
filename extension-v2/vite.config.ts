import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import { fileURLToPath, URL } from "node:url";
import manifest from "./manifest.json";

/**
 * Build da extensão com @crxjs/vite-plugin.
 *
 * O plugin lê o manifest.json apontando para os arquivos .ts de origem e
 * gera o pacote final em `dist/` com os caminhos reescritos. Um único
 * `vite build` produz service worker, offscreen, content scripts e a
 * página de opções.
 */
export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        // O offscreen não aparece no manifest (é aberto por chrome.offscreen),
        // então precisa ser declarado aqui para entrar no build.
        offscreen: fileURLToPath(new URL("./src/offscreen/offscreen.html", import.meta.url)),
      },
    },
    // Sem minificação: o service worker injeta o vigia de tela via
    // `func.toString()` no world MAIN — legível é mais seguro que pequeno.
    minify: false,
    sourcemap: false,
    target: "chrome116",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
