import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const cloud = process.env.CLOUDINARY_CLOUD_NAME;
const key = process.env.CLOUDINARY_API_KEY;
const secret = process.env.CLOUDINARY_API_SECRET;

if (!cloud || !key || !secret) {
  console.error('Missing Cloudinary env vars');
  process.exit(1);
}

const auth = Buffer.from(`${key}:${secret}`).toString('base64');

async function cloudinary(path, options = {}) {
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}${path}`, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Cloudinary ${res.status}: ${text}`);
  }
  return data;
}

async function listShortRequests() {
  // Prefer tag listing; fallback to SHORTS/ folder prefix
  try {
    const url = new URL(`https://api.cloudinary.com/v1_1/${cloud}/resources/image/tags/short-req`);
    url.searchParams.set('max_results', '50');
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data.resources) ? data.resources : [];
    }
  } catch (_) {}

  const url = new URL(`https://api.cloudinary.com/v1_1/${cloud}/resources/image/upload`);
  url.searchParams.set('prefix', 'SHORTS/');
  url.searchParams.set('max_results', '50');
  url.searchParams.set('context', 'true');
  url.searchParams.set('tags', 'true');
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`List SHORTS failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const resources = Array.isArray(data.resources) ? data.resources : [];
  return resources.filter((r) => Array.isArray(r.tags) && r.tags.includes('short-req'));
}

async function destroyImage(publicId) {
  const body = new URLSearchParams({ public_id: publicId });
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/destroy`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Destroy failed: ${res.status} ${text}`);
  }
}

async function shortenExternal(targetUrl) {
  const providers = [
    async () => {
      const res = await fetch(
        'https://tinyurl.com/api-create.php?url=' + encodeURIComponent(targetUrl)
      );
      const text = (await res.text()).trim();
      if (res.ok && /^https?:\/\/tinyurl\.com\/\S+$/i.test(text)) return text;
      throw new Error('tinyurl failed');
    },
    async () => {
      const body = new URLSearchParams({ url: targetUrl });
      const res = await fetch('https://cleanuri.com/api/v1/shorten', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      const data = await res.json();
      if (data?.result_url && !/github/i.test(data.result_url)) return data.result_url;
      throw new Error('cleanuri failed');
    },
    async () => {
      const res = await fetch(
        'https://is.gd/create.php?format=simple&url=' + encodeURIComponent(targetUrl)
      );
      const text = (await res.text()).trim();
      if (res.ok && /^https?:\/\/is\.gd\/\S+$/i.test(text)) return text;
      throw new Error('is.gd failed');
    }
  ];

  let lastErr;
  for (const run of providers) {
    try {
      return await run();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All shorten providers failed');
}

function readShorts() {
  if (!existsSync('shorts.json')) {
    return { updatedAt: null, results: {} };
  }
  try {
    return JSON.parse(readFileSync('shorts.json', 'utf8'));
  } catch {
    return { updatedAt: null, results: {} };
  }
}

function getContext(resource) {
  return resource.context?.custom || resource.context || {};
}

const shorts = readShorts();
let changed = false;
const resources = await listShortRequests();
console.log(`Found ${resources.length} short requests`);

for (const resource of resources) {
  const ctx = getContext(resource);
  const rid = ctx.short_rid ? decodeURIComponent(String(ctx.short_rid)) : '';
  const target = ctx.short_target ? decodeURIComponent(String(ctx.short_target)) : '';
  if (!rid || !target) {
    console.log('Skip resource without rid/target', resource.public_id);
    continue;
  }

  try {
    const shortUrl = await shortenExternal(target);
    shorts.results[rid] = {
      shortUrl,
      url: target,
      createdAt: new Date().toISOString()
    };
    changed = true;
    console.log(`Shortened ${rid} -> ${shortUrl}`);
  } catch (err) {
    console.error(`Failed ${rid}:`, err.message || err);
    continue;
  }

  try {
    await destroyImage(resource.public_id);
  } catch (err) {
    console.error('Destroy failed', resource.public_id, err.message || err);
  }
}

// prune old results (keep 200)
const entries = Object.entries(shorts.results || {}).sort((a, b) => {
  return new Date(b[1].createdAt || 0) - new Date(a[1].createdAt || 0);
});
shorts.results = Object.fromEntries(entries.slice(0, 200));
shorts.updatedAt = new Date().toISOString();

if (changed || !existsSync('shorts.json')) {
  writeFileSync('shorts.json', JSON.stringify(shorts, null, 2) + '\n', 'utf8');
  console.log('Wrote shorts.json');
} else {
  console.log('No short updates');
}
