/**
 * Gera os ícones PNG da extensão sem dependência externa.
 *
 * Desenha um quadrado azul-marinho (#0D1B4B) com um bloco azul (#1A55FF)
 * — a identidade INVT. Substitua por arte oficial quando o time de marca
 * entregar; basta trocar os arquivos em public/icones/.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const pasta = join(raiz, "public", "icones");
mkdirSync(pasta, { recursive: true });

const tabela = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = tabela[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function bloco(tipo, dados) {
  const t = Buffer.from(tipo, "ascii");
  const tam = Buffer.alloc(4);
  tam.writeUInt32BE(dados.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, dados])));
  return Buffer.concat([tam, t, dados, crc]);
}

function png(tamanho) {
  const linhas = [];
  const marinho = [0x0d, 0x1b, 0x4b];
  const azul = [0x1a, 0x55, 0xff];
  const branco = [0xff, 0xff, 0xff];
  const raio = Math.max(2, Math.round(tamanho * 0.18));
  const a = Math.round(tamanho * 0.28), b = Math.round(tamanho * 0.72);
  const c = Math.round(tamanho * 0.42), d = Math.round(tamanho * 0.58);
  for (let y = 0; y < tamanho; y++) {
    const linha = [0];
    for (let x = 0; x < tamanho; x++) {
      // cantos arredondados
      const dx = Math.max(raio - x, x - (tamanho - 1 - raio), 0);
      const dy = Math.max(raio - y, y - (tamanho - 1 - raio), 0);
      const fora = dx * dx + dy * dy > raio * raio;
      let cor = marinho, alfa = fora ? 0 : 255;
      if (!fora && x >= a && x < b && y >= a && y < b) cor = azul;
      if (!fora && x >= c && x < d && y >= c && y < d) cor = branco;
      linha.push(...cor, alfa);
    }
    linhas.push(Buffer.from(linha));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tamanho, 0);
  ihdr.writeUInt32BE(tamanho, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco("IHDR", ihdr),
    bloco("IDAT", deflateSync(Buffer.concat(linhas))),
    bloco("IEND", Buffer.alloc(0)),
  ]);
}

for (const t of [16, 32, 48, 128]) {
  writeFileSync(join(pasta, `icone-${t}.png`), png(t));
}
console.log("ícones gerados em public/icones/");
