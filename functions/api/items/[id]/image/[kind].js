import { bad, withUser } from '../../../../_lib.js';

/* Serves one stored image. The R2 key is read from the row that matches BOTH
   the item id and the caller's user id, so a guessed id from another account
   finds no row and returns 404 — the key is never built from the URL. */
export const onRequestGet = withUser(async ({ params, env, request }, user) => {
  const kind = params.kind === 'before' ? 'before' : params.kind === 'after' ? 'after' : null;
  if (!kind) return bad('Ask for the before or after image.', 404);

  const item = await env.DB.prepare(
    'SELECT before_key, after_key, before_type, after_type FROM items WHERE id = ? AND user_id = ?'
  ).bind(params.id, user.id).first();
  if (!item) return bad('Comparison not found.', 404);

  const key = kind === 'before' ? item.before_key : item.after_key;
  const object = await env.BUCKET.get(key);
  if (!object) return bad('Image not found.', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('content-type', (kind === 'before' ? item.before_type : item.after_type) || 'application/octet-stream');
  // Private: belongs to one signed-in account, so no shared or CDN cache.
  headers.set('cache-control', 'private, max-age=600');

  if (request.headers.get('if-none-match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { headers });
});
