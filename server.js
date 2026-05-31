const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const puppeteer = require('puppeteer');
const archiver  = require('archiver');

const app  = express();
const PORT = process.env.PORT || 3000;
const HTML = path.join(__dirname, 'Journey Map v2.html');
const SUBMISSIONS = path.join(__dirname, 'submissions');

/* ── middleware ─────────────────────────────────────────────── */
app.use(express.json({ limit: '20mb' }));

/* Serve the journey map at the root URL */
app.get('/', (_req, res) => res.sendFile(HTML));

/* Serve any other static assets from this folder */
app.use(express.static(__dirname));

/* ── ensure submissions directory exists ────────────────────── */
if (!fs.existsSync(SUBMISSIONS)) fs.mkdirSync(SUBMISSIONS, { recursive: true });

/* ── POST /api/submit ────────────────────────────────────────── */
app.post('/api/submit', async (req, res) => {
  const state = req.body;
  if (!state || typeof state !== 'object' || !Array.isArray(state.steps)) {
    return res.status(400).json({ ok: false, error: 'Invalid payload — expected journey map state object.' });
  }

  /* Build a safe directory name: date_participantID_timestamp */
  const pid       = String(state.pid || 'anonymous').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) || 'anonymous';
  const datestamp = new Date().toISOString().slice(0, 10);
  const dirName   = `${datestamp}_${pid}_${Date.now()}`;
  const subDir    = path.join(SUBMISSIONS, dirName);

  try {
    fs.mkdirSync(subDir, { recursive: true });

    /* 1 ── Save JSON immediately so data is never lost */
    fs.writeFileSync(
      path.join(subDir, 'data.json'),
      JSON.stringify({ capturedAt: state.capturedAt || new Date().toISOString(), ...state }, null, 2),
      'utf8'
    );
    console.log(`[submit] JSON saved → ${dirName}/data.json`);

    /* 2 ── Respond immediately so the UI updates right away */
    res.json({ ok: true, id: dirName });

    /* 3 ── Generate PDF in the background (don't block the response) */
    generatePdf(state, subDir, dirName).catch(err => {
      console.error('[submit] PDF generation failed:', err.message);
    });

  } catch (err) {
    console.error('[submit] Error saving submission:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function generatePdf(state, subDir, dirName) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();

    /* Inject the participant's state into localStorage before page scripts run */
    await page.evaluateOnNewDocument((key, val) => {
      localStorage.setItem(key, val);
    }, 'wjm.v2.state', JSON.stringify(state));

    /* Load the page through the server so Google Fonts and all assets resolve */
    await page.goto(`http://localhost:${PORT}/`, {
      waitUntil: 'networkidle0',
      timeout: 30_000,
    });

    /* Ensure the curve and stage detail pages are rendered before PDF capture */
    await page.evaluate(() => {
      if (typeof renderCurve === 'function')          renderCurve();
      if (typeof buildPrintStagePages === 'function') buildPrintStagePages();
    });

    /* One extra animation frame so everything paints */
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));

    await page.pdf({
      path: path.join(subDir, 'map.pdf'),
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
    });

    console.log(`[submit] PDF saved  → ${dirName}/map.pdf`);
  } finally {
    await browser.close();
  }
}

/* ── GET /api/admin/download ─────────────────────────────────── */
/* Download all submissions as a ZIP. Requires ?key=<ADMIN_KEY>  */
app.get('/api/admin/download', (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).send('Unauthorized');
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="submissions.zip"');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => {
    console.error('[download] archive error:', err);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);
  archive.directory(SUBMISSIONS, false);
  archive.finalize();
});

/* ── start ───────────────────────────────────────────────────── */
const server = app.listen(PORT, () => {
  console.log(`\nJourney Map server ready`);
  console.log(`  Port        : ${PORT}`);
  console.log(`  Submissions : ${SUBMISSIONS}\n`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error(`Stop the other server first, or set a different port: PORT=3001 npm start\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
