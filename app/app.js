/* GroupSnap — browser client for the same shared albums as the iPhone app.
 *
 * There is no login. Identity is a UUID this browser generated, held in
 * localStorage, sent as `device_id` on every call — exactly the same contract the
 * iOS app uses, where the UUID lives in the (iCloud-synced) Keychain instead.
 *
 * Every gs-* edge function is deployed --no-verify-jwt and answers
 * Access-Control-Allow-Origin: *, so the browser talks to them directly. The anon
 * key below is public by design: RLS on every gs_ table is deny-all with zero
 * policies, so the key alone reads and writes nothing. Membership, checked inside
 * the functions on the service role, is the whole authorisation model.
 */
'use strict';

const SUPABASE_URL = 'https://atqhfbaurrmivjarowco.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0cWhmYmF1cnJtaXZqYXJvd2NvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzODc2ODgsImV4cCI6MjA5NTk2MzY4OH0.buWqvUnwid4QEE6m9OFM7n1tu51mcogTc01oG7pdtJI';

const POLL_MS = 5000;
const MAX_EDGE = 2400;        // downscale ceiling — a 12MP phone shot is 4× this
const JPEG_QUALITY = 0.85;

const EMOJI = ['🙂','😎','🥳','🤩','😇','🦊','🐻','🐼','🦁','🐸',
               '🦄','🐙','🌻','🔥','⚡️','🌈','🍕','🎸','🏀','👑'];

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ identity */

const me = {
  get id() {
    let v = localStorage.getItem('gs.device_id');
    if (!v) {
      v = (crypto.randomUUID ? crypto.randomUUID() : fallbackUUID());
      localStorage.setItem('gs.device_id', v);
    }
    return v;
  },
  get name()  { return localStorage.getItem('gs.name') || ''; },
  set name(v) { localStorage.setItem('gs.name', v); },
  get emoji()  { return localStorage.getItem('gs.emoji') || '🙂'; },
  set emoji(v) { localStorage.setItem('gs.emoji', v); },
};

function fallbackUUID() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

/* ------------------------------------------------------------------ backend */

async function fn(name, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ device_id: me.id, ...body }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------------------------------------------ state */

const state = {
  events: [],        // albums this device is in
  eventId: null,     // null = the merged roll across every album
  event: null,       // the full row when a single album is selected
  members: [],
  photos: [],
  since: null,       // ISO cursor for the incremental gs-feed poll
  photo: null,       // the photo open in the viewer
  timer: null,
};

const screen = (n) => { document.body.dataset.screen = n; };

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

/* ------------------------------------------------------------------ boot */

function readCodeFromURL() {
  const u = new URL(location.href);
  const raw = u.searchParams.get('c')
    || (u.hash || '').replace('#', '')
    || (u.pathname.match(/\/j\/([^/]+)/i) || [])[1]
    || '';
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === 6 ? code : null;
}

let pendingCode = readCodeFromURL();

async function boot() {
  buildEmojiGrid($('ob-emoji'), () => me.emoji, (e) => { me.emoji = e; });
  buildEmojiGrid($('me-emoji-grid'), () => me.emoji, (e) => { me.emoji = e; });
  wireUp();

  if (!me.name) { screen('onboard'); $('ob-name').focus(); return; }
  await afterOnboard();
}

async function afterOnboard() {
  $('me-emoji').textContent = me.emoji;
  try {
    const { events } = await fn('gs-my-events', {});
    state.events = events || [];
  } catch (e) {
    state.events = [];
  }

  if (pendingCode) {
    $('join-code').value = pendingCode;
    $('join-go').disabled = false;
    screen('join');
    updateJoinBack();
    doJoin();
    return;
  }

  if (!state.events.length) { screen('join'); updateJoinBack(); return; }

  // Land on the album you were last in, if you are still in it.
  const last = localStorage.getItem('gs.selected');
  state.eventId = state.events.some((e) => e.id === last) ? last : null;
  openRoll();
}

