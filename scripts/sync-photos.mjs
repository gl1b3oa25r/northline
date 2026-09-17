import { writeFileSync } from 'node:fs';

const cloud = process.env.CLOUDINARY_CLOUD_NAME;
const key = process.env.CLOUDINARY_API_KEY;
const secret = process.env.CLOUDINARY_API_SECRET;

if (!cloud || !key || !secret) {
  console.error('Missing Cloudinary env vars');
  process.exit(1);
}

const auth = Buffer.from(`${key}:${secret}`).toString('base64');

async function fetchPage(nextCursor) {
  const url = new URL(`https://api.cloudinary.com/v1_1/${cloud}/resources/image/upload`);
  url.searchParams.set('prefix', 'IMAGE/');
  url.searchParams.set('max_results', '500');
  url.searchParams.set('context', 'true');
  url.searchParams.set('tags', 'true');
  if (nextCursor) url.searchParams.set('next_cursor', nextCursor);

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloudinary ${res.status}: ${text}`);
  }
  return res.json();
}

function mapResource(resource) {
  const ctx = resource.context?.custom || {};
  const ua = ctx.user_agent ? decodeURIComponent(String(ctx.user_agent)) : '';
  const statusRaw = ctx.status ? decodeURIComponent(String(ctx.status)) : '';
  const videoPlayed = ctx.video_played
    ? decodeURIComponent(String(ctx.video_played))
    : statusRaw;
  const latitude = ctx.latitude != null ? Number(ctx.latitude) : null;
  const longitude = ctx.longitude != null ? Number(ctx.longitude) : null;
  const photoUrl = resource.secure_url || resource.url || '';
  const hasPhoto = Boolean(photoUrl);
  const hasGps = latitude != null && longitude != null && !Number.isNaN(latitude);
  let status = statusRaw;
  if (!status) {
    if (hasPhoto && hasGps) status = 'Both';
    else if (hasPhoto) status = 'Selfie only';
    else if (hasGps) status = 'GPS only';
    else status = 'Unknown';
  }

  return {
    id: resource.asset_id || resource.public_id,
    photoUrl,
    publicId: resource.public_id || '',
    uploadedAt: resource.created_at || new Date().toISOString(),
    userAgent: ua,
    latitude,
    longitude,
    status,
    videoPlayed: videoPlayed || status,
    source: 'cloudinary'
  };
}

const all = [];
let cursor;
do {
  const data = await fetchPage(cursor);
  const resources = Array.isArray(data.resources) ? data.resources : [];
  all.push(...resources.map(mapResource));
  cursor = data.next_cursor;
} while (cursor);

all.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

const payload = {
  updatedAt: new Date().toISOString(),
  count: all.length,
  records: all.slice(0, 1000)
};

writeFileSync('photos.json', JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`Wrote ${payload.count} records`);
