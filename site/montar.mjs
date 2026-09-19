/* Monta public/ para publicar: app + ícones + PWA. Roda sozinho no "npx wrangler deploy" ([build] do wrangler.toml). */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const pub = new URL('./public/', import.meta.url), raiz = new URL('../', import.meta.url);
rmSync(pub, { recursive: true, force: true }); mkdirSync(pub);

const app = readFileSync(new URL('plantare-maps.html', raiz));
writeFileSync(new URL('index.html', pub), app);

const icones = new URL('plantare-maps-logo/favicon/', raiz);
for (const f of readdirSync(icones)) if (!/^(head-snippet\.html|site\.webmanifest)$/.test(f)) cpSync(new URL(f, icones), new URL(f, pub));

cpSync(new URL('./pwa/site.webmanifest', import.meta.url), new URL('site.webmanifest', pub));
cpSync(new URL('plantare-maps-logo/compartilhar/og-1200x630.jpg', raiz), new URL('og-1200x630.jpg', pub));   // prévia do link (og:image)
const versao = createHash('sha256').update(app).digest('hex').slice(0, 12);
writeFileSync(new URL('sw.js', pub), readFileSync(new URL('./pwa/sw.js', import.meta.url), 'utf8').replace('__VERSAO__', versao));
console.log('public/ montado · versão ' + versao + ' · ' + readdirSync(pub).length + ' arquivos');