function updateJoinBack() {
  $('join-back-wrap').style.display = state.events.length ? 'block' : 'none';
}

/* ------------------------------------------------------------------ onboarding */

function buildEmojiGrid(host, get, set) {
  host.innerHTML = '';
  EMOJI.forEach((e) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.setAttribute('aria-pressed', String(e === get()));
    b.onclick = () => {
      set(e);
      [...host.children].forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
      $('me-emoji').textContent = me.emoji;
    };
    host.appendChild(b);
  });
}

/* ------------------------------------------------------------------ joining */

async function doJoin() {
  const code = $('join-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return;

  $('join-err').textContent = '';
  $('join-go').disabled = true;
  $('join-go').textContent = 'Joining…';

  try {
    const { event } = await fn('gs-join', { code, name: me.name, emoji: me.emoji });
    pendingCode = null;
    history.replaceState(null, '', location.pathname);

    const { events } = await fn('gs-my-events', {});
    state.events = events || [];
    state.eventId = event.id;
    localStorage.setItem('gs.selected', event.id);
    openRoll();
    toast(`You're in ${event.name}`);
  } catch (e) {
    // A location-only album can't be entered from a browser: the iOS app asks the
    // OS for a fix, but a desktop browser's geolocation is nowhere near accurate
    // enough to be a venue check, so we never claim one.
    $('join-err').textContent = e.message;
  } finally {
    $('join-go').disabled = false;
    $('join-go').textContent = 'Join';
  }
}

/* ------------------------------------------------------------------ the roll */

function openRoll() {
  screen('roll');
  state.photos = [];
  state.since = null;
  state.members = [];
  $('grid').innerHTML = '';
  renderHeader();
  refresh(true);
  startPolling();
}

function startPolling() {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (document.hidden) return;
    if ($('viewer').classList.contains('on')) return;
    refresh(false);
  }, POLL_MS);
}

function selectedEvent() {
  return state.events.find((e) => e.id === state.eventId) || state.event || null;
}

function isLive(e) {
  if (!e) return false;
  if (!e.is_open) return false;
  return !e.ends_at || new Date(e.ends_at) > new Date();
}

function renderHeader() {
  const e = selectedEvent();
  if (!e) {
    $('album-emoji').textContent = '📸';
    $('album-name').textContent = 'All photos';
    $('album-meta').textContent =
      `${state.events.length} album${state.events.length === 1 ? '' : 's'}`;
  } else {
    $('album-emoji').textContent = e.emoji || '📸';
    $('album-name').textContent = e.name;
    const bits = [];
    const n = state.members.length || e.member_count || 0;
    if (n) bits.push(`${n} here`);
    if (e.code && isLive(e)) bits.push(e.code);
    if (!isLive(e)) bits.push('closed');
    $('album-meta').textContent = bits.join(' · ');
  }
  // "Post to all my albums at once" is not a thing anyone wants — the merged roll
  // has no shutter, same rule as the iOS app.
  $('btn-add').style.display = e && isLive(e) ? 'grid' : 'none';
}

async function refresh(full) {
  try {
    if (!state.eventId) {
      const { photos } = await fn('gs-all-photos', { limit: 300 });
      state.photos = photos || [];
    } else if (full || !state.since) {
      const r = await fn('gs-feed', { event_id: state.eventId });
      state.event = r.event;
      state.members = r.members || [];
      state.photos = r.photos || [];
      state.since = r.server_time;
    } else {
      const r = await fn('gs-feed', { event_id: state.eventId, since: state.since });
      state.event = r.event;
      state.members = r.members || [];
      state.since = r.server_time;
      const fresh = (r.photos || []).filter(
        (p) => !state.photos.some((q) => q.id === p.id));
      if (fresh.length) state.photos = [...fresh, ...state.photos];
    }
    renderHeader();
    renderGrid();
  } catch (e) {
    if (full) toast(e.message);
  }
}

