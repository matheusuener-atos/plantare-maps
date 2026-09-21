/* Plantare · gerador dos arquivos pagos (KML, KMZ, AB, rota, Shapefile, GeoJSON, CSV).
   Roda SÓ no Worker: o navegador não tem mais este código. O relatório PDF, a imagem e o
   projeto continuam no app (são grátis).
   Origem: módulo "exportacao" do plantare.html v29 (mesmas funções, sem DOM). */

/* ---------- zip (sem compressão) ---------- */
const CRC_T=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(u8){ let c=0xFFFFFFFF; for(let i=0;i<u8.length;i++) c=CRC_T[(c^u8[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
function zipStore(files){ // files: [{name, data:Uint8Array}]
  const enc=new TextEncoder(); const parts=[]; const central=[]; let offset=0;
  for(const f of files){
    const nm=enc.encode(f.name), crc=crc32(f.data), sz=f.data.length;
    const lh=new Uint8Array(30+nm.length); const dv=new DataView(lh.buffer);
    dv.setUint32(0,0x04034b50,true); dv.setUint16(4,20,true); dv.setUint16(6,0x0800,true);
    dv.setUint16(8,0,true); dv.setUint16(10,0,true); dv.setUint16(12,0,true);
    dv.setUint32(14,crc,true); dv.setUint32(18,sz,true); dv.setUint32(22,sz,true);
    dv.setUint16(26,nm.length,true); dv.setUint16(28,0,true); lh.set(nm,30);
    parts.push(lh, f.data);
    const cd=new Uint8Array(46+nm.length); const cv=new DataView(cd.buffer);
    cv.setUint32(0,0x02014b50,true); cv.setUint16(4,20,true); cv.setUint16(6,20,true); cv.setUint16(8,0x0800,true);
    cv.setUint16(10,0,true); cv.setUint16(12,0,true); cv.setUint16(14,0,true);
    cv.setUint32(16,crc,true); cv.setUint32(20,sz,true); cv.setUint32(24,sz,true);
    cv.setUint16(28,nm.length,true); cv.setUint32(42,offset,true); cd.set(nm,46);
    central.push(cd); offset += lh.length + sz;
  }
  let csize=0; for(const c of central) csize+=c.length;
  const eo=new Uint8Array(22); const ev=new DataView(eo.buffer);
  ev.setUint32(0,0x06054b50,true); ev.setUint16(8,files.length,true); ev.setUint16(10,files.length,true);
  ev.setUint32(12,csize,true); ev.setUint32(16,offset,true);
  const pedacos=[...parts,...central,eo];
  let tam=0; for(const b of pedacos) tam+=b.length;
  const bytes=new Uint8Array(tam); let o=0; for(const b of pedacos){ bytes.set(b,o); o+=b.length; }
  return bytes;
}
const zipBytes = files => zipStore(files);

/* ---------- UTM (mesma do app) ---------- */
const A=6378137.0, F=1/298.257223563, E2=F*(2-F), K0=0.9996;
function utmZone(lon){ return Math.floor((lon+180)/6)+1; }
function makeUTM(lon0deg, south){
  const lon0=lon0deg*Math.PI/180, ep2=E2/(1-E2);
  const e1=(1-Math.sqrt(1-E2))/(1+Math.sqrt(1-E2));
  const FN=south?10000000:0;
  function fwd(lon,lat){
    const p=lat*Math.PI/180, l=lon*Math.PI/180;
    const N=A/Math.sqrt(1-E2*Math.sin(p)**2), T=Math.tan(p)**2, C=ep2*Math.cos(p)**2, Aa=Math.cos(p)*(l-lon0);
    const M=A*((1-E2/4-3*E2*E2/64-5*E2**3/256)*p-(3*E2/8+3*E2*E2/32+45*E2**3/1024)*Math.sin(2*p)
      +(15*E2*E2/256+45*E2**3/1024)*Math.sin(4*p)-(35*E2**3/3072)*Math.sin(6*p));
    const x=K0*N*(Aa+(1-T+C)*Aa**3/6+(5-18*T+T*T+72*C-58*ep2)*Aa**5/120)+500000;
    const y=K0*(M+N*Math.tan(p)*(Aa*Aa/2+(5-T+9*C+4*C*C)*Aa**4/24+(61-58*T+T*T+600*C-330*ep2)*Aa**6/720))+FN;
    return [x,y];
  }
  function inv(x,y){
    const xx=x-500000, yy=y-FN;
    const M=yy/K0, mu=M/(A*(1-E2/4-3*E2*E2/64-5*E2**3/256));
    const p1=mu+(3*e1/2-27*e1**3/32)*Math.sin(2*mu)+(21*e1*e1/16-55*e1**4/32)*Math.sin(4*mu)
      +(151*e1**3/96)*Math.sin(6*mu)+(1097*e1**4/512)*Math.sin(8*mu);
    const C1=ep2*Math.cos(p1)**2, T1=Math.tan(p1)**2;
    const N1=A/Math.sqrt(1-E2*Math.sin(p1)**2), R1=A*(1-E2)/Math.pow(1-E2*Math.sin(p1)**2,1.5);
    const D=xx/(N1*K0);
    const lat=p1-(N1*Math.tan(p1)/R1)*(D*D/2-(5+3*T1+10*C1-4*C1*C1-9*ep2)*D**4/24
      +(61+90*T1+298*C1+45*T1*T1-252*ep2-3*C1*C1)*D**6/720);
    const lon=lon0+(D-(1+2*T1+C1)*D**3/6+(5-2*C1+28*T1-3*C1*C1+8*ep2+24*T1*T1)*D**5/120)/Math.cos(p1);
    return [lon*180/Math.PI, lat*180/Math.PI];
  }
  return {fwd,inv};
}

/* ============================ grade / raster ============================ */

/* ---------- geometria ---------- */
const dist = (a,b) => Math.hypot(a[0]-b[0], a[1]-b[1]);
function plen(p){ let L=0; for(let i=1;i<p.length;i++) L+=dist(p[i],p[i-1]); return L; }
function unit(v){ const m=Math.hypot(v[0],v[1])||1; return [v[0]/m, v[1]/m]; }
const cross = (a,b) => a[0]*b[1]-a[1]*b[0];
const dot = (a,b) => a[0]*b[0]+a[1]*b[1];
/** rumo em graus (0 = norte, 90 = leste) de um vetor */
const rumoDe = v => (Math.atan2(v[0], v[1])*180/Math.PI + 360) % 360;

function simplify(pts,tol){
  if(pts.length<3) return pts.slice();
  const keep=new Uint8Array(pts.length); keep[0]=1; keep[pts.length-1]=1;
  const st=[[0,pts.length-1]];
  while(st.length){
    const [a,z]=st.pop();
    let dmax=0,idx=-1;
    const x1=pts[a][0],y1=pts[a][1],x2=pts[z][0],y2=pts[z][1];
    const dx=x2-x1, dy=y2-y1, L2=dx*dx+dy*dy;
    for(let i=a+1;i<z;i++){
      let t=L2>0?((pts[i][0]-x1)*dx+(pts[i][1]-y1)*dy)/L2:0; t=Math.max(0,Math.min(1,t));
      const d=Math.hypot(pts[i][0]-(x1+t*dx), pts[i][1]-(y1+t*dy));
      if(d>dmax){dmax=d;idx=i;}
    }
    if(dmax>tol && idx>0){ keep[idx]=1; st.push([a,idx],[idx,z]); }
  }
  const out=[]; for(let i=0;i<pts.length;i++) if(keep[i]) out.push(pts[i]);
  return out;
}
function acumulado(pts){ const c=[0]; for(let i=1;i<pts.length;i++) c.push(c[i-1]+dist(pts[i],pts[i-1])); return c; }
/** ponto a uma distância s ao longo da polilinha (s já dentro de [0,L]) */
function pontoEm(pts, cum, s){
  if(s<=0) return pts[0].slice();
  const L=cum[cum.length-1]; if(s>=L) return pts[pts.length-1].slice();
  let lo=0, hi=cum.length-1;
  while(hi-lo>1){ const m=(lo+hi)>>1; if(cum[m]<=s) lo=m; else hi=m; }
  const f=(s-cum[lo])/Math.max(1e-9,cum[hi]-cum[lo]);
  return [pts[lo][0]+(pts[hi][0]-pts[lo][0])*f, pts[lo][1]+(pts[hi][1]-pts[lo][1])*f];
}
function trechoAberto(pts, cum, s0, s1){
  const out=[pontoEm(pts,cum,s0)];
  for(let i=0;i<pts.length;i++) if(cum[i]>s0+1e-6 && cum[i]<s1-1e-6) out.push(pts[i].slice());
  out.push(pontoEm(pts,cum,s1));
  return out;
}
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

/* ---------- escritores ---------- */
function prjText(kind, zone, south){
  if(kind==='wgs84geo')
    return 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],'
         + 'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  const gcs = kind==='sirgas'
    ? 'GEOGCS["GCS_SIRGAS_2000",DATUM["D_SIRGAS_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
    : 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  const nm = (kind==='sirgas'?'SIRGAS_2000':'WGS_1984')+'_UTM_Zone_'+zone+(south?'S':'N');
  return 'PROJCS["'+nm+'",'+gcs+',PROJECTION["Transverse_Mercator"],'
       + 'PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",'+(south?10000000:0)+'.0],'
       + 'PARAMETER["Central_Meridian",'+(zone*6-183)+'.0],PARAMETER["Scale_Factor",0.9996],'
       + 'PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
}
function kmlText(nome, fieldRings, passes, proj, cor, extra){
  const P=[];
  const ll=pts=>pts.map(p=>{const q=proj.inv(p[0],p[1]); return q[0].toFixed(8)+','+q[1].toFixed(8)+',0';}).join(' ');
  P.push('<?xml version="1.0" encoding="UTF-8"?>');
  P.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>'+esc(nome)+'</name>');
  P.push('<Style id="l"><LineStyle><color>'+cor+'</color><width>2.2</width></LineStyle></Style>');
  P.push('<Style id="bd"><LineStyle><color>ff37d67a</color><width>3</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>');
  P.push('<Folder><name>Cerca</name>');
  fieldRings.forEach((r,i)=>P.push('<Placemark><name>Divisa '+(i+1)+'</name><styleUrl>#bd</styleUrl>'
    +'<LineString><tessellate>1</tessellate><coordinates>'+ll(r)+'</coordinates></LineString></Placemark>'));
  P.push('</Folder><Folder><name>Passes</name>');
  passes.forEach((p,i)=>{
    const d='Passe '+(p.ordem!=null?p.ordem:i+1)+(p.num?' · linha '+p.num:'')
      +' ('+p.tipo+')<br/>Comprimento: '+p.L.toFixed(1)+' m<br/>Rumo: '+p.rumo.toFixed(1)+'&#176;'
      ;
    P.push('<Placemark><name>'+String(p.ordem!=null?p.ordem:i+1).padStart(3,'0')+'</name><description><![CDATA['+d+']]></description>'
      +'<styleUrl>#l</styleUrl><LineString><tessellate>1</tessellate><coordinates>'+ll(p.pts)+'</coordinates></LineString></Placemark>');
  });
  P.push('</Folder>');
  // as manobras saem em camada separada: o monitor mostra por onde a maquina anda sem aplicar
  const manobras=(extra&&extra.manobras)||[];
  if(manobras.length){
    P.push('<Style id="mn"><LineStyle><color>ff1f6fa8</color><width>1.8</width></LineStyle></Style>');
    P.push('<Folder><name>Manobras</name>');
    manobras.forEach((m,i)=>P.push('<Placemark><name>M'+(i+1)+' ('+esc(m.tipo||'manobra')+')</name>'
      +'<styleUrl>#mn</styleUrl><LineString><tessellate>1</tessellate><coordinates>'
      +ll(m.pts)+'</coordinates></LineString></Placemark>'));
    P.push('</Folder>');
  }
  const evitar=(extra&&extra.obstaculos)||[];
  if(evitar&&evitar.length){
    P.push('<Style id="ev"><LineStyle><color>ff552dff</color><width>2.4</width></LineStyle>'
      +'<PolyStyle><color>55552dff</color></PolyStyle></Style>');
    P.push('<Folder><name>Obstaculos</name>');
    evitar.forEach((a,i)=>{
      const r=a.pts.concat([a.pts[0]]);
      P.push('<Placemark><name>Obstaculo '+(i+1)+'</name><styleUrl>#ev</styleUrl>'
        +'<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>'
        +ll(r)+'</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>');
    });
    P.push('</Folder>');
  }
  P.push('</Document></kml>');
  return P.join('\n');
}
function shpPolyline(passes, toXY){
  const recs=passes.map(p=>p.pts.map(toXY));
  let bx=[Infinity,Infinity,-Infinity,-Infinity];
  for(const r of recs) for(const p of r){
    bx[0]=Math.min(bx[0],p[0]); bx[1]=Math.min(bx[1],p[1]);
    bx[2]=Math.max(bx[2],p[0]); bx[3]=Math.max(bx[3],p[1]);
  }
  let total=50; const sizes=recs.map(r=>24+r.length*8);  // palavras de 16 bits: 4+16+2+2+2 + n*8
  for(const s of sizes) total+=4+s;
  const shp=new DataView(new ArrayBuffer(total*2));
  const shx=new DataView(new ArrayBuffer((50+recs.length*4)*2));
  function hdr(dv,len){
    dv.setInt32(0,9994); dv.setInt32(24,len); dv.setInt32(28,1000,true); dv.setInt32(32,3,true);
    dv.setFloat64(36,bx[0],true); dv.setFloat64(44,bx[1],true);
    dv.setFloat64(52,bx[2],true); dv.setFloat64(60,bx[3],true);
  }
  hdr(shp,total); hdr(shx,50+recs.length*4);
  let off=50;
  recs.forEach((r,i)=>{
    const len=sizes[i];
    shp.setInt32(off*2,i+1); shp.setInt32(off*2+4,len);
    let o=off*2+8;
    shp.setInt32(o,3,true); o+=4;
    let mx=[Infinity,Infinity,-Infinity,-Infinity];
    for(const p of r){ mx[0]=Math.min(mx[0],p[0]); mx[1]=Math.min(mx[1],p[1]); mx[2]=Math.max(mx[2],p[0]); mx[3]=Math.max(mx[3],p[1]); }
    shp.setFloat64(o,mx[0],true); shp.setFloat64(o+8,mx[1],true);
    shp.setFloat64(o+16,mx[2],true); shp.setFloat64(o+24,mx[3],true); o+=32;
    shp.setInt32(o,1,true); o+=4; shp.setInt32(o,r.length,true); o+=4;
    shp.setInt32(o,0,true); o+=4;
    for(const p of r){ shp.setFloat64(o,p[0],true); shp.setFloat64(o+8,p[1],true); o+=16; }
    shx.setInt32(100+i*8,off); shx.setInt32(104+i*8,len);
    off+=4+len;
  });
  return {shp:new Uint8Array(shp.buffer), shx:new Uint8Array(shx.buffer)};
}
/* dbf com campos escolhidos: [nome, tipo, tamanho, decimais] e uma função por registro */
function dbfCampos(regs, fields, valores){
  const recLen=1+fields.reduce((s,f)=>s+f[2],0);
  const hdrLen=32+32*fields.length+1;
  const buf=new Uint8Array(hdrLen+recLen*regs.length+1);
  const dv=new DataView(buf.buffer), now=new Date();
  buf[0]=3; buf[1]=now.getFullYear()-1900; buf[2]=now.getMonth()+1; buf[3]=now.getDate();
  dv.setUint32(4,regs.length,true); dv.setUint16(8,hdrLen,true); dv.setUint16(10,recLen,true);
  fields.forEach((f,i)=>{ const o=32+i*32;
    for(let k=0;k<f[0].length&&k<10;k++) buf[o+k]=f[0].charCodeAt(k);
    buf[o+11]=f[1].charCodeAt(0); buf[o+16]=f[2]; buf[o+17]=f[3]; });
  buf[32+32*fields.length]=0x0D;
  let o=hdrLen;
  regs.forEach((r,i)=>{
    buf[o++]=0x20;
    const vals=valores(r,i);
    fields.forEach((f,k)=>{
      let t=vals[k];
      if(f[1]==='N'){ t=Number(t||0).toFixed(f[3]); t=t.length>f[2]?t.slice(0,f[2]):t.padStart(f[2],' '); }
      else { t=String(t==null?'':t); t=t.length>f[2]?t.slice(0,f[2]):t.padEnd(f[2],' '); }
      for(let q=0;q<f[2];q++) buf[o+q]=t.charCodeAt(q)&0xFF;
      o+=f[2];
    });
  });
  buf[o]=0x1A;
  return buf;
}
function dbf(passes){
  const fields=[['PASSE','N',6,0],['LINHA','N',6,0],['TIPO','C',12,0],['COMP_M','N',12,1],['RUMO','N',7,1]];
  const recLen=1+fields.reduce((s,f)=>s+f[2],0);
  const hdrLen=32+32*fields.length+1;
  const buf=new Uint8Array(hdrLen+recLen*passes.length+1);
  const dv=new DataView(buf.buffer);
  const now=new Date();
  buf[0]=3; buf[1]=now.getFullYear()-1900; buf[2]=now.getMonth()+1; buf[3]=now.getDate();
  dv.setUint32(4,passes.length,true); dv.setUint16(8,hdrLen,true); dv.setUint16(10,recLen,true);
  fields.forEach((f,i)=>{
    const o=32+i*32;
    for(let k=0;k<f[0].length&&k<10;k++) buf[o+k]=f[0].charCodeAt(k);
    buf[o+11]=f[1].charCodeAt(0); buf[o+16]=f[2]; buf[o+17]=f[3];
  });
  buf[32+32*fields.length]=0x0D;
  let o=hdrLen;
  passes.forEach((p,i)=>{
    buf[o++]=0x20;
    const vals=[p.ordem!=null?p.ordem:i+1,p.num||0,p.tipo,p.L,p.rumo];
    fields.forEach((f,k)=>{
      let s;
      if(f[1]==='N'){ s=Number(vals[k]).toFixed(f[3]); s=s.length>f[2]?s.slice(0,f[2]):s.padStart(f[2],' '); }
      else { s=String(vals[k]); s=s.length>f[2]?s.slice(0,f[2]):s.padEnd(f[2],' '); }
      for(let t=0;t<f[2];t++) buf[o+t]=s.charCodeAt(t)&0xFF;
      o+=f[2];
    });
  });
  buf[o]=0x1A;
  return buf;
}
function passAttrs(passes){
  return passes.map((p,i)=>{
    const a=p.pts[0], b=p.pts[p.pts.length-1];
    const rumo=(Math.atan2(b[0]-a[0],b[1]-a[1])*180/Math.PI+360)%360;
    const o={pts:p.pts, tipo:p.tipo, L:plen(p.pts), rumo,
             ordem:p.ordem!=null?p.ordem:i+1, num:p.num||0, };
    return o;
  });
}
/* ===================== percurso costurado (autorama) =====================
   As pernas têm de se emendar ponto a ponto: sem vão, sem pedaço repetido.
   Isso é o que o piloto automático segue; qualquer fresta vira dúvida na máquina. */
function costurarLegs(legs, tol){
  tol=tol||0.5;
  const out=legs.map(l=>Object.assign({}, l, {p:l.p.map(q=>q.slice())}));
  let costuras=0, vaos=[];
  for(let i=1;i<out.length;i++){
    const a=out[i-1].p, b=out[i].p;
    if(!a.length || !b.length) continue;
    const fim=a[a.length-1];
    // tira pontos do começo que só repetem o fim da perna anterior (sobreposição)
    while(b.length>2 && dist(b[0],fim)<0.02 && dist(b[1],fim)<0.25) b.shift();
    const d=dist(fim,b[0]);
    if(d<1e-9) continue;
    if(d<=tol){ b[0]=fim.slice(); costuras++; }
    else vaos.push({i, d, p:fim.slice()});
  }
  // tira pontos repetidos dentro de cada perna
  for(const l of out){
    const q=[l.p[0]];
    for(let k=1;k<l.p.length;k++) if(dist(l.p[k],q[q.length-1])>1e-6) q.push(l.p[k]);
    if(q.length>1) l.p=q;
  }
  return {legs:out, costuras, vaos};
}
/* percurso inteiro como uma linha só, na ordem do trabalho */
/* linhas e manobras emendadas em trechos contínuos; a bordadura entra só se a pessoa pediu
   (a maioria dos monitores lê a bordadura num arquivo e o percurso em outro) */
function trechosDeTrabalho(legs, comBord){
  const out=[]; let atual=null;
  for(const l of legs){
    if(l.t==='x' || (!comBord && l.tipo==='bordadura')){ atual=null; continue; }
    if(!atual){ atual=[]; out.push(atual); }
    for(const q of l.p) if(!atual.length || dist(q,atual[atual.length-1])>1e-6) atual.push(q);
  }
  return out.filter(t=>t.length>1);
}
/* ===================== como o percurso é entregue =====================
   Quatro jeitos, escolhidos pela pessoa na etapa 03. O gêmeo desta função mora no app
   (percursoSegmentos), para a tela mostrar a mesma divisão antes de comprar.
     unico   → o percurso inteiro numa linha
     passos  → cada pedaço contínuo vira "Passo 01", "Passo 02"… no mesmo arquivo
     trechos → o mesmo, porém um arquivo por pedaço
     blocos  → cortes por tanque, área, passadas ou tempo, sempre no fim de uma passada
   Regras que valem para todos: o corte nunca cai no meio de uma linha de trabalho, e nenhum
   bloco sai vazio. É a diferença entre dividir o serviço e induzir a máquina ao erro. */
function medirLeg(l, o){
  let comp=0; for(let i=1;i<l.p.length;i++) comp+=dist(l.p[i-1], l.p[i]);
  const trab=l.t==='w';
  return {comp, trab, ha:trab?comp*o.faixa/1e4:0, horas:comp/1000/Math.max(1,(trab?o.vTrab:o.vMan))};
}
function segmentarPercurso(legs, o){
  o=Object.assign({modo:'unico', criterio:'area', valor:0, faixa:30, vazao:0, vTrab:18, vMan:8, comBord:false}, o||{});
  const uteis=legs.filter(l=>l.t!=='x' && l.p && l.p.length>1 && (o.comBord || l.tipo!=='bordadura'));
  if(!uteis.length) return [];
  const juntar=ls=>{ const pts=[]; for(const l of ls) for(const q of l.p) if(!pts.length || dist(q,pts[pts.length-1])>1e-6) pts.push(q); return pts; };
  const medir=ls=>{ let ha=0, horas=0, passadas=0;
    for(const l of ls){ const m=medirLeg(l,o); ha+=m.ha; horas+=m.horas; if(l.tipo==='interior') passadas++; }
    return {ha:+ha.toFixed(2), horas:+horas.toFixed(3), passadas, litros:o.vazao>0?Math.round(ha*o.vazao):0}; };
  const feito=grupos=>grupos.filter(g=>g.length).map((g,i)=>Object.assign({n:i+1, pts:juntar(g)}, medir(g))).filter(x=>x.pts.length>1);

  if(o.modo==='unico') return feito([uteis]).map(x=>Object.assign(x,{nome:'Percurso'}));

  // pedaços contínuos: quebra onde uma perna não encosta na anterior
  const pedacos=[]; let atual=null, ult=null;
  for(const l of uteis){
    if(!atual || (ult && dist(ult, l.p[0])>1.5)){ atual=[]; pedacos.push(atual); }
    atual.push(l); ult=l.p[l.p.length-1];
  }
  if(o.modo==='passos' || o.modo==='trechos')
    return feito(pedacos).map(x=>Object.assign(x, {nome:'Passo '+String(x.n).padStart(2,'0')}));

  // blocos: acumula até o limite e fecha no fim da passada
  const lim=+o.valor>0 ? +o.valor : 0;
  const quanto=(acc,l)=>{ const m=medirLeg(l,o);
    if(o.criterio==='tempo') return acc+m.horas;
    if(o.criterio==='passadas') return acc+(l.tipo==='interior'?1:0);
    if(o.criterio==='tanque') return acc+m.ha*(o.vazao||0);
    return acc+m.ha; };
  if(!lim) return feito(pedacos).map(x=>Object.assign(x, {nome:'Passo '+String(x.n).padStart(2,'0')}));
  const blocos=[]; let bloco=[], acc=0, temTrabalho=false;
  for(const l of uteis){
    const depois=quanto(acc,l);
    // corta antes de começar a próxima passada, nunca no meio dela
    if(temTrabalho && l.t==='w' && l.tipo==='interior' && acc>0 && depois>lim){
      blocos.push(bloco); bloco=[]; acc=0; temTrabalho=false;
      while(bloco.length===0 && blocos.length && blocos[blocos.length-1].length===0) blocos.pop();
    }
    bloco.push(l); acc=quanto(acc,l); if(l.t==='w') temTrabalho=true;
  }
  if(bloco.length) blocos.push(bloco);
  return feito(blocos).map(x=>Object.assign(x, {nome:'Bloco '+String(x.n).padStart(2,'0')}));
}
function percursoContinuo(legs, comBord){
  const pts=[];
  for(const l of legs){
    if(l.t==='x' || (!comBord && l.tipo==='bordadura')) continue;
    for(const q of l.p) if(!pts.length || dist(q,pts[pts.length-1])>1e-6) pts.push(q);
  }
  return pts;
}
/* ===================== camada AB sem cruzamentos =====================
   Linhas de guia para o monitor: cada linha interna vira uma feição contínua.
   Onde uma linha cruza outra (ou ela mesma, num contorno de obstáculo), ela é
   partida em pedaços — a máquina nunca chega a um X sem saber para onde ir. */
function cruzaSeg(a,b,c,d){
  const rx=b[0]-a[0], ry=b[1]-a[1], sx=d[0]-c[0], sy=d[1]-c[1], den=rx*sy-ry*sx;
  if(Math.abs(den)<1e-12) return null;
  const qx=c[0]-a[0], qy=c[1]-a[1], t=(qx*sy-qy*sx)/den, u=(qx*ry-qy*rx)/den;
  if(t<=1e-9||t>=1-1e-9||u<=1e-9||u>=1-1e-9) return null;
  return t;
}
/* acha todos os cruzamentos entre feições (e de uma feição com ela mesma) */
function acharCruzamentos(feats){
  const CEL=25, grade=new Map(), seg=[];
  feats.forEach((f,i)=>{
    for(let k=1;k<f.pts.length;k++){
      const a=f.pts[k-1], b=f.pts[k], id=seg.length;
      seg.push({i,k,a,b});
      const x0=Math.floor(Math.min(a[0],b[0])/CEL), x1=Math.floor(Math.max(a[0],b[0])/CEL);
      const y0=Math.floor(Math.min(a[1],b[1])/CEL), y1=Math.floor(Math.max(a[1],b[1])/CEL);
      for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++){ const c=x+'|'+y; let l=grade.get(c); if(!l) grade.set(c,l=[]); l.push(id); }
    }
  });
  const cortes=feats.map(()=>[]), achados=[], vistos=new Set();
  for(const ids of grade.values()) for(let p=0;p<ids.length;p++) for(let q=p+1;q<ids.length;q++){
    const A=seg[ids[p]], B=seg[ids[q]];
    if(A.i===B.i && Math.abs(A.k-B.k)<2) continue;
    const ch=Math.min(ids[p],ids[q])+'|'+Math.max(ids[p],ids[q]);
    if(vistos.has(ch)) continue; vistos.add(ch);
    const t=cruzaSeg(A.a,A.b,B.a,B.b); if(t===null) continue;
    const u=cruzaSeg(B.a,B.b,A.a,A.b); if(u===null) continue;
    cortes[A.i].push(A.k-1+t); cortes[B.i].push(B.k-1+u);
    achados.push({a:A.i, sa:A.k-1+t, b:B.i, sb:B.k-1+u});
  }
  return {cortes, achados};
}
function pontoEmIndice(pts,t){
  const k=Math.max(0,Math.min(pts.length-2,Math.floor(t))), f=t-k;
  return [pts[k][0]+(pts[k+1][0]-pts[k][0])*f, pts[k][1]+(pts[k+1][1]-pts[k][1])*f];
}
function fatiar(pts, cortes, folga){
  const c=[...new Set(cortes.filter(v=>isFinite(v)&&v>0.01&&v<pts.length-1.01))].sort((a,b)=>a-b);
  if(!c.length) return [pts];
  const out=[]; let ini=0;
  for(const t of c.concat([pts.length-1])){
    const pedaco=[];
    if(ini>0) pedaco.push(pontoEmIndice(pts, ini+folga));
    for(let k=Math.ceil(ini+folga+1e-6);k<=Math.floor(t-folga);k++) pedaco.push(pts[k]);
    if(t<pts.length-1) pedaco.push(pontoEmIndice(pts, t-folga));
    else pedaco.push(pts[pts.length-1]);
    if(pedaco.length>1 && plen(pedaco)>4) out.push(pedaco);
    ini=t;
  }
  return out.length?out:[pts];
}
/* Camada AB sem interseção: as linhas são partidas onde se cruzam e, no que
   sobrar, abre-se uma fresta de 1,5 m na feição mais curta. A máquina nunca
   chega a um "X" sem saber para onde ir. */
function partirNosCruzamentos(linhas){
  let feats=linhas.map(l=>({num:l.num, pts:l.pts}));
  for(let volta=0; volta<5; volta++){
    const {cortes, achados}=acharCruzamentos(feats);
    if(!achados.length) break;
    const novas=[];
    feats.forEach((f,i)=>{ for(const pts of fatiar(f.pts, cortes[i], 0.004)) novas.push({num:f.num, pts}); });
    feats=novas;
  }
  // teima: corta uma fresta na feição mais curta
  for(let volta=0; volta<12; volta++){
    const {achados}=acharCruzamentos(feats);
    if(!achados.length) break;
    const x=achados[0];
    const curta=plen(feats[x.a].pts)<=plen(feats[x.b].pts)?{i:x.a,s:x.sa}:{i:x.b,s:x.sb};
    const f=feats[curta.i], cum=acumulado(f.pts), sM=maisPertoNaLinhaSimples(f.pts, pontoEmIndice(f.pts, curta.s));
    const L=cum[cum.length-1], a=Math.max(0,sM-0.75), b=Math.min(L,sM+0.75);
    const p1=a>4?trechoAberto(f.pts,cum,0,a):null, p2=L-b>4?trechoAberto(f.pts,cum,b,L):null;
    feats.splice(curta.i,1,...[p1,p2].filter(Boolean).map(pts=>({num:f.num, pts})));
  }
  // numeração final: 001, 001-2, 001-3...
  const cont={}, saida=[];
  for(const f of feats){
    cont[f.num]=(cont[f.num]||0)+1;
    saida.push({num:f.num, parte:cont[f.num]>1?cont[f.num]:0, pts:f.pts});
  }
  // se uma linha virou várias, a primeira também ganha o sufixo
  const vezes={}; saida.forEach(f=>vezes[f.num]=(vezes[f.num]||0)+1);
  let idx={};
  return saida.map(f=>{ idx[f.num]=(idx[f.num]||0)+1; return vezes[f.num]>1?{num:f.num, parte:idx[f.num], pts:f.pts}:{num:f.num, parte:0, pts:f.pts}; });
}
function maisPertoNaLinhaSimples(pts,p){
  let m=Infinity, s=0, acc=0;
  for(let i=1;i<pts.length;i++){
    const a=pts[i-1], b=pts[i], dx=b[0]-a[0], dy=b[1]-a[1], L2=dx*dx+dy*dy||1e-9;
    const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/L2));
    const q=[a[0]+dx*t, a[1]+dy*t], d=dist(q,p), L=Math.sqrt(L2);
    if(d<m){ m=d; s=acc+t*L; }
    acc+=L;
  }
  return s;
}
const rotuloSeg=g=>g.nome+(g.ha?' · '+g.ha.toFixed(1).replace('.',',')+' ha':'')+(g.litros?' · '+g.litros+' L':'')
  +(g.horas?' · '+Math.floor(g.horas)+'h'+String(Math.round((g.horas%1)*60)).padStart(2,'0'):'');
