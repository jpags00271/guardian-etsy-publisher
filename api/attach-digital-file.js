const { attachDigitalFile } = require('../lib/pipeline');

// GET /api/attach-digital-file?folderId=<driveFolderId>&key=<shared secret>
// One-off patch tool: attaches manifest.json's recorded digitalFileId to an
// EXISTING listing (manifest.listingId) without touching anything else -
// images, order, price, tags, listing state all stay exactly as they are.
// Built for the case where a listing was already published without a
// deliverable file (manifest.digitalFileId was missing at publish time) and
// the file has since been generated and recorded in manifest.json.
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
    const result = await attachDigitalFile(folderId);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err), stack: err.stack });
  }
};

