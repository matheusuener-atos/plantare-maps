import assert from "node:assert/strict";
import {test} from "node:test";
import ensaio from "../../homologacao/worker.js";
import "../../homologacao/validar-config.mjs";
test("entry point de ensaio não aceita produção, navegador ou token incorreto",async()=>{
  const token="token-de-controle-sintetico-longo-123456789";
  const req=(h={})=>new Request("https://plantare-atos-teste.exemplo.workers.dev/__homologacao",{method:"POST",
    headers:{authorization:"Bearer "+token,...h},body:JSON.stringify({run:crypto.randomUUID(),op:"preparar"})});
  assert.equal((await ensaio.fetch(req(),{AMBIENTE:"producao",PLANTARE_HOMOLOG_ATIVO:"1"})).status,404);
  assert.equal((await ensaio.fetch(req(),{AMBIENTE:"teste"})).status,404);
  const env={AMBIENTE:"teste",PLANTARE_HOMOLOG_ATIVO:"1",PLANTARE_HOMOLOG_TOKEN:token};
  assert.equal((await ensaio.fetch(req({authorization:"errado"}),env)).status,401);
  assert.equal((await ensaio.fetch(req({origin:"https://qualquer.test"}),env)).status,403);
});
