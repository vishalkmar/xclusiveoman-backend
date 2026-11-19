// Puppeteer install-time config (read by `npm install` from the project root).
//
// On Linux servers (cPanel, Render) PDFs are rendered with @sparticuz/chromium
// (see src/services/itineraryPdf.service.js), so Puppeteer's own ~170MB Chrome
// download is never used there — and on shared hosting that download is what
// fails (disk quota / timeout), leaving `puppeteer` uninstalled. Skip it on
// Linux; Windows/macOS dev machines still download it, since @sparticuz's
// binary is Linux-only and local PDFs use Puppeteer's bundled Chrome.
module.exports = {
  skipDownload: process.platform === 'linux',
};