function kmlPercurso(nome, segs, proj){
  const ll=pts=>pts.map(p=>{const q=proj.inv(p[0],p[1]); return q[0].toFixed(8)+','+q[1].toFixed(8)+',0';}).join(' ');
  const titulo=segs.length>1 ? ' — percurso em '+segs.length+(/^Bloco/.test(segs[0].nome)?' blocos':' passos') : ' — percurso contínuo';
  return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>'+esc(nome)+titulo+'</name>'
    +'<Style id="pc"><LineStyle><color>ff2dc0fb</color><width>2.2</width></LineStyle></Style>'
    +segs.map(g=>'<Placemark><name>'+esc(segs.length>1?rotuloSeg(g):g.nome)+'</name><styleUrl>#pc</styleUrl>'
      +'<LineString><tessellate>1</tessellate><coordinates>'+ll(g.pts)+'</coordinates></LineString></Placemark>').join('')
    +'</Document></kml>';
}
function kmlAB(nome, bordadura, linhasAB, proj, manobras, trechos){
  const ll=pts=>pts.map(p=>{const q=proj.inv(p[0],p[1]); return q[0].toFixed(8)+','+q[1].toFixed(8)+',0';}).join(' ');
  const P=['<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>'+esc(nome)+' — bordadura e linhas AB</name>',
    '<Style id="bd"><LineStyle><color>ff37d67a</color><width>3.4</width></LineStyle></Style>',
    '<Style id="ab"><LineStyle><color>ffffffff</color><width>2</width></LineStyle></Style>',
    '<Style id="pt"><IconStyle><scale>0.7</scale></IconStyle></Style>',
    '<Folder><name>Bordadura</name>'];
  bordadura.forEach((b,i)=>P.push('<Placemark><name>Bordadura'+(bordadura.length>1?' '+(i+1):'')+'</name><styleUrl>#bd</styleUrl>'
    +'<LineString><tessellate>1</tessellate><coordinates>'+ll(b)+'</coordinates></LineString></Placemark>'));
  P.push('</Folder><Folder><name>Linhas AB</name>');
  linhasAB.forEach(l=>{
    const a=proj.inv(l.pts[0][0],l.pts[0][1]), b=proj.inv(l.pts[l.pts.length-1][0],l.pts[l.pts.length-1][1]);
    const nm=String(l.num).padStart(3,'0')+(l.parte?'-'+l.parte:'');
    const d='Linha '+nm+'<br/>A: '+a[1].toFixed(7)+', '+a[0].toFixed(7)+'<br/>B: '+b[1].toFixed(7)+', '+b[0].toFixed(7)
      +'<br/>Comprimento: '+plen(l.pts).toFixed(1)+' m';
    P.push('<Placemark><name>'+nm+'</name><description><![CDATA['+d+']]></description><styleUrl>#ab</styleUrl>'
      +'<LineString><tessellate>1</tessellate><coordinates>'+ll(l.pts)+'</coordinates></LineString></Placemark>');
  });
  P.push('</Folder>');
  if(manobras && manobras.length){
    P.push('<Style id="mn"><LineStyle><color>ff5aa9e9</color><width>1.6</width></LineStyle></Style>');
    P.push('<Folder><name>Manobras</name>');
    manobras.forEach((m,i)=>P.push('<Placemark><name>M'+String(i+1).padStart(3,'0')+'</name><styleUrl>#mn</styleUrl>'
      +'<LineString><tessellate>1</tessellate><coordinates>'+ll(m.pts)+'</coordinates></LineString></Placemark>'));
    P.push('</Folder><Folder><name>Linhas AB + manobras</name>');
    (trechos&&trechos.length?trechos:linhasAB.map(l=>l.pts)).forEach((pts,i)=>
      P.push('<Placemark><name>Trecho '+String(i+1).padStart(2,'0')+'</name><styleUrl>#ab</styleUrl>'
        +'<LineString><tessellate>1</tessellate><coordinates>'+ll(pts)+'</coordinates></LineString></Placemark>'));
    P.push('</Folder>');
  }
  P.push('<Folder><name>Pontos A e B</name>');
  linhasAB.forEach(l=>{
    const nm=String(l.num).padStart(3,'0')+(l.parte?'-'+l.parte:'');
    [['A',l.pts[0]],['B',l.pts[l.pts.length-1]]].forEach(([r,p])=>{
      const q=proj.inv(p[0],p[1]);
      P.push('<Placemark><name>'+nm+r+'</name><styleUrl>#pt</styleUrl><Point><coordinates>'+q[0].toFixed(8)+','+q[1].toFixed(8)+',0</coordinates></Point></Placemark>');
    });
  });
  P.push('</Folder></Document></kml>');
  return P.join('\n');
}
/* ===================== PDF (sem biblioteca) ===================== */
const MAPA_WIN={0x2014:0x97, 0x2013:0x96, 0x2018:0x91, 0x2019:0x92, 0x201C:0x93, 0x201D:0x94, 0x2026:0x85, 0x2022:0x95};
function latin1(s){ const o=new Uint8Array(s.length); for(let i=0;i<s.length;i++){ const c=s.charCodeAt(i); o[i]=c<256?c:(MAPA_WIN[c]||63); } return o; }