function renderGrid() {
  const grid = $('grid');
  const empty = $('roll-empty');
  const foot = $('roll-foot');

  if (!state.photos.length) {
    grid.innerHTML = '';
    const e = selectedEvent();
    empty.innerHTML = `<div class="empty"><div class="big">${e ? (e.emoji || '📸') : '📸'}</div>
      <div><b>${e ? 'No photos yet' : 'Nothing here yet'}</b></div>
      <div style="margin-top:6px">${
        e && isLive(e) ? 'Tap + to add the first one.'
        : e ? 'This album is closed.'
        : 'Join an album to start.'}</div></div>`;
    foot.textContent = '';
    return;
  }
  empty.innerHTML = '';

  // Rebuild only what changed — the poll runs every 5s and a full innerHTML wipe
  // would restart every image download and kill the scroll position.
  const want = state.photos.map((p) => p.id).join(',');
  if (grid.dataset.ids !== want) {
    grid.dataset.ids = want;
    grid.innerHTML = '';
    state.photos.forEach((p, i) => grid.appendChild(tile(p, i)));
  } else {
    state.photos.forEach((p, i) => {
      const el = grid.children[i];
      if (el) el.querySelector('.heart').textContent = p.like_count ? `♥ ${p.like_count}` : '';
    });
  }

  foot.textContent =
    `${state.photos.length} photo${state.photos.length === 1 ? '' : 's'}`;
}

function tile(p, i) {
  const b = document.createElement('button');
  b.className = 'tile';
  b.onclick = () => openViewer(i);

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = p.url;
  img.alt = p.caption || `Photo by ${p.uploader_name}`;
  b.appendChild(img);

  if (p.kind === 'video') {
    const v = document.createElement('span');
    v.className = 'vid'; v.textContent = '▶';
    b.appendChild(v);
  }

  const heart = document.createElement('span');
  heart.className = 'heart';
  heart.textContent = p.like_count ? `♥ ${p.like_count}` : '';
  b.appendChild(heart);

  // The merged roll labels each tile with the album it came from; inside one
  // album that label would say the same thing on every tile, so it names the
  // person instead.
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = state.eventId
    ? p.uploader_name
    : `${p.event_emoji || '📸'} ${p.event_name || ''}`;
  b.appendChild(tag);

  return b;
}

/* ------------------------------------------------------------------ uploading */

/** Downscale to a sane edge and re-encode as JPEG. Also yields real pixel
 *  dimensions, which the grid needs and EXIF cannot be trusted for. */
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
  return blob ? { blob, w, h, ext: 'jpg', type: 'image/jpeg' } : null;
}

/** Send the file exactly as it came off disk. Used when we could not decode it.
 *  The extension has to come from the name or the MIME type, and has to be one
 *  gs-sign-upload will sign for — anything else is refused server-side anyway. */
function rawImage(file) {
  const OK = { jpg: 1, jpeg: 1, png: 1, heic: 1 };
  const fromName = (file.name.split('.').pop() || '').toLowerCase();
  const fromType = (file.type.split('/')[1] || '').toLowerCase();
  const ext = OK[fromName] ? fromName : (OK[fromType] ? fromType : null);
  if (!ext) return null;
  return { blob: file, w: null, h: null, ext, type: file.type || 'application/octet-stream' };
}

