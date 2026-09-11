const drive = require('./drive');
const etsy = require('./etsy');

const TOKEN_STORE_FOLDER_ID =
  process.env.ETSY_TOKEN_STORE_FOLDER_ID || process.env.ETSY_LISTINGS_ROOT_FOLDER_ID;
const TOKEN_STORE_FILENAME = 'etsy_tokens.json';
const SHOP_ID = process.env.ETSY_SHOP_ID;

async function getCurrentRefreshToken(driveToken) {
  const stored = await drive.readJsonFileByName(
    TOKEN_STORE_FOLDER_ID,
    TOKEN_STORE_FILENAME,
    driveToken
  );
  if (stored && stored.refresh_token) return stored.refresh_token;
  // First-ever run: seed from env var.
  return process.env.ETSY_REFRESH_TOKEN_SEED;
}

async function persistRefreshToken(driveToken, newRefreshToken) {
  const existing = await drive.listFolderChildren(TOKEN_STORE_FOLDER_ID, driveToken);
  const existingFile = existing.find((f) => f.name === TOKEN_STORE_FILENAME);
  await drive.writeJsonFile(
    TOKEN_STORE_FOLDER_ID,
    TOKEN_STORE_FILENAME,
    { refresh_token: newRefreshToken, updated_at: new Date().toISOString() },
    driveToken,
    existingFile ? existingFile.id : undefined
  );
}

async function updateManifest(driveToken, folderId, manifestFileId, manifest) {
  await drive.writeJsonFile(folderId, 'manifest.json', manifest, driveToken, manifestFileId);
}

async function publishDesign(folderId) {
  const log = [];
  const step = (msg) => {
    log.push(`[${new Date().toISOString()}] ${msg}`);
  };

  const driveToken = await drive.getDriveAccessToken();
  step('Drive token acquired');

  const children = await drive.listFolderChildren(folderId, driveToken);
  const manifestFile = children.find((f) => f.name === 'manifest.json');
  if (!manifestFile) {
    throw new Error(`No manifest.json found in folder ${folderId}`);
  }
  const manifestBuf = await drive.downloadFile(manifestFile.id, driveToken);
  const manifest = JSON.parse(manifestBuf.toString('utf-8'));
  step(`Manifest loaded for "${manifest.designName}", status=${manifest.status}`);

  if (manifest.status === 'published') {
    return { skipped: true, reason: 'already published', listingId: manifest.listingId, log };
  }

  const currentRefreshToken = await getCurrentRefreshToken(driveToken);
  if (!currentRefreshToken) {
    throw new Error('No Etsy refresh token available (token store empty and no seed set)');
  }
  const tokenResp = await etsy.refreshEtsyToken(currentRefreshToken);
  step('Etsy access token refreshed');
  // Persist the rotated refresh token IMMEDIATELY — Etsy invalidates the old one,
  // so losing this write bricks the next run even if everything else below fails.
  await persistRefreshToken(driveToken, tokenResp.refresh_token);
  step('New Etsy refresh_token persisted to Drive token store');

  const accessToken = tokenResp.access_token;

  const listing = await etsy.createDraftListing(accessToken, SHOP_ID, manifest);
  step(`Draft listing created: ${listing.listing_id}`);

  await etsy.setAspectRatio(accessToken, SHOP_ID, listing.listing_id);
  step('Aspect ratio (1:1) set');

  // Sequential uploads of 13 multi-MB images (some 30-45MB) were timing out on a
  // single request. Run with limited concurrency instead — fast enough to finish
  // well inside maxDuration, without slamming Etsy's 10 QPS rate limit or this
  // function's memory with all 13 buffers in memory at once.
  const sortedImages = [...manifest.images].sort((a, b) => a.rank - b.rank);
  const CONCURRENCY = 3;
  let cursor = 0;
  async function worker() {
    while (cursor < sortedImages.length) {
      const img = sortedImages[cursor++];
      const buf = await drive.downloadFile(img.fileId, driveToken);
      await etsy.uploadImage(accessToken, SHOP_ID, listing.listing_id, buf, img.rank, img.filename);
      step(`Uploaded image rank ${img.rank}: ${img.filename} (${buf.length} bytes)`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (manifest.digitalFileId) {
    const pdfBuf = await drive.downloadFile(manifest.digitalFileId, driveToken);
    await etsy.uploadDigitalFile(
      accessToken,
      SHOP_ID,
      listing.listing_id,
      pdfBuf,
      manifest.digitalFileName || 'delivery.pdf'
    );
    step(`Uploaded digital file (${pdfBuf.length} bytes)`);
  }

  // Verify real state, never trust the create response alone.
  const finalListing = await etsy.getListing(accessToken, listing.listing_id);
  const finalImages = await etsy.getListingImages(accessToken, SHOP_ID, listing.listing_id);
  step(
    `Verified: state=${finalListing.state}, image_count=${finalImages.count ?? (finalImages.results || []).length}`
  );

  if (finalListing.state !== 'draft') {
    throw new Error(
      `SAFETY CHECK FAILED: listing ${listing.listing_id} state is "${finalListing.state}", expected "draft". DO NOT PUBLISH BEYOND DRAFT is a hard rule — investigate before touching this listing.`
    );
  }

  manifest.status = 'published';
  manifest.listingId = listing.listing_id;
  manifest.publishedAt = new Date().toISOString();
  manifest.needsAiDisclosure = true; // Claude/Claude-in-Chrome still has to do this step
  await updateManifest(driveToken, folderId, manifestFile.id, manifest);
  step('Manifest updated: status=published');

  return {
    success: true,
    listingId: listing.listing_id,
    state: finalListing.state,
    imageCount: finalImages.count ?? (finalImages.results || []).length,
    log,
  };
}

async function scanQueue(queueRootFolderId) {
  const driveToken = await drive.getDriveAccessToken();
  const folders = (await drive.listFolderChildren(queueRootFolderId, driveToken)).filter(
    (f) => f.mimeType === 'application/vnd.google-apps.folder'
  );
  const results = [];
  for (const folder of folders) {
    try {
      const children = await drive.listFolderChildren(folder.id, driveToken);
      const manifestFile = children.find((f) => f.name === 'manifest.json');
      if (!manifestFile) continue;
      const manifestBuf = await drive.downloadFile(manifestFile.id, driveToken);
      const manifest = JSON.parse(manifestBuf.toString('utf-8'));
      if (manifest.status !== 'pending') continue;
      const result = await publishDesign(folder.id);
      results.push({ folder: folder.name, ...result });
    } catch (err) {
      results.push({ folder: folder.name, success: false, error: String(err.message || err) });
    }
  }
  return results;
}

module.exports = { publishDesign, scanQueue };
