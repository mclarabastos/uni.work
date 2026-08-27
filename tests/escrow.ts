// Testes do programa de escrow — Trampo
// Rodar sempre contra Devnet ou localnet. Nunca Mainnet.

import * as anchor from "@coral-xyz/anchor";

describe("escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  it("deposita o token de teste na conta de escrow", async () => {
    // TODO: implementar
  });

  it("libera o pagamento após confirmação de conclusão", async () => {
    // TODO: implementar
  });

  it("dispara a emissão do certificado após a liberação", async () => {
    // TODO: implementar (chamada ao backend/Bubblegum, fora do programa em si)
  });
});