/* ---------- pacote ---------- */
function montarArquivos(nome, rings, passes, proj, crs, extra){
  const enc=new TextEncoder();
  const x=extra||{};
  // carimbo de licença: quem comprou, qual pedido (vai na descrição de cada KML)
  const carimbar=t=>x.licenca?t.replace('</name>','</name><description>'+esc(x.licenca)+'</description>'):t;
  const kml=carimbar(kmlText(nome, rings, passes, proj, 'ff2dc0fb', x));
  const kmlU8=enc.encode(kml);
  const kmzBytes=zipBytes([{name:nome+'.kml',data:kmlU8}]);
  const files=[{name:nome+'.kml',data:kmlU8}];
  // arquivo separado com duas camadas: bordadura e linhas AB (sem cruzamentos)
  if(x.linhasAB){
    const kmlAb=enc.encode(carimbar(kmlAB(nome, x.bordadura||[], x.linhasAB, proj, x.manobras||[], x.trechosPercurso||[])));
    const abBytes=zipBytes([{name:nome+'_ab.kml',data:kmlAb}]);
    files.push({name:nome+'_ab.kml',data:kmlAb}, {name:nome+'_ab.kmz',data:abBytes});
  }
  let rotaKmz=null;
  const segs=x.segmentos||[];
  if(segs.length){
    const p=enc.encode(carimbar(kmlPercurso(nome, segs, proj)));
    rotaKmz=zipBytes([{name:nome+'_rota.kml',data:p}]);
    files.push({name:nome+'_rota.kml',data:p}, {name:nome+'_rota.kmz',data:rotaKmz});
    // um arquivo por pedaço, para o monitor que carrega um caminho de cada vez
    if(x.umArquivoPorSegmento && segs.length>1) for(const g of segs){
      const su=String(g.n).padStart(2,'0'), un=enc.encode(carimbar(kmlPercurso(nome+' · '+g.nome, [g], proj)));
      files.push({name:nome+'_rota_'+su+'.kml',data:un}, {name:nome+'_rota_'+su+'.kmz',data:zipBytes([{name:nome+'_rota_'+su+'.kml',data:un}])});
    }
  }
  // o KMZ do plano completo também entra no pacote
  files.push({name:nome+'.kmz',data:kmzBytes});
  /* cada camada também sai como shapefile próprio (shp, shx, dbf, prj), em UTM e em WGS 84 */
  const escolha=x.shp||{}, quer=k=>!escolha.camadas || escolha.camadas[k];
  const renomear=fs=>x.campos?fs.map(f=>[x.campos[f[0]]||f[0], f[1], f[2], f[3]]):fs;
  const parte=k=>!escolha.partes || escolha.partes[k];
  const sistema=k=>!escolha.sistemas || escolha.sistemas[k];
  const camada=(nomeCam, recs, fields, valores)=>{
    if(!recs.length || !quer(nomeCam)) return;
    const d=dbfCampos(recs, renomear(fields), valores);
    [['utm','utm', q=>q, prjText(crs.kind,crs.zone,crs.south)], ['wgs84','wgs', q=>proj.inv(q[0],q[1]), prjText('wgs84geo')]].forEach(([sis,chave,conv,prj])=>{
      if(!sistema(chave)) return;
      const g=shpPolyline(recs, conv);
      const ordem={bordadura:'01', linhas_ab:'02', manobras:'03', percurso:'04', tudo:'05'}[nomeCam]||'';
      const base='shapefile/'+nome+'_'+(ordem?ordem+'_':'')+nomeCam+'_'+sis;
      if(parte('shp')) files.push({name:base+'.shp',data:g.shp});
      if(parte('shx')) files.push({name:base+'.shx',data:g.shx});
      if(parte('dbf')) files.push({name:base+'.dbf',data:d});
      if(parte('prj')) files.push({name:base+'.prj',data:enc.encode(prj)});
      if(parte('cpg')) files.push({name:base+'.cpg',data:enc.encode('ISO-8859-1')});
    });
  };
  const ll=q=>proj.inv(q[0],q[1]);
  camada('bordadura', (x.bordadura||[]).map((pts,i)=>({pts, i})),
    [['CAMADA','C',12,0],['TRECHO','N',6,0],['COMP_M','N',12,1]],
    r=>['bordadura', r.i+1, plen(r.pts)]);
  camada('linhas_ab', (x.linhasAB||[]).map(l=>({pts:l.pts, num:l.num, parte:l.parte})),
    [['LINHA','N',6,0],['PARTE','N',4,0],['NOME','C',12,0],['COMP_M','N',12,1],['RUMO','N',7,1],
     ['A_LAT','N',14,7],['A_LON','N',14,7],['B_LAT','N',14,7],['B_LON','N',14,7]],
    r=>{ const a=ll(r.pts[0]), b=ll(r.pts[r.pts.length-1]);
      return [r.num, r.parte||0, String(r.num).padStart(3,'0')+(r.parte?'-'+r.parte:''), plen(r.pts),
        (Math.atan2(r.pts[r.pts.length-1][0]-r.pts[0][0], r.pts[r.pts.length-1][1]-r.pts[0][1])*180/Math.PI+360)%360,
        a[1], a[0], b[1], b[0]]; });
  camada('manobras', (x.manobras||[]).map((m,i)=>({pts:m.pts, tipo:m.tipo, i})),
    [['MANOBRA','N',6,0],['TIPO','C',12,0],['COMP_M','N',12,1]],
    r=>[r.i+1, r.tipo||'manobra', plen(r.pts)]);
  const rumoDe2=pts=>(Math.atan2(pts[pts.length-1][0]-pts[0][0], pts[pts.length-1][1]-pts[0][1])*180/Math.PI+360)%360;
  const camposJuntos=[['CAMADA','C',10,0],['LINHA','N',6,0],['PARTE','N',4,0],['NOME','C',12,0],['COMP_M','N',12,1],['RUMO','N',7,1]];
  const valoresJuntos=r=>[r.camada, r.num||0, r.parte||0, r.nome||'', plen(r.pts), rumoDe2(r.pts)];
  const regAB=(x.linhasAB||[]).map(l=>({pts:l.pts, camada:'linha_ab', num:l.num, parte:l.parte||0,
    nome:String(l.num).padStart(3,'0')+(l.parte?'-'+l.parte:'')}));
  // linhas e manobras emendadas: cada feição é um pedaço contínuo do caminho
  const regPercurso=(x.segmentos||[]).map(g=>({pts:g.pts, camada:'percurso', num:g.n, parte:0, nome:g.nome.slice(0,10)}));
  const regMan=(x.manobras||[]).map((m,i)=>({pts:m.pts, camada:'manobra', num:0, parte:0, nome:'M'+String(i+1).padStart(3,'0')}));
  const regBord=(x.bordadura||[]).map((pts,i)=>({pts, camada:'bordadura', num:0, parte:0, nome:'BORD'+(i+1)}));
  // percurso: as linhas AB com as manobras, na mesma camada
  camada('percurso', regPercurso.length?regPercurso:regAB.concat(regMan), camposJuntos, valoresJuntos);
  // tudo junto: bordadura + linhas AB + manobras num arquivo só
  camada('tudo', regBord.concat(regAB, regMan), camposJuntos, valoresJuntos);
  return files;
}

