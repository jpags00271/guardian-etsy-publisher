const { scanQueue } = require('../lib/pipeline');

// Vercel Cron target (see vercel.json) — runs independently of Claude entirely,
// on Vercel's own schedule. Fallback safety net: if the WebFetch trigger from
// Claude ever fails to fire, any design sitting in the Etsy Listings root with
// a manifest.json still marked "pending" gets picked up and published here
// within the cron interval, with zero human or Claude involvement.
module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const results = await scanQueue(process.env.ETSY_LISTINGS_ROOT_FOLDER_ID);
    res.status(200).json({ scanned: results.length, results });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
};
