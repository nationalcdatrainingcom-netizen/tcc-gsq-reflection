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

// Ensure directories exist
const BASE_DIR = process.env.DISK_PATH || __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const UPLOADS_DIR = path.join(BASE_DIR, 'uploads');
[DATA_DIR, UPLOADS_DIR, path.join(__dirname, 'public')].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Databases
const db = {
  users:     Datastore.create({ filename: path.join(DATA_DIR, 'users.db'),     autoload: true }),
  locations: Datastore.create({ filename: path.join(DATA_DIR, 'locations.db'), autoload: true }),
  responses: Datastore.create({ filename: path.join(DATA_DIR, 'responses.db'), autoload: true }),
  evidence:  Datastore.create({ filename: path.join(DATA_DIR, 'evidence.db'),  autoload: true }),
  documents: Datastore.create({ filename: path.join(DATA_DIR, 'documents.db'), autoload: true }),
};

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'gsq-tcc-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));
app.use('/uploads', (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}, express.static(UPLOADS_DIR));

// Seed default users and locations
async function seedDefaults() {
  const users = await db.users.find({});
  if (!users.length) {
    const adminPass = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'tcc2024admin', 10);
    await db.users.insert({ username: 'admin', password: adminPass, role: 'admin', name: 'Mary (Admin)', createdAt: new Date() });
    // Director accounts
    const dirPass = await bcrypt.hash(process.env.DIR_PASSWORD || 'director2024', 10);
    await db.users.insert({ username: 'niles', password: dirPass, role: 'director', name: 'Niles Director', locationId: 'niles', createdAt: new Date() });
    await db.users.insert({ username: 'peace', password: dirPass, role: 'director', name: 'Peace Director', locationId: 'peace', createdAt: new Date() });
    await db.users.insert({ username: 'montessori', password: dirPass, role: 'director', name: 'Montessori Director', locationId: 'montessori', createdAt: new Date() });
    console.log('Default users seeded. Admin password:', process.env.ADMIN_PASSWORD || 'tcc2024admin');
  }
  const locs = await db.locations.find({});
  if (!locs.length) {
    await db.locations.insert([
      { _id: 'niles',      name: 'TCC Niles',      address: 'Niles, MI',         color: '#1a2744', createdAt: new Date() },
      { _id: 'peace',      name: 'TCC St. Joseph/Peace', address: 'St. Joseph, MI', color: '#2d7a4a', createdAt: new Date() },
      { _id: 'montessori', name: 'TCC Montessori', address: 'Niles, MI',         color: '#c8973a', createdAt: new Date() },
    ]);
    console.log('Default locations seeded.');
  }
}
seedDefaults();

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ─── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.users.findOne({ username: username.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
    req.session.userId = user._id;
    req.session.role = user.role;
    req.session.locationId = user.locationId || null;
    res.json({ ok: true, user: { username: user.username, name: user.name, role: user.role, locationId: user.locationId || null } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

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

// ─── LOCATIONS ─────────────────────────────────────────────────────────────────
app.get('/api/locations', requireAuth, async (req, res) => {
  try {
    const locs = await db.locations.find({});
    res.json(locs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/locations', requireAdmin, async (req, res) => {
  try {
    const { _id, name, address, color } = req.body;
    if (_id) {
      await db.locations.update({ _id }, { $set: { name, address, color } });
      res.json({ ok: true });
    } else {
      const doc = await db.locations.insert({ name, address, color: color || '#1a2744', createdAt: new Date() });
      res.json(doc);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── USERS (admin) ─────────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await db.users.find({});
    res.json(users.map(u => ({ ...u, password: undefined })));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      const hashed = await bcrypt.hash(password, 10);
      const doc = await db.users.insert({ username: username.toLowerCase(), password: hashed, role, name, locationId: locationId || null, createdAt: new Date() });
      res.json({ ...doc, password: undefined });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    await db.users.remove({ _id: req.params.id }, {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FRAMEWORK ─────────────────────────────────────────────────────────────────
app.get('/api/framework', requireAuth, (req, res) => {
  res.json(GSQ_FRAMEWORK);
});

// ─── RESPONSES ─────────────────────────────────────────────────────────────────
function getLocationFilter(req) {
  // Admins can pass ?locationId=xxx, directors are locked to their location
  if (req.session.role === 'admin') return req.query.locationId || req.body?.locationId || null;
  return req.session.locationId;
}

app.get('/api/responses/:sectionId', requireAuth, async (req, res) => {
  try {
    const locationId = getLocationFilter(req);
    const query = { sectionId: req.params.sectionId };
    if (locationId) query.locationId = locationId;
    const responses = await db.responses.find(query);
    res.json(responses);
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
      const doc = await db.responses.insert({ sectionId, itemId, locationId, narrative, policyMatches: policyMatches || [], rating, notes, createdAt: new Date(), updatedAt: new Date() });
      res.json(doc);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── EVIDENCE ──────────────────────────────────────────────────────────────────
app.get('/api/evidence/:sectionId/:itemId', requireAuth, async (req, res) => {
  try {
    const locationId = getLocationFilter(req);
    const query = { sectionId: req.params.sectionId, itemId: req.params.itemId };
    if (locationId) query.locationId = locationId;
    const evidence = await db.evidence.find(query);
    res.json(evidence);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/evidence/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { sectionId, itemId, label } = req.body;
    const locationId = req.session.role === 'admin' ? (req.body.locationId || 'admin') : req.session.locationId;
    const doc = await db.evidence.insert({
      sectionId, itemId, locationId, label: label || req.file.originalname,
      filename: req.file.filename, originalName: req.file.originalname,
      mimetype: req.file.mimetype, size: req.file.size, createdAt: new Date()
    });
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/evidence/:id', requireAuth, async (req, res) => {
  try {
    const ev = await db.evidence.findOne({ _id: req.params.id });
    if (ev) {
      const fp = path.join(UPLOADS_DIR, ev.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      await db.evidence.remove({ _id: req.params.id }, {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DOCUMENTS ─────────────────────────────────────────────────────────────────

// All documents for management view (admin sees all; directors see their location + shared)
app.get('/api/documents/all', requireAuth, async (req, res) => {
  try {
    let docs;
    if (req.session.role === 'admin') {
      docs = await db.documents.find({});
    } else {
      const locId = req.session.locationId;
      docs = await db.documents.find(locId ? { $or: [{ locationId: locId }, { shared: true }] } : { shared: true });
    }
    docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(docs.map(d => ({ ...d, pages: undefined })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Scoped documents: used for policy AI search (location-specific + shared)
app.get('/api/documents', requireAuth, async (req, res) => {
  try {
    const locationId = getLocationFilter(req);
    const query = locationId ? { $or: [{ locationId }, { shared: true }] } : {};
    const docs = await db.documents.find(query);
    res.json(docs.map(d => ({ ...d, pages: undefined })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/documents/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { docType, docName, shared } = req.body;
    const isShared = shared === 'true';
    const locationId = isShared ? null : (req.body.locationId || (req.session.role !== 'admin' ? req.session.locationId : null));

    const filePath = path.join(UPLOADS_DIR, req.file.filename);
    let pages = [];

    if (req.file.mimetype === 'application/pdf') {
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      const rawPages = data.text.split(/\f/);
      pages = rawPages.map((text, i) => ({ page: i + 1, text: text.trim() })).filter(p => p.text);
      if (pages.length === 1 && data.numpages > 1) {
        const charsPerPage = Math.ceil(data.text.length / data.numpages);
        pages = [];
        for (let i = 0; i < data.numpages; i++) {
          pages.push({ page: i + 1, text: data.text.slice(i * charsPerPage, (i + 1) * charsPerPage).trim() });
        }
      }
    } else if (req.file.originalname.match(/\.docx?$/i)) {
      const result = await mammoth.extractRawText({ path: filePath });
      const lines = result.value.split('\n\n').filter(l => l.trim());
      const perPage = 40;
      for (let i = 0; i < Math.ceil(lines.length / perPage); i++) {
        pages.push({ page: i + 1, text: lines.slice(i * perPage, (i + 1) * perPage).join('\n\n') });
      }
    }

    const doc = await db.documents.insert({
      filename: req.file.filename, originalName: req.file.originalname,
      docType: docType || 'policy',
      docName: docName || req.file.originalname.replace(/\.[^/.]+$/, ''),
      mimetype: req.file.mimetype, size: req.file.size,
      pageCount: pages.length, pages,
      locationId: isShared ? null : locationId,
      shared: isShared,
      createdAt: new Date()
    });

    res.json({ _id: doc._id, docName: doc.docName, docType: doc.docType, pageCount: doc.pageCount, shared: doc.shared });
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

// ─── AI POLICY SEARCH ──────────────────────────────────────────────────────────
app.post('/api/ai/search-policies', requireAuth, async (req, res) => {
  try {
    const { itemText, criteria, checklistItems, searchQuery, docIds } = req.body;
    const locationId = getLocationFilter(req);

    const query = docIds && docIds.length
      ? { _id: { $in: docIds } }
      : locationId
        ? { $or: [{ locationId }, { shared: true }] }
        : {};

    const docs = await db.documents.find(query);
    if (!docs.length) return res.json({ matches: [], message: 'No documents uploaded yet. Please upload your handbooks and policies first.' });

    // Build rich keyword list — include short words (GSQ uses "oral", "play", "home", "care")
    const allText = [itemText, criteria, searchQuery, ...(checklistItems || [])].filter(Boolean).join(' ');
    const stopWords = new Set(['the','and','for','are','that','this','with','have','from','they','will','been','their','what','when','your','which','into','more','also','each','does','show','must','least','one','two','all','how','its','per','not','but','may']);
    const keywords = [...new Set(
      allText.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !stopWords.has(w))
    )];

    // Score every page across all documents
    let pagePool = [];
    docs.forEach(doc => {
      (doc.pages || []).forEach(p => {
        if (!p.text || p.text.trim().length < 20) return;
        const lower = p.text.toLowerCase();
        const hits = keywords.filter(k => lower.includes(k)).length;
        pagePool.push({ docId: doc._id, docName: doc.docName, docType: doc.docType, page: p.page, text: p.text, hits });
      });
    });

    // Sort by score; always send top 25 pages regardless of score so AI sees something
    pagePool.sort((a, b) => b.hits - a.hits);
    const topPages = pagePool.slice(0, 25);

    // More text per page (1200 chars) gives AI enough context to find relevant passages
    const contextText = topPages.map(p =>
      `[Document: "${p.docName}" | Type: ${p.docType} | Page ${p.page} | Keyword hits: ${p.hits}]\n${p.text.slice(0, 1200)}`
    ).join('\n\n---\n\n');

    const prompt = `You are a Michigan Great Start to Quality (GSQ) QRIS compliance expert helping a childcare director complete their self-reflection for a 5-star rating.

INDICATOR BEING EVALUATED:
${itemText}

WHAT EVALUATORS ARE LOOKING FOR:
${checklistItems ? checklistItems.map((c, i) => `${i + 1}. ${c}`).join('\n') : criteria || 'General compliance evidence'}

${searchQuery ? `DIRECTOR\'S SEARCH QUERY: "${searchQuery}"` : ''}

IMPORTANT INSTRUCTIONS:
- Search broadly and generously. A policy that is RELATED to this indicator counts even if it does not use the exact same words.
- A "Parent Communication Policy" is evidence for sharing developmental progress with families.
- A "Daily Schedule" section counts for an indicator about daily routines.
- A staff handbook section on illness/absence counts for personnel policies.
- Look for ANY section heading, paragraph, bullet point, or statement that addresses the topic.
- Be GENEROUS in matching. It is better to suggest something that gets dismissed than to miss valid evidence.
- If document text appears cut off, still include it if the beginning is relevant.

DOCUMENT PAGES TO SEARCH:
${contextText}

Find ALL passages that could serve as policy citations or evidence for this GSQ indicator.

Respond ONLY with a valid JSON array (no markdown, no preamble, no explanation outside the JSON):
[
  {
    "docName": "exact document name from the pages above",
    "docType": "staff_handbook|family_handbook|policy|other",
    "page": <page number as integer>,
    "excerpt": "<copy 2-4 sentences directly from the document text above>",
    "relevance": "<one sentence: which checklist item this satisfies and why>"
  }
]

If truly nothing is relevant at all, return: []`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    let text = (data.content?.[0]?.text || '[]').replace(/```json|```/g, '').trim();
    // Sometimes the model wraps in extra text — extract just the JSON array
    const arrMatch = text.match(/\[[\s\S]*\]/);
    let matches = [];
    try { matches = JSON.parse(arrMatch ? arrMatch[0] : text); } catch { matches = []; }

    res.json({ matches });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─── PROGRESS ──────────────────────────────────────────────────────────────────
app.get('/api/progress', requireAuth, async (req, res) => {
  try {
    const locationId = getLocationFilter(req);
    const query = {};
    if (locationId) query.locationId = locationId;
    const responses = await db.responses.find(query);

    const result = GSQ_FRAMEWORK.map(section => {
      const totalItems = section.items.length;
      const completed = responses.filter(r =>
        r.sectionId === section.id && r.narrative && r.narrative.trim()
      ).length;
      const policyCount = responses.filter(r =>
        r.sectionId === section.id && (r.policyMatches || []).some(m => m.status === 'accepted')
      ).length;
      return { id: section.id, name: section.name, totalItems, completed, policyCount };
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── STATIC + CATCH-ALL ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`GSQ Self-Reflection Tool running on port ${PORT}`));
