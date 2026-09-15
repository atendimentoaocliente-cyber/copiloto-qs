/// <reference types="vite/client" />

/**
 * Sufixo `?script` do @crxjs/vite-plugin: importa um content script como
 * caminho de arquivo já compilado, pronto para chrome.scripting.executeScript.
 */
declare module "*?script" {
  const caminho: string;
  export default caminho;
}