/* =====================================================================
   Pacote pago, montado a partir do plano que o app manda.
   A licença (o que foi pago) vem do banco, nunca do navegador.
   ===================================================================== */
const TODAS = ['linhas_ab', 'bordadura', 'percurso', 'manobras'];
export const CAMADAS_DO_FORMATO = { kml: TODAS, kmz: TODAS, ab: ['bordadura', 'linhas_ab'], rota: ['percurso'], geojson: TODAS, csv: ['linhas_ab'] };
const CAMADAS_DO_SHP = { bordadura: ['bordadura'], linhas_ab: ['linhas_ab'], manobras: ['manobras'], percurso: ['percurso'], tudo: TODAS };
const cobre = (pagas, precisa) => precisa.every(c => pagas.includes(c));

/* formato de cada arquivo que montarArquivos devolve */
function formatoDo(nome) {
  if (nome.startsWith('shapefile/')) return 'shp';
  if (nome.endsWith('_ab.kml') || nome.endsWith('_ab.kmz')) return 'ab';
  if (nome.indexOf('_rota.') >= 0) return 'rota';
  if (nome.endsWith('.kmz')) return 'kmz';
  if (nome.endsWith('.kml')) return 'kml';
  return null;
}

const LIMITES = { pernas: 20000, pontos: 400000, folgaM: 600 };
const numero = v => typeof v === 'number' && isFinite(v);
const pontoOk = q => Array.isArray(q) && q.length >= 2 && numero(q[0]) && numero(q[1]);

