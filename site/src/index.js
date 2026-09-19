/* Site do Plantare Maps: serve o app (public/) no domínio principal e redireciona os endereços secundários. */
const PRINCIPAL = 'plantaremaps.com.br';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.hostname !== PRINCIPAL) {
      url.hostname = PRINCIPAL; url.protocol = 'https:'; url.port = '';
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(req);
  }
};
