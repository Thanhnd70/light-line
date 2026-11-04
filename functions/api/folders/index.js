import { json, bad, newId, withUser } from '../../_lib.js';

/* Lists only this account's folders, with the count of its own items. */
export const onRequestGet = withUser(async ({ env }, user) => {
  const { results } = await env.DB.prepare(
    `SELECT f.id, f.name, f.created_at,
            (SELECT COUNT(*) FROM items i WHERE i.folder_id = f.id AND i.user_id = ?) AS item_count
       FROM folders f
      WHERE f.user_id = ?
      ORDER BY f.created_at ASC`
  ).bind(user.id, user.id).all();
  return json({ folders: results || [] });
});

export const onRequestPost = withUser(async ({ request, env }, user) => {
  let body;
  try { body = await request.json(); } catch { return bad('Send a JSON body.'); }

  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) return bad('Give the folder a name.');

  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM folders WHERE user_id = ?').bind(user.id).first();
  if (count && count.n >= 200) return bad('You have reached 200 folders.');

  const dup = await env.DB.prepare('SELECT id FROM folders WHERE user_id = ? AND name = ?').bind(user.id, name).first();
  if (dup) return bad('You already have a folder with that name.', 409);

  const folder = { id: newId(), name, created_at: Date.now(), item_count: 0 };
  await env.DB.prepare('INSERT INTO folders (id, user_id, name, created_at) VALUES (?, ?, ?, ?)')
    .bind(folder.id, user.id, folder.name, folder.created_at).run();

  return json({ folder }, 201);
});