/* confere a entrada; devolve texto de erro ou null */
export function validarEntrada(e) {
  if (!e || typeof e !== 'object') return 'Pedido vazio.';
  const c = e.crs || {};
  if (!Number.isInteger(c.zone) || c.zone < 1 || c.zone > 60) return 'Fuso UTM inválido.';
  if (!Array.isArray(e.legs) || !e.legs.length || e.legs.length > LIMITES.pernas) return 'Percurso inválido.';
  let n = 0;
  for (const l of e.legs) {
    if (!l || !['w', 'm', 'x'].includes(l.t) || !Array.isArray(l.p)) return 'Percurso inválido.';
    if (l.t !== 'x' && l.p.length < 2) return 'Percurso inválido.';
    for (const q of l.p) { if (!pontoOk(q) || ++n > LIMITES.pontos) return 'Percurso grande demais ou inválido.'; }
  }
  for (const r of e.obstaculos || []) if (!Array.isArray(r) || r.length > 20000 || !r.every(pontoOk)) return 'Obstáculo inválido.';
  return null;
}

/* talhão em UTM (anéis fechados) e a caixa dele */
function aneisUTM(polys, proj) {
  const aneis = [];
  for (const p of polys) for (const r of [p.outer].concat(p.holes || [])) {
    const u = r.map(q => proj.fwd(q[0], q[1]));
    if (dist(u[0], u[u.length - 1]) > 1e-6) u.push(u[0].slice());
    aneis.push(u);
  }
  return aneis;
}
function caixa(aneis) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of aneis) for (const q of r) { b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); }
  return b;
}