async function uploadFiles(files) {
  const e = selectedEvent();
  if (!e || !isLive(e)) { toast('Pick an open album first.'); return; }

  const list = [...files].slice(0, 40);
  if (!list.length) return;

  $('uploading').classList.add('on');
  let done = 0, failed = 0;

  for (const file of list) {
    $('up-label').textContent = `Uploading ${done + 1} of ${list.length}…`;
    $('up-bar').style.width = `${(done / list.length) * 100}%`;

    try {
      let payload;
      if (file.type.startsWith('video/')) {
        const ext = /quicktime/.test(file.type) ? 'mov' : 'mp4';
        payload = { blob: file, w: null, h: null, ext, type: file.type };
      } else {
        // A browser that cannot decode the file — desktop Chrome and HEIC is the
        // usual pair — still gets to upload it. The bucket accepts heic, iOS
        // renders it, and losing the photo would be far worse than losing the
        // downscale.
        payload = await prepareImage(file) || rawImage(file);
        if (!payload) throw new Error('Unsupported file type.');
      }

      const signed = await fn('gs-sign-upload', { event_id: e.id, ext: payload.ext });

      const put = await fetch(signed.signed_url, {
        method: 'PUT',
        headers: { 'Content-Type': payload.type },
        body: payload.blob,
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);

      await fn('gs-add-photo', {
        event_id: e.id,
        path: signed.path,
        width: payload.w,
        height: payload.h,
        captured_at: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      });
      done++;
    } catch (err) {
      failed++;
      console.error('[GroupSnap] upload failed', err);
    }
  }

  $('up-bar').style.width = '100%';
  setTimeout(() => $('uploading').classList.remove('on'), 400);

  toast(failed
    ? `Added ${done}, ${failed} failed`
    : `Added ${done} photo${done === 1 ? '' : 's'}`);

  state.since = null;
  refresh(true);
}

/* ------------------------------------------------------------------ viewer */

function openViewer(i) {
  const p = state.photos[i];
  if (!p) return;
  state.photo = p;

  $('v-name').textContent = p.uploader_name || 'Someone';
  $('v-when').textContent = when(p.captured_at || p.created_at);
  $('v-cap').textContent = p.caption || '';
  $('v-album').textContent = state.eventId ? '' : (p.event_name || '');
  $('v-save').href = p.url;
  $('v-save').setAttribute('download', p.path.split('/').pop());
  $('v-del').style.display = (p.is_mine || amHost()) ? 'grid' : 'none';
  $('v-del').dataset.armed = '';

  const stage = $('v-stage');
  stage.innerHTML = '';
  if (p.kind === 'video') {
    const v = document.createElement('video');
    v.src = p.url; v.controls = true; v.playsInline = true; v.autoplay = true;
    stage.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.src = p.url;
    img.alt = p.caption || `Photo by ${p.uploader_name}`;
    stage.appendChild(img);
  }

  paintLike(p);
  $('comments').innerHTML = '<div class="cmt-empty">Loading…</div>';
  $('viewer').classList.add('on');
  loadComments(p.id);
}

function amHost() {
  const e = selectedEvent();
  if (e && e.is_host) return true;
  const m = state.members.find((x) => x.device_id === me.id);
  return !!(m && m.is_host);
}

function closeViewer() {
  const v = $('v-stage').querySelector('video');
  if (v) v.pause();
  $('viewer').classList.remove('on');
  state.photo = null;
  renderGrid();
}

function step(delta) {
  const i = state.photos.findIndex((p) => p.id === state.photo?.id);
  if (i < 0) return;
  const next = i + delta;
  if (next < 0 || next >= state.photos.length) return;
  openViewer(next);
}

function paintLike(p) {
  $('v-likes').textContent = p.like_count || 0;
  $('v-like').classList.toggle('liked', !!p.liked_by_me);
}

async function toggleLike() {
  const p = state.photo;
  if (!p) return;
  const on = !p.liked_by_me;

  // Optimistic — the poll is 5s away and a heart that lags feels broken.
  p.liked_by_me = on;
  p.like_count = Math.max(0, (p.like_count || 0) + (on ? 1 : -1));
  paintLike(p);

  try {
    const r = await fn('gs-react', { photo_id: p.id, emoji: '❤️', on });
    p.like_count = r.like_count;
    p.liked_by_me = r.liked_by_me;
    paintLike(p);
  } catch (e) {
    p.liked_by_me = !on;
    p.like_count = Math.max(0, (p.like_count || 0) + (on ? -1 : 1));
    paintLike(p);
    toast(e.message);
  }
}

async function deletePhoto() {
  const btn = $('v-del');
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    toast('Tap delete again to remove this photo');
    setTimeout(() => { btn.dataset.armed = ''; }, 4000);
    return;
  }
  const p = state.photo;
  try {
    await fn('gs-delete-photo', { photo_id: p.id });
    state.photos = state.photos.filter((q) => q.id !== p.id);
    closeViewer();
    toast('Photo removed');
  } catch (e) { toast(e.message); }
}

