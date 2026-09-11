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

// Etsy serializes writes per-listing: it locks a listing while one write is in
// flight and rejects any other concurrent write to the SAME listing_id with a
// 409 ("The Listing with listing_id ... is being edited by another process.").
// pipeline.js intentionally uploads images with concurrency > 1 for speed (fully
// sequential uploads were timing out the function), so collisions between our
// own concurrent workers are expected, not exceptional — retry with backoff
// instead of failing the whole publish on what is a transient, self-inflicted
// conflict.
const LISTING_LOCK_RETRIES = 6;
const LISTING_LOCK_BASE_DELAY_MS = 700;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isListingLockConflict(res) {
  if (res.status !== 409) return false;
  try {
    const body = await res.clone().text();
    return /being edited by another process/i.test(body);
  } catch {
    return true; // a 409 on a listing-write endpoint is almost certainly this
  }
}

// Runs one HTTP attempt via `makeRequest`, retrying with backoff if Etsy
// responds with the listing-lock 409 above, up to LISTING_LOCK_RETRIES times.
// `formatError` builds the thrown error's message from the final failing
// response, preserving each call site's existing error text.
async function fetchWithListingLockRetry(makeRequest, formatError) {
  for (let attempt = 0; ; attempt++) {
    const res = await makeRequest();
    if (res.ok) return res.json();
    if (attempt < LISTING_LOCK_RETRIES && (await isListingLockConflict(res))) {
      const delay = LISTING_LOCK_BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      await sleep(delay);
      continue;
    }
    throw new Error(await formatError(res));
  }
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
  return fetchWithListingLockRetry(
    () =>
      fetch(`${ETSY_BASE}/shops/${shopId}/listings/${listingId}/properties/${ASPECT_RATIO_PROPERTY_ID}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'x-api-key': apiKeyHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ value_ids: '5178', values: '1:1' }),
      }),
    async (res) => `Etsy set aspect ratio failed: ${res.status} ${await res.text()}`
  );
}

async function uploadImage(accessToken, shopId, listingId, imageBuffer, rank, filename) {
  return fetchWithListingLockRetry(
    () => {
      const form = new FormData();
      form.append('image', new Blob([imageBuffer]), filename);
      form.append('rank', String(rank));
      return fetch(`${ETSY_BASE}/shops/${shopId}/listings/${listingId}/images`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'x-api-key': apiKeyHeader(),
        },
        body: form,
      });
    },
    async (res) => `Etsy image upload failed (rank ${rank}): ${res.status} ${await res.text()}`
  );
}

async function uploadDigitalFile(accessToken, shopId, listingId, fileBuffer, filename) {
  return fetchWithListingLockRetry(
    () => {
      const form = new FormData();
      form.append('file', new Blob([fileBuffer]), filename);
      form.append('name', filename);
      return fetch(`${ETSY_BASE}/shops/${shopId}/listings/${listingId}/files`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'x-api-key': apiKeyHeader(),
        },
        body: form,
      });
    },
    async (res) => `Etsy digital file upload failed: ${res.status} ${await res.text()}`
  );
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
