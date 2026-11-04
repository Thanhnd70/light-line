# Lightline Compare

Before / after image comparison with a drag-to-reveal slider, accounts, and a
folder archive. Runs on Cloudflare Pages with D1 for accounts and metadata and
R2 for the images.

```
public/          the app (static)
functions/       Pages Functions — the API
  _lib.js        shared auth helpers (underscore = not routed)
  api/auth/      register, login, logout, me
  api/folders/   list, create, rename, delete
  api/items/     list, upload, move, delete, serve images
schema.sql       D1 tables
migrations/      schema changes for a database created before a fix
wrangler.toml    bindings
test/            integration tests
```

## Deploy

You need a Cloudflare account and Node 18+. Run everything from this folder.

**1. Sign in**

```bash
npx wrangler login
```

**2. Create the database**

```bash
npx wrangler d1 create lightline
```

Copy the `database_id` it prints into `wrangler.toml`, replacing
`PASTE_YOUR_D1_DATABASE_ID_HERE`.

**3. Create the tables**

```bash
npx wrangler d1 execute lightline --remote --file=./schema.sql
```

**4. Create the image bucket**

```bash
npx wrangler r2 bucket create lightline-images
```

**5. Deploy**

```bash
npx wrangler pages deploy
```

The first deploy asks for a project name — use `lightline`. You get a
`https://lightline.pages.dev` URL.

**6. Connect the bindings in the dashboard**

Pages projects read bindings from project settings, not only from
`wrangler.toml`. In the dashboard open **Workers & Pages → lightline →
Settings → Bindings**, and for **Production** (repeat for Preview if you use
it) add:

| Type | Variable name | Value |
|---|---|---|
| D1 database | `DB` | `lightline` |
| R2 bucket | `BUCKET` | `lightline-images` |

Then redeploy (`npx wrangler pages deploy`) so the new bindings take effect.

To update later, run `npx wrangler pages deploy` again. If you changed
`public/index.html`, bump `CACHE` in `public/sw.js` (`lightline-shell-v1` →
`v2`) first, so installed clients pick up the new build instead of serving the
cached one.

## Run it locally

```bash
npx wrangler d1 execute lightline --local --persist-to=./.wrangler-test --file=./schema.sql
npx wrangler pages dev --persist-to=./.wrangler-test --port=8788
```

Then in a second terminal:

```bash
node test/api.test.mjs
```

`test/api.test.mjs` covers email format, duplicate accounts, password rules,
session handling, and every cross-account path. `test/geometry.test.mjs` drives
a real browser and measures the rectangle each image layer paints into, for
pairs that differ in resolution and in aspect ratio; it needs Playwright
(`npm i -D playwright`). Both create throwaway accounts in the local database,
so don't point them at production.

## How accounts stay separate

- **Email** is normalised to lowercase and checked against one format rule used
  on both the client and the server. `users.email` has a UNIQUE index, so two
  accounts can never share an address regardless of casing or races.
- **Passwords** are stored as PBKDF2-SHA256, 210,000 iterations, with a random
  per-user salt. The password itself is never stored or logged. A wrong
  password and an unknown account take the same time and return the same
  message.
- **Sessions** live in an HttpOnly, SameSite=Lax, Secure cookie. The database
  stores only the SHA-256 of the token, so a database dump cannot be replayed
  as a login.
- **Every API route** derives the account from the session cookie. No endpoint
  accepts a user id from the client, and every SQL statement carries
  `WHERE user_id = ?`.
- **Images** are stored in R2 under `u/{user_id}/{item_id}/{before|after}`. The
  serving route looks the key up from the row matching both the item id *and*
  the caller's user id, so a guessed id from another account finds no row and
  returns 404. The key is never built from the URL.
- **The service worker** never caches anything under `/api/`, so no per-account
  response can be served to a different account from a shared cache.

## Image sizing

The two images must land on exactly the same rectangle, or the reveal line
compares two differently-placed pictures. The after image defines the frame and
both layers are fitted into it with one identical rule:

- **Same aspect ratio** (the normal case) — the rule is a no-op. A 1200x800
  before and a 4000x2667 after render at exactly the same size, so the
  resolution difference is invisible.
- **Different aspect ratios** — the app says so and offers two choices.
  *Match edges* (the default) fills the frame with both, so edges and
  horizontal positions align; the odd one out is cropped top/bottom or
  left/right. *Show all* keeps every pixel of both instead, letterboxing the
  one that does not fit.

The choice is saved with the comparison and reused when you reopen it, and the
PNG export reproduces the same geometry rather than stretching either image.

## Upgrading a database created before this fix

If you deployed before the image-sizing fix, add the three new columns:

```bash
npx wrangler d1 execute lightline --remote --file=./migrations/001-before-dims.sql
```

Existing rows get NULL, which the app reads as "same shape as the after image" —
how those pairs already behaved.

## Limits

- 10 MB per image, JPEG / PNG / WebP / GIF / AVIF.
- 500 comparisons listed per request, 200 folders per account.
- Sessions last 30 days.
- There is no password reset. Adding one needs an email sender such as
  MailChannels or Resend.
