import {createHash} from "node:crypto";

const falha = () => {throw new Error("Legado inconsistente, pendente ou sem identidade conferida; exportação recusada");};
const inteiro = v => Number.isSafeInteger(v) && v >= 0;
const unidades = (v, fator) => {
  const n=Number(v)*fator, i=Math.round(n);
  if (!Number.isFinite(n) || i<0 || Math.abs(n-i)>1e-7) falha();
  return i;
};
const ordenar = (a,chave) => a.sort((x,y)=>chave(x)<chave(y)?-1:chave(x)>chave(y)?1:0);
export const digestLegado = m => createHash("sha256").update(JSON.stringify(m)).digest("hex");

// SQLite de backup/restauro, nunca binding de produção. Não lê sessões/perfis.
export function exportarLegado(db, anterior=null) {
  if (anterior!==null && !/^[a-f0-9]{64}$/.test(anterior)) falha();
  const contas=db.prepare("select id, atos_sub, email from contas order by atos_sub").all();
  const compras=db.prepare("select id, conta_id, email, status, area_hash, cupom from compras order by id").all();
  const campanhas=db.prepare("select * from cupons order by codigo").all();
  const usos=db.prepare("select * from cupom_usos order by cupom, compra_id").all();
  const porConta=new Map(), emails=new Set();
  for (const c of contas) {
    const email=String(c.email).trim().toLowerCase();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(c.atos_sub) || emails.has(email) || porConta.has(c.id)) falha();
    emails.add(email); porConta.set(c.id,{sub:c.atos_sub,compras_pagas:[]});
  }
  if (new Set(contas.map(c=>c.atos_sub)).size!==contas.length) falha();
  const pagas=new Map();
  for (const c of compras) {
    if (!["pago","pendente","cancelado","expirado"].includes(c.status) || c.status==="pendente") falha();
    if (c.status!=="pago") continue;
    const dono=porConta.get(c.conta_id);
    // Não vincular visitante por e-mail. Exige conciliação explícita prévia.
    if (!dono || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(c.id)) falha();
    const conta=contas.find(x=>x.id===c.conta_id);
    // Evita perder a restrição histórica de primeira compra baseada em e-mail.
    if (String(c.email).trim().toLowerCase()!==String(conta.email).trim().toLowerCase()) falha();
    dono.compras_pagas.push(c.id); pagas.set(c.id,{...c,sub:dono.sub});
  }
  const codigos=new Set(campanhas.map(c=>c.codigo));
  if (usos.some(u=>!codigos.has(u.cupom))) falha();
  const resultado=campanhas.map(c=>{
    if (!/^[A-Z0-9_-]{3,32}$/.test(c.codigo) || [c.gratis,c.ilimitado,c.so_primeira,c.ativo].some(v=>![0,1].includes(v))) falha();
    if ([c.desconto!=null,c.fixo!=null,c.gratis===1].filter(Boolean).length!==1) falha();
    const tipo=c.gratis?"cortesia":c.fixo!=null?"fixo":"percentual";
    const config={versao:"legado-v1",tipo,ativo:!!c.ativo,
      ...(tipo==="percentual"?{desconto_bps:unidades(c.desconto,10000)}:{}),
      ...(tipo==="fixo"?{centavos:unidades(c.fixo,100)}:{}),
      valido_ate:c.validade || null,area_min_cent_ha:unidades(c.area_min ?? 0,100),
      usos_max:c.usos_max,so_primeira:!!c.so_primeira,ilimitado:!!c.ilimitado};
    if ((tipo==="percentual" && (config.desconto_bps<1 || config.desconto_bps>9000)) ||
        (tipo==="fixo" && (config.centavos<1 || config.centavos>50000000)) ||
        config.area_min_cent_ha>5000000 || c.usos_max!=null && (!inteiro(c.usos_max)||c.usos_max<1||c.usos_max>10000) ||
        c.validade && (!/^\d{4}-\d\d-\d\dT.*Z$/.test(c.validade)||!Number.isFinite(Date.parse(c.validade)))) falha();
    const consumos=usos.filter(u=>u.cupom===c.codigo).map(u=>{
      const p=pagas.get(u.compra_id);
      if (u.pago!==1 || !p || p.conta_id!==u.conta_id || p.cupom!==c.codigo || !/^[a-f0-9]{64}$/.test(p.area_hash)) falha();
      return {compra_id:p.id,sub:p.sub,area_hash:p.area_hash};
    });
    if (new Set(consumos.map(u=>u.compra_id)).size!==consumos.length || c.ilimitado && consumos.length ||
      !c.ilimitado && c.usos_max!=null && consumos.length>c.usos_max) falha();
    // Cupom limitado pago sem registro de consumo não pode ser tratado como livre.
    if (!c.ilimitado && [...pagas.values()].some(p=>p.cupom===c.codigo&&!consumos.some(u=>u.compra_id===p.id))) falha();
    return {codigo:c.codigo,config,usos:ordenar(consumos,u=>u.compra_id)};
  });
  const m={schema:"plantare-legado/v1",anterior,contas:[...porConta.values()],campanhas:resultado};
  // O manifesto é salvo como um valor transacional no DO: limitar antes da escrita.
  if (Buffer.byteLength(JSON.stringify(m))>100000 || m.contas.length>10000 || m.campanhas.length>10000) falha();
  return m;
}