/* ------------------------------------------------------------------ comments */

async function loadComments(photoId) {
  try {
    const { comments, members } = await fn('gs-comments', { photo_id: photoId });
    if (state.photo?.id !== photoId) return;   // viewer moved on while we waited
    if (members?.length) state.members = members;
    renderComments(comments || []);
  } catch (e) {
    $('comments').innerHTML = `<div class="cmt-empty">${escapeHTML(e.message)}</div>`;
  }
}

function renderComments(list) {
  const host = $('comments');
  if (!list.length) {
    host.innerHTML = '<div class="cmt-empty">No comments yet.</div>';
    return;
  }
  host.innerHTML = '';
  list.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'cmt';

    const av = document.createElement('div');
    av.className = 'av';
    av.textContent = memberEmoji(c.device_id);
    row.appendChild(av);

    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML =
      `<span class="who">${escapeHTML(c.author_name || 'Someone')}</span>${resolveMentions(c.body)}`;
    row.appendChild(body);

    host.appendChild(row);
  });
  host.scrollTop = host.scrollHeight;
}

function memberEmoji(deviceId) {
  return state.members.find((m) => m.device_id === deviceId)?.emoji || '🙂';
}

/** Comment bodies store mentions as `@<device-id>` so a rename never breaks them.
 *  Resolve each id to whatever that person is called right now. */
function resolveMentions(body) {
  const byId = new Map(state.members.map((m) => [m.device_id, m.name]));
  return escapeHTML(body || '').replace(/@([0-9a-fA-F-]{8,64})/g, (whole, id) =>
    byId.has(id)
      ? `<span class="mention">@${escapeHTML(byId.get(id))}</span>`
      : whole);
}

async function postComment(ev) {
  ev.preventDefault();
  const input = $('cmt-input');
  const body = input.value.trim();
  const p = state.photo;
  if (!body || !p) return;

  input.value = '';
  try {
    await fn('gs-add-comment', { photo_id: p.id, body });
    p.comment_count = (p.comment_count || 0) + 1;
    loadComments(p.id);
  } catch (e) {
    input.value = body;
    toast(e.message);
  }
}

/* ------------------------------------------------------------------ sheets */

function sheet(id, on) { $(id).classList.toggle('on', on); }

function renderAlbumSheet() {
  const host = $('album-list');
  host.innerHTML = '';
  host.appendChild(albumRow({
    id: null, emoji: '📸', name: 'All photos',
    meta: `${state.events.length} album${state.events.length === 1 ? '' : 's'}`,
  }));
  state.events.forEach((e) => host.appendChild(albumRow({
    id: e.id, emoji: e.emoji || '📸', name: e.name,
    meta: [
      `${e.photo_count} photo${e.photo_count === 1 ? '' : 's'}`,
      `${e.member_count} here`,
      isLive(e) ? null : 'closed',
    ].filter(Boolean).join(' · '),
  })));
}

function albumRow({ id, emoji, name, meta }) {
  const b = document.createElement('button');
  b.className = 'row';
  b.innerHTML = `<span class="ico">${escapeHTML(emoji)}</span>
    <span class="txt"><div class="nm">${escapeHTML(name)}</div>
    <div class="mt">${escapeHTML(meta)}</div></span>
    ${state.eventId === id ? '<span class="tick">✓</span>' : ''}`;
  b.onclick = () => {
    state.eventId = id;
    if (id) localStorage.setItem('gs.selected', id);
    else localStorage.removeItem('gs.selected');
    sheet('album-sheet', false);
    openRoll();
  };
  return b;
}

