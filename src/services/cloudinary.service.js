const {
  v2: cloudinary
} = require('cloudinary');

const {
  env
} = require('../config/env.js');

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  if (!env.cloudinary.cloudName || !env.cloudinary.apiKey || !env.cloudinary.apiSecret) {
    return false;
  }
  cloudinary.config({
    cloud_name: env.cloudinary.cloudName,
    api_key: env.cloudinary.apiKey,
    api_secret: env.cloudinary.apiSecret,
    secure: true,
  });
  configured = true;
  return true;
}

async function uploadBuffer(buffer, { folderParts, publicId, resourceType = 'auto' } = {}) {
  if (!ensureConfigured()) {
    throw Object.assign(new Error('Cloudinary is not configured (set CLOUDINARY_* in .env)'), {
      status: 503,
      publicCode: 'uploads_unavailable',
    });
  }

  const folder = ['xclusive-oman', env.nodeEnv, ...(folderParts || [])].join('/');

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, resource_type: resourceType },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });
}

module.exports.uploadBuffer = uploadBuffer;

async function deleteAsset(publicId, { resourceType = 'image', invalidate = false } = {}) {
  if (!ensureConfigured()) return;
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate });
}

module.exports.deleteAsset = deleteAsset;

// Public ID of an asset in THIS account, from its delivery URL
// (https://res.cloudinary.com/<cloud>/image/upload/v123/<public_id>.<ext>);
// null for anything else (other hosts/accounts, malformed URLs).
function publicIdFromUrl(url) {
  if (!url || !env.cloudinary.cloudName) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'res.cloudinary.com') return null;
  const prefix = `/${env.cloudinary.cloudName}/image/upload/`;
  if (!parsed.pathname.startsWith(prefix)) return null;
  const rest = decodeURIComponent(parsed.pathname.slice(prefix.length))
    .replace(/^v\d+\//, '') // version segment
    .replace(/\.[a-z0-9]+$/i, ''); // file extension
  return rest || null;
}

module.exports.publicIdFromUrl = publicIdFromUrl;

/**
 * Permanently deletes the images behind these URLs from Cloudinary and purges
 * them from the CDN cache (invalidate) so the old links stop serving them.
 * Skips empty/duplicate/foreign URLs. "not found" counts as deleted. Throws
 * if Cloudinary refuses, so callers can keep their DB row and let the user
 * retry.
 */
async function deleteImagesByUrl(urls) {
  if (!ensureConfigured()) {
    throw Object.assign(new Error('Cloudinary is not configured (set CLOUDINARY_* in .env)'), {
      status: 503,
      publicCode: 'uploads_unavailable',
    });
  }
  const ids = [...new Set((urls || []).map(publicIdFromUrl).filter(Boolean))];
  for (const id of ids) {
    let result;
    try {
      result = await cloudinary.uploader.destroy(id, { resource_type: 'image', invalidate: true });
    } catch (err) {
      result = { result: err?.message || 'request failed' };
    }
    if (result?.result !== 'ok' && result?.result !== 'not found') {
      // Details in the server log; the agent gets a plain retry message.
      console.error(`[cloudinary] could not delete ${id}: ${result?.result || 'unknown error'}`);
      throw Object.assign(new Error('The image could not be deleted from storage. Nothing was removed — please try again.'), {
        status: 502,
        publicCode: 'delete_failed',
      });
    }
  }
  return ids.length;
}

module.exports.deleteImagesByUrl = deleteImagesByUrl;

// Deletes one uploaded document — an image asset (photos, image visas) or a
// raw file (PDF visas are stored raw: many Cloudinary accounts refuse to
// deliver PDFs uploaded as images). Raw public IDs keep their extension.
// Same "throws unless ok / not found" contract as deleteImagesByUrl.
async function deleteDocumentByUrl(url) {
  if (!url || !env.cloudinary.cloudName) return 0;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 0;
  }
  const rawPrefix = `/${env.cloudinary.cloudName}/raw/upload/`;
  if (parsed.hostname !== 'res.cloudinary.com' || !parsed.pathname.startsWith(rawPrefix)) {
    return deleteImagesByUrl([url]);
  }
  if (!ensureConfigured()) return 0;
  const id = decodeURIComponent(parsed.pathname.slice(rawPrefix.length)).replace(/^v\d+\//, '');
  const result = await cloudinary.uploader.destroy(id, { resource_type: 'raw', invalidate: true }).catch((err) => ({
    result: err?.message || 'request failed',
  }));
  if (result?.result !== 'ok' && result?.result !== 'not found') {
    console.error(`[cloudinary] could not delete raw ${id}: ${result?.result || 'unknown error'}`);
    throw Object.assign(new Error('The file could not be deleted from storage. Please try again.'), {
      status: 502,
      publicCode: 'delete_failed',
    });
  }
  return 1;
}

module.exports.deleteDocumentByUrl = deleteDocumentByUrl;
