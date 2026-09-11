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
  // Track the listing_id the moment it's created so a failure anywhere after
  // that point can still tell the caller which real Etsy draft resulted -
  // otherwise a mid-run failure leaves an orphaned draft with no record of
  // its ID anywhere in the error response.
  let createdListingId;

  try {
    return await publishDesignInner(folderId, log, step, (id) => {
      createdListingId = id;
    });
  } catch (err) {
    err.partialLog = log;
    if (createdListingId) err.partialListingId = createdListingId;
    throw err;
  }
}

async function publishDesignInner(folderId, log, step, onListingCreated) {
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

  // Duplicate-run guard: without this, calling /api/publish more than once on
  // the same folder before a run finishes (a slow request that gets reloaded,
  // opened in a second tab, retried by a flaky connection, etc.) creates a
  // brand-new Etsy draft listing every single time - manifest.status only ever
  // flips to "published" at the very end, so nothing earlier stopped a second
  // run from starting. This is what produced 6 duplicate listings in one night.
  // Fix: the instant a run creates a listing, it locks the folder by writing
  // status="publishing" (+ which listing it made) back to manifest.json before
  // doing anything else. Any other run that sees that lock refuses outright
  // instead of silently creating another listing.
  if (manifest.status === 'publishing') {
    throw new Error(
      `Refusing to start a duplicate publish: manifest.json already shows status="publishing" ` +
        `(started ${manifest.publishingStartedAt || 'unknown time'}, listingId so far: ${
          manifest.listingId || 'none yet'
        }). This means an earlier run is still in flight, or crashed without finishing. If you're ` +
        `sure the earlier run is dead, manually reset manifest.json's status back to "pending" ` +
        `(and clean up/delete any partial draft listing it created) before retrying.`
    );
  }

  // Never create a listing with nothing a customer can actually buy - Step 4
  // (generating the delivery PDF and recording its Drive file ID here) must be
  // done first. Tonight's incident: this manifest had no digitalFileId, so the
  // old code silently skipped the file upload and published a listing with no
  // deliverable at all.
  if (!manifest.digitalFileId) {
    throw new Error(
      `Refusing to publish "${manifest.designName}": manifest.json has no digitalFileId set, ` +
        `meaning there is no delivery file for a customer to download. Finish Step 4 (generate ` +
        `the delivery PDF and record its Drive file ID in manifest.json) before publishing.`
    );
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

  // Set the duplicate-run lock BEFORE creating anything on Etsy - if another
  // invocation is racing this one, it needs to see "publishing" as early as
  // possible, not after the listing already exists.
  manifest.status = 'publishing';
  manifest.publishingStartedAt = new Date().toISOString();
  await updateManifest(driveToken, folderId, manifestFile.id, manifest);
  step('Manifest locked: status=publishing (duplicate-run guard)');

  const listing = await etsy.createDraftListing(accessToken, SHOP_ID, manifest);
  onListingCreated(listing.listing_id);
  manifest.listingId = listing.listing_id;
  await updateManifest(driveToken, folderId, manifestFile.id, manifest);
  step(`Draft listing created: ${listing.listing_id}`);

  await etsy.setAspectRatio(accessToken, SHOP_ID, listing.listing_id);
  step('Aspect ratio (1:1) set');

  // Images MUST reach Etsy strictly one at a time, in ascending final-rank
  // order. Confirmed tonight: uploading with concurrency > 1 lets images land
  // on Etsy in whatever order the network happens to finish them, not rank
  // order, which scrambled the listing's photo order (Etsy's own API has
  // known reports of this - e.g. github.com/etsy/open-api/discussions/1227,
  // "ListingImages ... in an inconsistent order"). Always appending the next
  // higher rank while every lower rank is already in place is correct no
  // matter the exact internal semantics of Etsy's rank field - there's no
  // interpretation of "rank" under which strictly-in-order appends produce
  // the wrong sequence.
  //
  // To avoid re-introducing the original timeout problem (fully sequential
  // download-then-upload was too slow for maxDuration), Drive downloads are
  // pipelined one step ahead of the Etsy upload: while image N is uploading to
  // Etsy, image N+1 is already downloading from Drive in the background. At
  // most 2 image buffers (each up to ~45MB) are ever held in memory at once -
  // same memory discipline as before, just reordered.
  const sortedImages = [...manifest.images].sort((a, b) => a.rank - b.rank);
  let nextDownload = drive.downloadFile(sortedImages[0].fileId, driveToken);
  for (let i = 0; i < sortedImages.length; i++) {
    const img = sortedImages[i];
    const buf = await nextDownload;
    if (i + 1 < sortedImages.length) {
      nextDownload = drive.downloadFile(sortedImages[i + 1].fileId, driveToken);
    }
    await etsy.uploadImage(accessToken, SHOP_ID, listing.listing_id, buf, img.rank, img.filename);
    step(`Uploaded image rank ${img.rank}: ${img.filename} (${buf.length} bytes)`);
  }

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
