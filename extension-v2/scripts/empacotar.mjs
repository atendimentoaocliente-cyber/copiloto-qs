/**
 * Empacota `dist/` num ZIP versionado em `release/`.
 *
 * O .crx assinado é gerado pelo próprio Chrome (ver empacotar.md):
 *   chrome --pack-extension=dist --pack-extension-key=chave.pem
 * Aqui só produzimos o ZIP — é o que o Chrome Browser Cloud Management
 * e o `--pack-extension` consomem.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(raiz, "dist");
if (!existsSync(join(dist, "manifest.json"))) {
  console.error("dist/ não existe. Rode `npm run build` antes.");
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
mkdirSync(join(raiz, "release"), { recursive: true });
const zip = join(raiz, "release", `copiloto-qs-${version}.zip`);
execSync(`cd "${dist}" && rm -f "${zip}" && zip -qr "${zip}" .`, { stdio: "inherit" });
console.log(`\nZIP pronto: release/copiloto-qs-${version}.zip`);
console.log("Próximo passo: ver empacotar.md (CRX assinado + update manifest + política).");