function renderMeSheet() {
  $('me-name').value = me.name;
  buildEmojiGrid($('me-emoji-grid'), () => me.emoji, (e) => { me.emoji = e; });

  const host = $('me-members');
  if (!state.eventId || !state.members.length) { host.innerHTML = ''; return; }
  host.innerHTML = '<h3>In this album</h3>';
  state.members.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="ico">${escapeHTML(m.emoji || '🙂')}</span>
      <span class="txt"><div class="nm">${escapeHTML(m.name)}${
        m.device_id === me.id ? ' (you)' : ''}</div>
      <div class="mt">${m.is_host ? 'Host' : 'Guest'}</div></span>`;
    host.appendChild(row);
  });
}

/** Saving the profile re-joins every album, which is how a rename propagates —
 *  gs-join treats an existing membership as a profile refresh. */
async function saveMe() {
  const name = $('me-name').value.trim();
  if (!name) { toast('Pick a name first.'); return; }
  me.name = name;
  $('me-emoji').textContent = me.emoji;
  sheet('me-sheet', false);

  await Promise.allSettled(state.events.map((e) =>
    fn('gs-join', { event_id: e.id, name: me.name, emoji: me.emoji })));
  state.since = null;
  refresh(true);
  toast('Saved');
}

/* ------------------------------------------------------------------ helpers */

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ------------------------------------------------------------------ wiring */

function wireUp() {
  // onboarding
  $('ob-name').addEventListener('input', (e) => {
    $('ob-go').disabled = !e.target.value.trim();
  });
  $('ob-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && $('ob-name').value.trim()) $('ob-go').click();
  });
  $('ob-go').onclick = () => {
    me.name = $('ob-name').value.trim();
    afterOnboard();
  };

  // joining
  $('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    $('join-go').disabled = e.target.value.length !== 6;
  });
  $('join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });
  $('join-go').onclick = doJoin;
  $('join-back').onclick = () => { pendingCode = null; openRoll(); };

  // roll
  $('btn-add').onclick = () => $('file-input').click();
  $('file-input').onchange = (e) => {
    uploadFiles(e.target.files);
    e.target.value = '';   // same file twice in a row must still fire change
  };
  $('album-btn').onclick = () => { renderAlbumSheet(); sheet('album-sheet', true); };
  $('btn-me').onclick = () => { renderMeSheet(); sheet('me-sheet', true); };
  $('album-add').onclick = () => {
    sheet('album-sheet', false);
    $('join-code').value = '';
    $('join-go').disabled = true;
    $('join-err').textContent = '';
    updateJoinBack();
    screen('join');
    $('join-code').focus();
  };
  $('me-save').onclick = saveMe;

  // tapping the dimmed backdrop (but not the sheet itself) closes a sheet
  ['album-sheet', 'me-sheet'].forEach((id) => {
    $(id).addEventListener('click', (e) => {
      if (e.target === $(id)) sheet(id, false);
    });
  });

  // viewer
  $('v-close').onclick = closeViewer;
  $('v-like').onclick = toggleLike;
  $('v-del').onclick = deletePhoto;
  $('cmt-form').onsubmit = postComment;

  document.addEventListener('keydown', (e) => {
    if (!$('viewer').classList.contains('on')) return;
    if (document.activeElement === $('cmt-input')) return;
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });

  // horizontal swipe on the stage moves between photos
  let x0 = null, y0 = null;
  const stage = $('v-stage');
  stage.addEventListener('touchstart', (e) => {
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    x0 = y0 = null;
  }, { passive: true });

  // coming back to the tab should show what landed while you were away
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && document.body.dataset.screen === 'roll') refresh(false);
  });
}

boot();
