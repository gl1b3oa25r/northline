(function () {
  'use strict';

  const STORAGE_KEY = 'northline-upload-records';
  const DELETED_KEY = 'northline-deleted-ids';
  const params = new URLSearchParams(window.location.search);
  const recordId = params.get('id');
  const authCfg = window.IMAGE_PANEL_AUTH || {};

  function readRecords() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const records = raw ? JSON.parse(raw) : [];
      return Array.isArray(records) ? records : [];
    } catch {
      return [];
    }
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

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

  function markDeleted(record) {
    try {
      const raw = localStorage.getItem(DELETED_KEY);
      const ids = raw ? JSON.parse(raw) : [];
      const list = Array.isArray(ids) ? ids.map(String) : [];
      [record.id, record.publicId, record.photoUrl].filter(Boolean).forEach((k) => {
        const key = String(k);
        if (!list.includes(key)) list.push(key);
      });
      localStorage.setItem(DELETED_KEY, JSON.stringify(list.slice(0, 2000)));

      const records = readRecords().filter((r) => {
        const keys = [r.id, r.publicId, r.photoUrl].filter(Boolean).map(String);
        const del = new Set(list);
        return !keys.some((x) => del.has(x));
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    } catch {
      /* ignore */
    }
  }

  async function deleteFromCloudinary(record) {
    if (!record.deleteToken || !authCfg.cloudName) return false;
    const url = `https://api.cloudinary.com/v1_1/${authCfg.cloudName}/delete_by_token`;
    const body = new URLSearchParams({ token: record.deleteToken });
    const res = await fetch(url, { method: 'POST', body });
    return res.ok;
  }

  function renderNotFound() {
    document.getElementById('notFound').hidden = false;
    document.getElementById('content').hidden = true;
  }

  function renderRecord(record) {
    const status = getStatus(record);
    const videoPlayed = record.videoPlayed || status;
    const gpsOk = hasGps(record);

    document.getElementById('content').hidden = false;
    document.getElementById('notFound').hidden = true;
    document.getElementById('recordMeta').textContent = formatDate(record.uploadedAt);
    document.getElementById('photo').src = record.photoUrl || '';

    document.getElementById('statusValue').innerHTML =
      `<span class="status-badge ${statusClass(status)}">${escapeHtml(status)}</span>`;
    document.getElementById('videoValue').textContent = videoPlayed;

    document.getElementById('gpsValue').textContent = gpsOk
      ? `${Number(record.latitude).toFixed(6)}, ${Number(record.longitude).toFixed(6)}`
      : 'GPS not available';

    const mapValue = document.getElementById('mapValue');
    const openMapBtn = document.getElementById('openMapBtn');
    const openPhotoBtn = document.getElementById('openPhotoBtn');

    openPhotoBtn.href = record.photoUrl || '#';
    if (!record.photoUrl) openPhotoBtn.setAttribute('aria-disabled', 'true');

    if (gpsOk) {
      const mapUrl = `https://www.google.com/maps?q=${encodeURIComponent(record.latitude)},${encodeURIComponent(record.longitude)}`;
      mapValue.innerHTML = `<a href="${mapUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(`${record.latitude}, ${record.longitude}`)}</a>`;
      openMapBtn.hidden = false;
      openMapBtn.href = mapUrl;
    } else {
      mapValue.textContent = 'Map link not available';
      openMapBtn.hidden = true;
    }

    document.getElementById('uaValue').textContent = record.userAgent || 'Unknown';

    const deleteBtn = document.getElementById('deleteBtn');
    deleteBtn.onclick = async () => {
      if (!window.confirm('Delete this capture from the panel?')) return;
      deleteBtn.disabled = true;
      try {
        await deleteFromCloudinary(record);
      } catch {
        /* ignore */
      }
      markDeleted(record);
      window.location.href = 'panel.html';
    };
  }

  const record = readRecords().find((item) => String(item.id) === String(recordId));
  if (!record) renderNotFound();
  else renderRecord(record);
})();
