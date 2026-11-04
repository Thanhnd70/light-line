/* Worker entry point.
   Cloudflare now deploys this kind of project with `wrangler deploy`, which
   expects one Worker script rather than a routed functions/ directory. This
   file is that script: it maps request paths to the handlers in functions/
   and hands everything else to the static files in public/. */

import * as authRegister from '../functions/api/auth/register.js';
import * as authLogin from '../functions/api/auth/login.js';
import * as authLogout from '../functions/api/auth/logout.js';
import * as authMe from '../functions/api/auth/me.js';
import * as folders from '../functions/api/folders/index.js';
import * as folderById from '../functions/api/folders/[id].js';
import * as items from '../functions/api/items/index.js';
import * as itemById from '../functions/api/items/[id]/index.js';
import * as itemImage from '../functions/api/items/[id]/image/[kind].js';

/* Anchored patterns, most specific first. Each captures the parameters the
   matching handler expects under `params`. */
const ROUTES = [
  { re: /^\/api\/auth\/register\/?$/,                     mod: authRegister, keys: [] },
  { re: /^\/api\/auth\/login\/?$/,                        mod: authLogin,    keys: [] },
  { re: /^\/api\/auth\/logout\/?$/,                       mod: authLogout,   keys: [] },
  { re: /^\/api\/auth\/me\/?$/,                           mod: authMe,       keys: [] },
  { re: /^\/api\/items\/([^/]+)\/image\/([^/]+)\/?$/,     mod: itemImage,    keys: ['id', 'kind'] },
  { re: /^\/api\/items\/([^/]+)\/?$/,                     mod: itemById,     keys: ['id'] },
  { re: /^\/api\/items\/?$/,                              mod: items,        keys: [] },
  { re: /^\/api\/folders\/([^/]+)\/?$/,                   mod: folderById,   keys: ['id'] },
  { re: /^\/api\/folders\/?$/,                            mod: folders,      keys: [] }
];

const METHOD_HANDLER = {
  GET: 'onRequestGet',
  POST: 'onRequestPost',
  PATCH: 'onRequestPatch',
  PUT: 'onRequestPut',
  DELETE: 'onRequestDelete',
  HEAD: 'onRequestGet'
};

const jsonError = (message, status) => new Response(JSON.stringify({ error: message }), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      for (const route of ROUTES) {
        const m = route.re.exec(url.pathname);
        if (!m) continue;

        const params = {};
        route.keys.forEach((key, i) => {
          try { params[key] = decodeURIComponent(m[i + 1]); }
          catch { params[key] = m[i + 1]; }
        });

        const handler = route.mod[METHOD_HANDLER[request.method]] || route.mod.onRequest;
        if (!handler) return jsonError('Method not allowed.', 405);

        // Same shape the handlers were written against.
        const context = {
          request, env, params,
          waitUntil: ctx.waitUntil.bind(ctx),
          next: () => env.ASSETS ? env.ASSETS.fetch(request) : new Response(null, { status: 404 }),
          data: {}
        };

        try {
          const res = await handler(context);
          // HEAD must not carry a body.
          if (request.method === 'HEAD' && res && res.body) {
            return new Response(null, { status: res.status, headers: res.headers });
          }
          return res;
        } catch (err) {
          console.error('API error', url.pathname, err && err.stack || err);
          return jsonError('Something went wrong on the server.', 500);
        }
      }
      return jsonError('Not found.', 404);
    }

    // Everything else is the static site.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  }
};
