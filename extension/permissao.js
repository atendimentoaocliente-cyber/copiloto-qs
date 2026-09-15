/**
 * Pede acesso ao microfone uma única vez.
 *
 * O Offscreen Document não consegue pedir permissão sozinho (não tem
 * interação do usuário). Uma vez autorizado aqui, o Chrome guarda a
 * permissão para a origem chrome-extension://<id> e o offscreen passa
 * a conseguir capturar o microfone normalmente.
 */

const botao = document.getElementById("pedir");
const resultado = document.getElementById("resultado");

botao.addEventListener("click", async () => {
  resultado.textContent = "";
  resultado.className = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    resultado.textContent = "✅ Microfone liberado. Pode fechar esta aba.";
    resultado.className = "ok";
  } catch (err) {
    resultado.textContent = `❌ Não autorizado (${err.name}). Verifique o cadeado na barra de endereço.`;
    resultado.className = "erro";
  }
});
