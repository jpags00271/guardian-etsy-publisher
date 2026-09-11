// Etsy Open API v3 helper. Credentials via env vars. Refresh token ROTATES on every
// use (Etsy behavior) — caller is responsible for persisting the new one (see
// api/publish.js, which writes it back to a Drive-hosted token store so it survives
// across invocations without redeploying).

const ETSY_BASE = 'https://api.etsy.com/v3/application';
const ASPECT_RATIO_PROPERTY_ID = 570246213622;

function apiKeyHeader() {
  // Standing format: "keystring:shared_secret", colon-joined.
  return `${process.env.ETSY_API_KEY}:${process.env.ETSY_SHARED_SECRET}`;
}

async function refreshEtsyToken(currentRefreshToken) {
  const res = await fetch('https://api.etsy.com/v3/public/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ETSY_API_KEY,
      refresh_token: currentRefreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Etsy token refresh failed: ${res.status} ${await res.text()}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

async function createDraftListing(accessToken, shopId, listing) {
  const res = await fetch(`${ETSY_BASE}/shops/${shopId}/listings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-api-key': apiKeyHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      quantity: 999,
      title: listing.title,
      description: listing.description,
      price: listing.price,
      who_made: 'i_did',
      when_made: '2020_2026',
      taxonomy_id: 77,
      type: 'download',
      tags: listing.tags,
      state: 'draft',
      is_digital: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Etsy create listing failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function setAspectRatio(accessToken, shopId, listingId) {
  const res = await fetch(
    `${ETSY_BASE}/shops/${shopId}/listings/${listingId}/properties/${ASPECT_RATIO_PROPERTY_ID}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-api-key': apiKeyHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ value_ids: '5178', values: '1:1' }),
    }
  );
  if (!res.ok) {
    throw new Error(`Etsy set aspect ratio failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function uploadImage(accessToken, shopId, listingId, imageBuffer, rank, filename) {
  const form = new FormData();
  form.append('image', new Blob([imageBuffer]), filename);
  form.append('rank', String(rank));
  const res = await fetch(`${ETSY_BASE}/shops/${shopId}/listings/${listingId}/images`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-api-key': apiKeyHeader(),
    },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Etsy image upload failed (rank ${rank}): ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function uploadDigitalFile(accessToken, shopId, listingId, fileBuffer, filename) {
  const form = new FormData();
  form.append('file', new Blob([fileBuffer]), filename);
  form.append('name', filename);
  const res = await fetch(`${ETSY_BASE}/shops/${shopId}/listings/${listingId}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-api-key': apiKeyHeader(),
    },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Etsy digital file upload failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function getListing(accessToken, listingId) {
  const res = await fetch(`${ETSY_BASE}/listings/${listingId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-api-key': apiKeyHeader(),
    },
  });
  if (!res.ok) {
    throw new Error(`Etsy get listing failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function getListingImages(accessToken, shopId, listingId) {
  const res = await fetch(`${ETSY_BASE}/shops/${shopId}/listings/${listingId}/images`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-api-key': apiKeyHeader(),
    },
  });
  if (!res.ok) {
    throw new Error(`Etsy get images failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

module.exports = {
  refreshEtsyToken,
  createDraftListing,
  setAspectRatio,
  uploadImage,
  uploadDigitalFile,
  getListing,
  getListingImages,
};
