require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const Datastore = require('nedb-promises');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const GSQ_FRAMEWORK = require('./gsq-framework');

const app = express();
const PORT = process.env.PORT || 3000;

// Use DATA_DIR and UPLOADS_DIR env vars (set in Render), fallback to local
const DATA_DIR    = process.env.DATA_DIR    || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');

[DATA_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

console.log('DATA_DIR:', DATA_DIR);
console.log('UPLOADS_DIR:', UPLOADS_DIR);

// Databases
const db = {
  users:     Datastore.create({ filename: path.join(DATA_DIR, 'users.db'),     autoload: true }),
  locations: Datastore.create({ filename: path.join(DATA_DIR, 'locations.db'), autoload: true }),
  responses: Datastore.create({ filename: path.join(DATA_DIR, 'responses.db'), autoload: true }),
  evidence:  Datastore.create({ filename: path.join(DATA_DIR, 'evidence.db'),  autoload: true }),
  todoItems: Datastore.create({ filename: path.join(DATA_DIR, 'todo.db'),      autoload: true }),
  documents: Datastore.create({ filename: path.join(DATA_DIR, 'documents.db'), autoload: true }),
};

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'gsq-tcc-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use('/uploads', (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}, express.static(UPLOADS_DIR));

// ─── SEED ─────────────────────────────────────────────────────────────────────
async function seedDefaults() {
  const users = await db.users.find({});
  if (!users.length) {
    const adminPass = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'tcc2024admin', 10);
    await db.users.insert({ username: 'admin', password: adminPass, role: 'admin', name: 'Mary (Admin)', createdAt: new Date() });
    const dirPass = await bcrypt.hash(process.env.DIR_PASSWORD || 'director2024', 10);
    await db.users.insert({ username: 'niles',      password: dirPass, role: 'director', name: 'Niles Director',      locationId: 'niles',      createdAt: new Date() });
    await db.users.insert({ username: 'peace',      password: dirPass, role: 'director', name: 'Peace Director',      locationId: 'peace',      createdAt: new Date() });
    await db.users.insert({ username: 'montessori', password: dirPass, role: 'director', name: 'Montessori Director', locationId: 'montessori', createdAt: new Date() });
    console.log('Default users seeded');
  }
  const locs = await db.locations.find({});
  if (!locs.length) {
    await db.locations.insert([
      { _id: 'niles',      name: 'TCC Niles',            address: 'Niles, MI',      color: '#1a2744', createdAt: new Date() },
      { _id: 'peace',      name: 'TCC St. Joseph/Peace', address: 'St. Joseph, MI', color: '#2d7a4a', createdAt: new Date() },
      { _id: 'montessori', name: 'TCC Montessori',       address: 'Niles, MI',      color: '#c8973a', createdAt: new Date() },
    ]);
    console.log('Default locations seeded');
  }
}
seedDefaults();

