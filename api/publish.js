const { publishDesign } = require('../lib/pipeline');

// GET /api/publish?folderId=<driveFolderId>&key=<shared secret>
// Triggered by Claude via WebFetch after Steps 1-5 finish and a manifest.json is
// written into the design's Drive folder. Idempotent: safe to call twice on the
// same folder (publishDesign no-ops if manifest.status is already "published").
module.exports = async (req, res) => {
  if (req.query.key !== process.env.PUBLISH_TRIGGER_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const { folderId } = req.query;
  if (!folderId) {
    res.status(400).json({ error: 'folderId query param required' });
    return;
  }
  try {
    const result = await publishDesign(folderId);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({
      error: String(err.message || err),
      stack: err.stack,
      log: err.partialLog,
      listingId: err.partialListingId,
    });
  }
};
