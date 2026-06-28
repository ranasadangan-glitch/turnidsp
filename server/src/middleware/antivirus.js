// (9) Virus scanning hook. If a ClamAV daemon is configured (CLAMAV_HOST), files
// are scanned before being accepted. Without it, scanning is a no-op pass-through
// (documented as a residual risk). This keeps the integration point ready.
async function scanFile(fullPath) {
  if (!process.env.CLAMAV_HOST) return { clean: true, scanned: false };
  try {
    const NodeClam = require('clamscan'); // optional dependency
    const clam = await new NodeClam().init({
      clamdscan: { host: process.env.CLAMAV_HOST, port: +(process.env.CLAMAV_PORT || 3310) },
    });
    const { isInfected } = await clam.isInfected(fullPath);
    return { clean: !isInfected, scanned: true };
  } catch (e) {
    console.error('antivirus scan error (failing closed):', e.message);
    return { clean: false, scanned: false }; // fail closed when AV is configured but errors
  }
}
module.exports = { scanFile };
