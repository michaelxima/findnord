# FindNord Roadmap

## Committed project memory

**FindNord will be built as a mobile application after the current web work.**

This is recorded here on purpose so the intent is not lost between slices. No
mobile work is in progress yet and none is scheduled -- it follows the web
build-out. Everything built now is meant to be carried into native mobile apps
(iOS/Android), which makes a few current decisions worth keeping deliberate:

- **The HTTP API is the portability boundary.** All real functionality already
  goes through `/api`, with `data-service.js` as a thin fetch client over it
  (see `EVIDENCE.md`, NM-A11). A mobile client must be able to call those same
  endpoints unchanged, so no capability may exist only as UI logic in
  `app.js` with no API path behind it.
- **Category taxonomy is already server-driven.** `GET /api/categories` serves
  the whole taxonomy from `db/seed-data.js`, so a second client inherits it for
  free rather than re-hardcoding category ids.
- **Translations are NOT yet portable.** The 6-language i18n table still lives
  inside `app.js` (`translations`, plus the category labels/synonyms/chips
  maps). Making them a shared, loadable resource is the main extraction step a
  mobile client would need.
- **Keep the auth model portable.** Sessions use the `fn_session` httpOnly
  cookie, which is browser-shaped. A mobile client will need the same session
  semantics available in a header/token form while keeping the identical
  server-side ownership checks.
- **Isolate browser-only primitives.** History-API routing, DOM rendering and
  geolocation are the browser-specific seams; platform-neutral logic should not
  grow inside them.