// ─── TEXT EXTRACTION HELPERS ──────────────────────────────────────────────────
async function extractPages(filePath, mimetype, originalName) {
  let pages = [];

  try {
    if (mimetype === 'application/pdf' || originalName.match(/\.pdf$/i)) {
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      const fullText = data.text || '';
      console.log(`PDF extracted ${fullText.length} chars, ${data.numpages} pages`);

      // Try form-feed splits first
      const ffPages = fullText.split(/\f/).map(t => t.trim()).filter(t => t.length > 10);
      if (ffPages.length > 1) {
        pages = ffPages.map((text, i) => ({ page: i + 1, text }));
      } else {
        // Fall back to estimated page size
        const charsPerPage = Math.max(1500, Math.ceil(fullText.length / Math.max(data.numpages, 1)));
        for (let i = 0; i < Math.ceil(fullText.length / charsPerPage); i++) {
          const text = fullText.slice(i * charsPerPage, (i + 1) * charsPerPage).trim();
          if (text) pages.push({ page: i + 1, text });
        }
      }

    } else if (originalName.match(/\.docx?$/i)) {
      const result = await mammoth.extractRawText({ path: filePath });
      const fullText = result.value || '';
      console.log(`DOCX extracted ${fullText.length} chars`);

      // Split on any whitespace paragraph break
      const lines = fullText.split(/\n+/).map(l => l.trim()).filter(l => l.length > 0);
      const perPage = 25;
      for (let i = 0; i < Math.ceil(lines.length / perPage); i++) {
        const text = lines.slice(i * perPage, (i + 1) * perPage).join('\n');
        if (text.trim()) pages.push({ page: i + 1, text });
      }

      // Absolute fallback — chunk raw text if line splitting failed
      if (!pages.length && fullText.trim()) {
        const chunkSize = 2000;
        for (let i = 0; i < Math.ceil(fullText.length / chunkSize); i++) {
          const text = fullText.slice(i * chunkSize, (i + 1) * chunkSize).trim();
          if (text) pages.push({ page: i + 1, text });
        }
      }
    }
  } catch (err) {
    console.error('Extraction error:', err.message);
  }

  console.log(`Extracted ${pages.length} pages from ${originalName}`);
  if (pages.length > 0) console.log('First page preview:', pages[0].text.slice(0, 150));
  return pages;
}

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
function getLocationFilter(req) {
  if (req.session.role === 'admin') return req.query.locationId || req.body?.locationId || null;
  return req.session.locationId;
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.users.findOne({ username: username.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
    req.session.userId   = user._id;
    req.session.role     = user.role;
    req.session.locationId = user.locationId || null;
    res.json({ ok: true, user: { username: user.username, name: user.name, role: user.role, locationId: user.locationId || null } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, role: req.session.role, locationId: req.session.locationId });
});
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await db.users.findOne({ _id: req.session.userId });
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(400).json({ error: 'Current password incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await db.users.update({ _id: req.session.userId }, { $set: { password: hashed } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── LOCATIONS ────────────────────────────────────────────────────────────────
app.get('/api/locations', requireAuth, async (req, res) => {
  try { res.json(await db.locations.find({})); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/locations', requireAdmin, async (req, res) => {
  try {
    const { _id, name, address, color } = req.body;
    if (_id) { await db.locations.update({ _id }, { $set: { name, address, color } }); res.json({ ok: true }); }
    else { res.json(await db.locations.insert({ name, address, color: color || '#1a2744', createdAt: new Date() })); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── USERS ────────────────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, async (req, res) => {
  try { res.json((await db.users.find({})).map(u => ({ ...u, password: undefined }))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { _id, username, password, role, name, locationId } = req.body;
    if (_id) {
      const upd = { role, name, locationId };
      if (password) upd.password = await bcrypt.hash(password, 10);
      await db.users.update({ _id }, { $set: upd });
      res.json({ ok: true });
    } else {
      const existing = await db.users.findOne({ username: username.toLowerCase() });
      if (existing) return res.status(400).json({ error: 'Username taken' });
      const doc = await db.users.insert({ username: username.toLowerCase(), password: await bcrypt.hash(password, 10), role, name, locationId: locationId || null, createdAt: new Date() });
      res.json({ ...doc, password: undefined });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try { await db.users.remove({ _id: req.params.id }, {}); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FRAMEWORK ────────────────────────────────────────────────────────────────
app.get('/api/framework', requireAuth, (req, res) => res.json(GSQ_FRAMEWORK));

// ─── RESPONSES ────────────────────────────────────────────────────────────────
app.get('/api/responses/:sectionId', requireAuth, async (req, res) => {
  try {
    const locationId = getLocationFilter(req);
    const query = { sectionId: req.params.sectionId };
    if (locationId) query.locationId = locationId;
    res.json(await db.responses.find(query));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/responses', requireAuth, async (req, res) => {
  try {
    const { sectionId, itemId, narrative, policyMatches, rating, notes } = req.body;
    const locationId = req.session.role === 'admin' ? (req.body.locationId || 'admin') : req.session.locationId;
    const existing = await db.responses.findOne({ sectionId, itemId, locationId });
    if (existing) {
      await db.responses.update({ _id: existing._id }, { $set: { narrative, policyMatches, rating, notes, updatedAt: new Date() } });
      res.json({ ok: true, _id: existing._id });
    } else {
      res.json(await db.responses.insert({ sectionId, itemId, locationId, narrative, policyMatches: policyMatches || [], rating, notes, createdAt: new Date(), updatedAt: new Date() }));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── EVIDENCE ─────────────────────────────────────────────────────────────────
app.get('/api/evidence/:sectionId/:itemId', requireAuth, async (req, res) => {
  try {
    const locationId = getLocationFilter(req);
    const query = { sectionId: req.params.sectionId, itemId: req.params.itemId };
    if (locationId) query.locationId = locationId;
    res.json(await db.evidence.find(query));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/evidence/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { sectionId, itemId, label } = req.body;
    const locationId = req.session.role === 'admin' ? (req.body.locationId || 'admin') : req.session.locationId;
    res.json(await db.evidence.insert({ sectionId, itemId, locationId, label: label || req.file.originalname, filename: req.file.filename, originalName: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size, createdAt: new Date() }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/evidence/:id', requireAuth, async (req, res) => {
  try {
    const ev = await db.evidence.findOne({ _id: req.params.id });
    if (ev) { const fp = path.join(UPLOADS_DIR, ev.filename); if (fs.existsSync(fp)) fs.unlinkSync(fp); await db.evidence.remove({ _id: req.params.id }, {}); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DOCUMENTS ────────────────────────────────────────────────────────────────

// Debug: see what's actually stored (visit /api/debug/docs in browser while logged in)
app.get('/api/debug/docs', requireAuth, async (req, res) => {
  try {
    const allDocs = await db.documents.find({});
    res.json(allDocs.map(d => ({
      _id: d._id,
      docName: d.docName,
      shared: d.shared,
      locationId: d.locationId,
      pageCount: d.pageCount,
      pagesStored: (d.pages || []).length,
      firstPageChars: d.pages?.[0]?.text?.length || 0,
      firstPagePreview: d.pages?.[0]?.text?.slice(0, 300) || 'NO TEXT STORED',
      mimetype: d.mimetype,
      originalName: d.originalName,
      fileExists: fs.existsSync(path.join(UPLOADS_DIR, d.filename))
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All docs for management view
app.get('/api/documents/all', requireAuth, async (req, res) => {
  try {
    const allDocs = await db.documents.find({});
    let docs = req.session.role === 'admin'
      ? allDocs
      : allDocs.filter(d => d.shared === true || d.locationId === req.session.locationId);
    docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(docs.map(d => ({ ...d, pages: undefined })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Scoped docs for policy search
app.get('/api/documents', requireAuth, async (req, res) => {
  try {
    const locationId = getLocationFilter(req);
    const allDocs = await db.documents.find({});
    const docs = locationId
      ? allDocs.filter(d => d.shared === true || d.locationId === locationId)
      : allDocs;
    res.json(docs.map(d => ({ ...d, pages: undefined })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload a new document
app.post('/api/documents/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { docType, docName, shared } = req.body;
    const isShared  = shared === 'true';
    const locationId = isShared ? null : (req.body.locationId || (req.session.role !== 'admin' ? req.session.locationId : null));
    const filePath  = path.join(UPLOADS_DIR, req.file.filename);

    const pages = await extractPages(filePath, req.file.mimetype, req.file.originalname);

    const doc = await db.documents.insert({
      filename:     req.file.filename,
      originalName: req.file.originalname,
      docType:      docType || 'policy',
      docName:      docName || req.file.originalname.replace(/\.[^/.]+$/, ''),
      mimetype:     req.file.mimetype,
      size:         req.file.size,
      pageCount:    pages.length,
      pages,
      locationId:   isShared ? null : locationId,
      shared:       isShared,
      createdAt:    new Date()
    });

    res.json({ _id: doc._id, docName: doc.docName, docType: doc.docType, pageCount: doc.pageCount, shared: doc.shared });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Re-index existing document (re-extract text without re-uploading)
app.post('/api/documents/:id/reindex', requireAuth, async (req, res) => {
  try {
    const doc = await db.documents.findOne({ _id: req.params.id });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const filePath = path.join(UPLOADS_DIR, doc.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Original file missing from disk — please delete and re-upload' });
    const pages = await extractPages(filePath, doc.mimetype, doc.originalName);
    await db.documents.update({ _id: req.params.id }, { $set: { pages, pageCount: pages.length } });
    res.json({ ok: true, pageCount: pages.length, preview: pages[0]?.text?.slice(0, 200) || 'empty' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/documents/:id', requireAuth, async (req, res) => {
  try {
    const doc = await db.documents.findOne({ _id: req.params.id });
    if (doc) {
      if (doc.shared && req.session.role !== 'admin') return res.status(403).json({ error: 'Only admins can delete shared documents' });
      const fp = path.join(UPLOADS_DIR, doc.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      await db.documents.remove({ _id: req.params.id }, {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AI POLICY SEARCH ─────────────────────────────────────────────────────────
app.post('/api/ai/search-policies', requireAuth, async (req, res) => {
  try {
    const { itemText, criteria, checklistItems, searchQuery, docIds } = req.body;
    const locationId = getLocationFilter(req);

    // Fetch all docs then filter in JS (avoids NeDB null-field matching quirks)
    const allDocs = await db.documents.find({});
    let docs;
    if (docIds && docIds.length) {
      docs = allDocs.filter(d => docIds.includes(d._id));
    } else if (locationId) {
      // Include docs for this location AND all shared docs
      docs = allDocs.filter(d => d.shared === true || d.locationId === locationId);
    } else {
      // Admin with no location selected — search ALL documents
      docs = allDocs;
    }

    console.log(`Policy search: locationId="${locationId}", ${docs.length}/${allDocs.length} docs in scope`);
    docs.forEach(d => console.log(` - "${d.docName}" shared=${d.shared} loc=${d.locationId} pages=${(d.pages||[]).length}`));

    if (!docs.length) {
      return res.json({ matches: [], message: `No documents found. Total in system: ${allDocs.length}. Check the Documents tab.` });
    }

    const docsWithPages = docs.filter(d => (d.pages || []).length > 0);
    if (!docsWithPages.length) {
      return res.json({ matches: [], message: `${docs.length} document(s) found but none have indexed text yet. Click the 🔄 Re-index button on each document in the Documents tab, then try again.` });
    }

    // Build keyword list (include short words — GSQ uses "oral", "play", "home", "care")
    const allText = [itemText, criteria, searchQuery, ...(checklistItems || [])].filter(Boolean).join(' ');
    const stopWords = new Set(['the','and','for','are','that','this','with','have','from','they','will','been','their','what','when','your','which','into','more','also','each','does','show','must','least','one','two','all','how','its','per','not','but','may']);
    const keywords = [...new Set(
      allText.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w))
    )];

    console.log('Search keywords:', keywords.slice(0, 20).join(', '));

    // Score every page
    let pagePool = [];
    docsWithPages.forEach(doc => {
      (doc.pages || []).forEach(p => {
        if (!p.text || p.text.trim().length < 10) return;
        const lower = p.text.toLowerCase();
        const hits = keywords.filter(k => lower.includes(k)).length;
        pagePool.push({ docName: doc.docName, docType: doc.docType, page: p.page, text: p.text, hits });
      });
    });

    console.log(`Page pool: ${pagePool.length} pages total, ${pagePool.filter(p=>p.hits>0).length} with keyword hits`);

    // Sort by relevance; always send top 25 even if score is 0
    pagePool.sort((a, b) => b.hits - a.hits);
    const topPages = pagePool.slice(0, 25);

    const contextText = topPages.map(p =>
      `[Document: "${p.docName}" | Type: ${p.docType} | Page ${p.page} | Keyword hits: ${p.hits}]\n${p.text.slice(0, 1200)}`
    ).join('\n\n---\n\n');

    const prompt = `You are a Michigan Great Start to Quality (GSQ) QRIS compliance expert helping a childcare director complete their self-reflection for a 5-star rating.

INDICATOR BEING EVALUATED:
${itemText}

WHAT EVALUATORS ARE LOOKING FOR:
${checklistItems ? checklistItems.map((c, i) => `${i + 1}. ${c}`).join('\n') : criteria || 'General compliance evidence'}

${searchQuery ? `DIRECTOR'S SEARCH QUERY: "${searchQuery}"` : ''}

IMPORTANT INSTRUCTIONS:
- Search broadly and generously. A policy RELATED to this indicator counts even if it does not use the exact same words.
- A "Parent Communication Policy" is evidence for sharing developmental progress with families.
- A "Daily Schedule" section counts for an indicator about daily routines.
- A staff handbook section on illness/absence counts for personnel policies.
- Look for ANY section heading, paragraph, bullet point, or statement that addresses the topic.
- Be GENEROUS in matching. It is better to suggest something that gets dismissed than to miss valid evidence.

DOCUMENT PAGES TO SEARCH:
${contextText}

Find ALL passages that could serve as policy citations or evidence for this GSQ indicator.

Respond ONLY with a valid JSON array (no markdown, no preamble):
[
  {
    "docName": "exact document name from above",
    "docType": "staff_handbook|family_handbook|policy|other",
    "page": <page number as integer>,
    "excerpt": "<copy 2-4 sentences directly from the document text above>",
    "relevance": "<one sentence: which checklist item this satisfies and why>"
  }
]

If truly nothing is relevant, return: []`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] })
    });

    const data = await response.json();
    if (data.error) { console.error('Anthropic error:', data.error); return res.status(500).json({ error: data.error.message }); }

    let text = (data.content?.[0]?.text || '[]').replace(/```json|```/g, '').trim();
    const arrMatch = text.match(/\[[\s\S]*\]/);
    let matches = [];
    try { matches = JSON.parse(arrMatch ? arrMatch[0] : text); } catch { matches = []; }
    console.log(`AI returned ${matches.length} matches`);

    res.json({ matches });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─── EVIDENCE TRACKER (physical evidence & to-do list) ───────────────────────

// Get all tracker items for a location
app.get('/api/tracker', requireAuth, async (req, res) => {
  try {
    const locationId = getLocationFilter(req);
    const allItems = await db.todoItems.find({});
    const items = locationId
      ? allItems.filter(i => i.locationId === locationId)
      : allItems;
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add/update a tracker item (todo or uploaded)
app.post('/api/tracker', requireAuth, async (req, res) => {
  try {
    const { itemId, sectionId, evidenceLabel, status, notes } = req.body;
    const locationId = req.session.role === 'admin'
      ? (req.body.locationId || currentLocId || 'admin')
      : req.session.locationId;
    const existing = await db.todoItems.findOne({ itemId, sectionId, evidenceLabel, locationId });
    if (existing) {
      await db.todoItems.update({ _id: existing._id }, { $set: { status, notes, updatedAt: new Date() } });
      res.json({ ok: true, _id: existing._id });
    } else {
      const doc = await db.todoItems.insert({ itemId, sectionId, evidenceLabel, locationId, status, notes: notes || '', createdAt: new Date(), updatedAt: new Date() });
      res.json(doc);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload physical evidence file and attach to tracker item
app.post('/api/tracker/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { itemId, sectionId, evidenceLabel, notes } = req.body;
    const locationId = req.session.role === 'admin'
      ? (req.body.locationId || 'admin')
      : req.session.locationId;
    const doc = await db.todoItems.insert({
      itemId, sectionId, evidenceLabel, locationId,
      status: 'uploaded',
      notes: notes || '',
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a tracker item
app.delete('/api/tracker/:id', requireAuth, async (req, res) => {
  try {
    const item = await db.todoItems.findOne({ _id: req.params.id });
    if (item && item.filename) {
      const fp = path.join(UPLOADS_DIR, item.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await db.todoItems.remove({ _id: req.params.id }, {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PROGRESS ─────────────────────────────────────────────────────────────────
app.get('/api/progress', requireAuth, async (req, res) => {
  try {
    const locationId = getLocationFilter(req);
    const allResponses = await db.responses.find({});
    const responses = locationId ? allResponses.filter(r => r.locationId === locationId) : allResponses;
    const result = GSQ_FRAMEWORK.map(section => ({
      id: section.id, name: section.name,
      totalItems: section.items.length,
      completed: responses.filter(r => r.sectionId === section.id && r.narrative?.trim()).length,
      policyCount: responses.filter(r => r.sectionId === section.id && (r.policyMatches || []).some(m => m.status === 'accepted')).length
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── STATIC ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`GSQ Self-Reflection Tool running on port ${PORT}`));