/* e = {nome, crs, polys, legs, obstaculos, formatos:{kml,kmz,ab,rota,shp,geojson,csv}, shp:{camadas,partes,sistemas}, campos}
   licenca = {camadas:[...pagas], texto:'Licenciado a …'}
   devolve {arquivos:[{name,data}], negados:[formatos pedidos que a compra não cobre], costura} */
export function gerarPacote(e, licenca) {
  const erro = validarEntrada(e); if (erro) throw new Error(erro);
  const nome = String(e.nome || 'plano').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'plano';
  const proj = makeUTM(e.crs.zone * 6 - 183, !!e.crs.south);
  const crs = { kind: ['sirgas', 'wgs84'].includes(e.crs.kind) ? e.crs.kind : 'wgs84', zone: e.crs.zone, south: !!e.crs.south };
  const rings = aneisUTM(e.polys, proj);
  // o percurso tem de estar no talhão pago (com folga para as manobras de cabeceira)
  const bx = caixa(rings), f = LIMITES.folgaM;
  for (const l of e.legs) for (const q of l.p)
    if (q[0] < bx[0] - f || q[0] > bx[2] + f || q[1] < bx[1] - f || q[1] > bx[3] + f) throw new Error('O percurso não é deste talhão.');

  const pagas = licenca.camadas || [];
  const fm = e.formatos || {}, negados = [];
  const pode = k => { if (!fm[k]) return false; if (cobre(pagas, CAMADAS_DO_FORMATO[k] || TODAS)) return true; negados.push(k); return false; };
  const quer = { kml: pode('kml'), kmz: pode('kmz'), ab: pode('ab'), rota: pode('rota'), geojson: pode('geojson'), csv: pode('csv') };
  // shapefile: só as camadas pagas
  const shpCam = {};
  if (fm.shp) for (const k of Object.keys(CAMADAS_DO_SHP)) {
    const pedida = !(e.shp && e.shp.camadas) || e.shp.camadas[k];
    if (!pedida) continue;
    if (cobre(pagas, CAMADAS_DO_SHP[k])) shpCam[k] = true; else negados.push('shp:' + k);
  }
  quer.shp = Object.keys(shpCam).length > 0;

  // mesmo preparo do app (núcleo "pacote")
  const cost = costurarLegs(e.legs.map(l => ({ t: l.t, tipo: String(l.tipo || ''), num: l.num | 0, p: l.p })));
  const legs = cost.legs;
  const passes = legs.filter(l => l.t === 'w').map((l, i) => ({ pts: l.p, tipo: l.tipo, ordem: i + 1, num: l.num || 0 }));
  const manobras = legs.filter(l => l.t === 'm').map(l => ({ pts: l.p, tipo: l.tipo }));
  const obst = (e.obstaculos || []).map(pts => ({ pts }));
  const pedacosBord = legs.filter(l => l.tipo === 'bordadura').map(l => l.p), bordadura = [];
  if (pedacosBord.length) {
    const unido = [];
    for (const pts of pedacosBord) for (const q of pts) if (!unido.length || dist(q, unido[unido.length - 1]) > 1e-6) unido.push(q);
    bordadura.push(unido);
  }
  const linhasAB = partirNosCruzamentos(legs.filter(l => l.t === 'w' && l.tipo === 'interior').map(l => ({ num: l.num || 0, pts: l.p })));
  const campos = e.campos && typeof e.campos === 'object' ? Object.fromEntries(Object.entries(e.campos).filter(([k, v]) => typeof v === 'string').map(([k, v]) => [k, v.replace(/[^\w]/g, '').slice(0, 10)])) : null;
  const shp = { camadas: shpCam, partes: (e.shp && e.shp.partes) || null, sistemas: (e.shp && e.shp.sistemas) || null };
  /* como entregar o percurso: um caminho só, passos numerados, um arquivo por pedaço ou blocos */
  const sd = (e.saida && typeof e.saida === 'object') ? e.saida : {};
  const saida = {
    modo: ['unico', 'passos', 'trechos', 'blocos'].includes(sd.modo) ? sd.modo : 'unico',
    criterio: ['tanque', 'area', 'passadas', 'tempo'].includes(sd.criterio) ? sd.criterio : 'area',
    valor: Math.max(0, +sd.valor || 0),
    faixa: Math.max(1, +(e.faixa || (sd.faixa || 30))), vazao: Math.max(0, +sd.vazao || 0),
    vTrab: Math.max(1, +sd.vTrab || 18), vMan: Math.max(1, +sd.vMan || 8),
    comBord: e.bordNoPercurso === true
  };
  const segmentos = segmentarPercurso(legs, saida);

  const todos = montarArquivos(nome, rings, passAttrs(passes), proj, crs,
    { manobras, obstaculos: obst, bordadura, linhasAB, percurso: percursoContinuo(legs, e.bordNoPercurso === true), trechosPercurso: trechosDeTrabalho(legs, e.bordNoPercurso === true),
      segmentos, umArquivoPorSegmento: saida.modo === 'trechos' || saida.modo === 'blocos',
      shp, campos, licenca: licenca.texto || '' });
  const arquivos = todos.filter(a => quer[formatoDo(a.name)]);

  const enc = new TextEncoder();
  const ll = pts => pts.map(q => { const g = proj.inv(q[0], q[1]); return [+g[0].toFixed(8), +g[1].toFixed(8)]; });
  if (quer.geojson) {
    const fs = [];
    for (const p of e.polys) fs.push({ type: 'Feature', properties: { tipo: 'talhao', nome }, geometry: { type: 'Polygon', coordinates: [p.outer, ...(p.holes || [])] } });
    e.legs.forEach((l, i) => { if (l.p.length > 1) fs.push({ type: 'Feature', properties: { ordem: i + 1, tipo: l.tipo, aplicando: l.t === 'w', linha: l.num || 0, comprimento_m: +plen(l.p).toFixed(2) }, geometry: { type: 'LineString', coordinates: ll(l.p) } }); });
    arquivos.push({ name: nome + '.geojson', data: enc.encode(JSON.stringify({ type: 'FeatureCollection', name: nome, licenca: licenca.texto || '', features: fs })) });
  }
  if (quer.csv) {
    const linhas = ['ordem;tipo;linha;aplicando;comprimento_m;rumo_graus'];
    const pa = passAttrs(e.legs.map((l, i) => ({ pts: l.p, tipo: l.tipo, ordem: i + 1, num: l.num || 0 })));
    pa.forEach((p, i) => linhas.push([p.ordem, p.tipo, p.num, e.legs[i].t === 'w' ? 'sim' : 'nao', p.L.toFixed(2).replace('.', ','), p.rumo.toFixed(2).replace('.', ',')].join(';')));
    arquivos.push({ name: nome + '.csv', data: enc.encode('﻿' + linhas.join('\r\n')) });
  }
  return { arquivos, negados, costura: { costuras: cost.costuras, vaos: cost.vaos.length, linhas: linhasAB.length } };
}
export { zipStore, makeUTM };
