# groupsnap.dancykier.com

Repo `moshed/groupsnap-site`, served from GitHub Pages. Two things live here:

| Path | What |
|---|---|
| `/` | the landing page (`index.html`) — one file, markup + CSS, no build step |
| `/app/` | **the browser client** — `index.html` + `app.js`, same shape |
| `/j/<CODE>` | the share link. See "How a share link resolves" below |
| `/.well-known/apple-app-site-association` | claims `/j/*` for the iPhone app |
| `/privacy.html` | privacy policy |

There is no build step and no dependency. Edit, commit, push; Pages rebuilds in
about a minute.

**`.nojekyll` must stay.** Jekyll skips dot-directories, so without it
`/.well-known/apple-app-site-association` 404s and the app silently stops
claiming universal links. That was true from July until 2026-09-03 and nobody
noticed, because a custom-scheme QR hid the symptom.

## How a share link resolves

`https://groupsnap.dancykier.com/j/QEVTPP` has three possible endings:

1. **iPhone with the app** — iOS matches the AASA and opens GroupSnap straight
   into the join sheet. Nothing touches this site.
2. **No app** — GitHub Pages has no rewrites, so `/j/QEVTPP` is a 404. `404.html`
   reads the code out of the path and replaces the location with
   `/app/?c=QEVTPP`, which joins automatically.
3. **A bare `/app/`** — the join screen, where the code is typed by hand.

`GroupShare.joinURL(code:)` in the iOS app produces form 1/2; `useUniversalLink`
is now `true`, so that is what a freshly rendered QR or poster carries. The old
`groupsnap://join/<CODE>` scheme still parses, so nothing already printed breaks.

## The browser client (`/app/`)

Same albums, same photos, same backend as the iPhone app — see
`/Users/moshe/Apps/GroupSnap/CLAUDE-supabase.md` for the functions and the
security model. Nothing here is GroupSnap-web-specific on the server: **not one
edge function was added or changed to make this work.** They were already
deployed `--no-verify-jwt` with `Access-Control-Allow-Origin: *`, because the
app has no JWT to verify either.

**Identity is a UUID in `localStorage`** under `gs.device_id`, sent as
`device_id` on every call. That is exactly what the iOS app does, except it
keeps the UUID in the iCloud-synced Keychain. Consequences worth knowing:

- clearing site data = a new person, and the old photos stay under the old id;
- a browser guest and the same human's phone are two different members of the
  album, both showing up in the member list.

Neither is fixable without real accounts, which is the thing this app is built
not to have.

The anon key is in `app.js` in plain sight. That is fine and deliberate: RLS on
every `gs_` table is deny-all with **zero** policies, so the key by itself reads
and writes nothing. `requireMember()` inside the functions is the whole
authorisation model.

### What it does and does not do

Does: join by code · merged roll across every album · one album at a time ·
upload photos and video · like · comment · read `@<device-id>` mentions back as
current names · save a photo · delete your own (or anyone's, if you host).

Does not:

- **create an album.** Hosting stays in the app. A host needs the QR, the
  poster, the radius picker and the close/extend controls, and none of that is
  worth rebuilding for a guest-shaped client.
- **join a `location`-mode album.** A desktop browser's geolocation is nowhere
  near accurate enough to stand in for "you are at the venue", so the client
  never sends coordinates and lets `gs-join` refuse. `code` and `both` work.
- **compose an @mention.** It renders them correctly; the picker is app-only.
- **pay.** A free album holds 9 people; past that only the *host* can unlock it,
  and only from the app (StoreKit has no web equivalent here). A browser guest
  who hits the wall gets `gs-join`'s 402 text telling them to ask the host,
  which the join screen already surfaces verbatim.
- **receive push.** No APNs, and `gs-register-device` is never called.

### Uploading

`gs-sign-upload` → `PUT` the bytes at the signed URL → `gs-add-photo`. Images
are downscaled to a 2400px long edge and re-encoded as JPEG at 0.85 in a canvas
first, which also yields real pixel dimensions (EXIF cannot be trusted for
those). If the browser cannot decode the file at all — desktop Chrome and HEIC
is the usual pair — `rawImage()` sends the original bytes instead, because
losing the downscale beats losing the photo. Video is passed straight through,
never transcoded.

## Screenshotting it

Headless Chrome **ignores `--window-size` below 500px** and lays out at 500 CSS
px regardless, so a `--window-size=390,844` screenshot is a 390px *crop* of a
500px page and the top-right buttons appear to be missing. They are not. Shoot
at 500 or wider.

To render a signed-in screen, copy `app/` somewhere scratch and inject a prelude
that seeds `localStorage` from the query string before `app.js` loads. Never
commit that prelude.
