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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
[DATA_DIR, UPLOADS_DIR, path.join(__dirname, 'public')].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

console.log('DATA_DIR:', DATA_DIR);
console.log('UPLOADS_DIR:', UPLOADS_DIR);

// Databases
const db = {
  users:       Datastore.create({ filename: path.join(DATA_DIR, 'users.db'),       autoload: true }),
  locations:   Datastore.create({ filename: path.join(DATA_DIR, 'locations.db'),   autoload: true }),
  responses:   Datastore.create({ filename: path.join(DATA_DIR, 'responses.db'),   autoload: true }),
  evidence:    Datastore.create({ filename: path.join(DATA_DIR, 'evidence.db'),    autoload: true }),
  documents:   Datastore.create({ filename: path.join(DATA_DIR, 'documents.db'),   autoload: true }),
  todoItems:   Datastore.create({ filename: path.join(DATA_DIR, 'todoItems.db'),   autoload: true }),
  assignments: Datastore.create({ filename: path.join(DATA_DIR, 'assignments.db'), autoload: true }),
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
      { _id: 'peace',      name: 'TCC St. Joseph/Peace', address: 'St. Joseph, MI', color: '#253561', createdAt: new Date() },
      { _id: 'montessori', name: 'TCC Montessori',       address: 'SW Michigan',    color: '#3d5080', createdAt: new Date() }
    ]);
    console.log('Default locations seeded');
  }
}
seedDefaults();

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}
function requireAdmin(req, res, next) {
  if (req.session.userId && req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log('Login attempt:', username, '| password length:', password?.length);
    const user = await db.users.findOne({ username: username.toLowerCase() });
    if (!user) { console.log('Login fail: user not found'); return res.status(401).json({ error: 'Invalid credentials' }); }
    const valid = await bcrypt.compare(password, user.password);
    console.log('Login bcrypt result:', valid, '| hash length:', user.password?.length);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    req.session.userId = user._id;
    req.session.role = user.role;
    req.session.locationId = user.locationId || null;
    res.json({ user: { _id: user._id, username: user.username, name: user.name, role: user.role, locationId: user.locationId } });
  } catch (e) { console.error('Login error:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, role: req.session.role, locationId: req.session.locationId, userId: req.session.userId });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await db.users.findOne({ _id: req.session.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await db.users.update({ _id: user._id }, { $set: { password: hashed } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── LOCATIONS & USERS ────────────────────────────────────────────────────────
app.get('/api/locations', requireAuth, async (req, res) => {
  res.json(await db.locations.find({}));
});

app.get('/api/users', requireAdmin, async (req, res) => {
  const users = await db.users.find({});
  res.json(users.map(u => ({ ...u, password: undefined })));
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { _id, username, password, role, name, locationId } = req.body;
    if (_id) {
      const update = { name, role, locationId: locationId || null };
      if (password) update.password = await bcrypt.hash(password, 10);
      await db.users.update({ _id }, { $set: update });
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

app.get('/api/documents', requireAuth, async (req, res) => {
  try {
    const locationId = getLocationFilter(req);
    const query = locationId ? { $or: [{ locationId }, { shared: true }] } : {};
    const docs = await db.documents.find(query);
    res.json(docs.map(d => ({ ...d, pages: undefined })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/docs', requireAuth, async (req, res) => {
  try {
    const allDocs = await db.documents.find({});
    res.json(allDocs.map(d => ({
      _id: d._id, docName: d.docName, shared: d.shared, locationId: d.locationId,
      pageCount: d.pageCount, pagesStored: (d.pages || []).length,
      firstPageChars: d.pages?.[0]?.text?.length || 0,
      firstPagePreview: d.pages?.[0]?.text?.substring(0, 200) || '(empty)'
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/documents/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { docName, docType } = req.body;
    const shared = req.body.shared === 'true';
    const locationId = shared ? null : (req.body.locationId || null);
    const filePath = path.join(UPLOADS_DIR, req.file.filename);

    let pages = [];
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext === '.pdf') {
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      const rawPages = data.text.split(/\f/);
      pages = rawPages.map((text, i) => ({ page: i + 1, text: text.trim().substring(0, 1200) })).filter(p => p.text.length > 10);
    } else if (ext === '.docx' || ext === '.doc') {
      const buffer = fs.readFileSync(filePath);
      const result = await mammoth.extractRawText({ buffer });
      const chunks = result.value.match(/.{1,1200}/gs) || [];
      pages = chunks.map((text, i) => ({ page: i + 1, text: text.trim() })).filter(p => p.text.length > 10);
    }

    const doc = await db.documents.insert({
      docName: docName || req.file.originalname, docType, shared, locationId,
      filename: req.file.filename, originalName: req.file.originalname,
      mimetype: req.file.mimetype, size: req.file.size,
      pageCount: pages.length, pages, createdAt: new Date()
    });
    res.json({ ...doc, pages: undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/documents/:id/reindex', requireAuth, async (req, res) => {
  try {
    const doc = await db.documents.findOne({ _id: req.params.id });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const filePath = path.join(UPLOADS_DIR, doc.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from disk' });

    let pages = [];
    const ext = path.extname(doc.originalName || doc.filename).toLowerCase();
    if (ext === '.pdf') {
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      const rawPages = data.text.split(/\f/);
      pages = rawPages.map((text, i) => ({ page: i + 1, text: text.trim().substring(0, 1200) })).filter(p => p.text.length > 10);
    } else if (ext === '.docx' || ext === '.doc') {
      const buffer = fs.readFileSync(filePath);
      const result = await mammoth.extractRawText({ buffer });
      const chunks = result.value.match(/.{1,1200}/gs) || [];
      pages = chunks.map((text, i) => ({ page: i + 1, text: text.trim() })).filter(p => p.text.length > 10);
    }

    await db.documents.update({ _id: doc._id }, { $set: { pages, pageCount: pages.length } });
    res.json({ ok: true, pageCount: pages.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/documents/:id', requireAuth, async (req, res) => {
  try {
    const doc = await db.documents.findOne({ _id: req.params.id });
    if (doc) {
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
    const { itemText, criteria, checklistItems, searchQuery } = req.body;
    const locationId = req.session.role === 'admin'
      ? (req.body.locationId || null)
      : req.session.locationId;

    const docQuery = locationId ? { $or: [{ locationId }, { shared: true }] } : {};
    const docs = await db.documents.find(docQuery);
    if (!docs.length) return res.json({ message: 'No documents uploaded yet. Go to Documents tab to upload your handbooks and policies first.' });

    const searchTerms = searchQuery
      ? searchQuery.toLowerCase().split(/\s+/)
      : (itemText + ' ' + (criteria || '')).toLowerCase()
          .split(/\s+/)
          .filter(w => w.length >= 3 && !['the','and','for','are','that','this','with','has','have','from','they','been','were','was','not','but','all','can','had','her','one','our','out','you','its','his','she','who','how','may','did','get','than','let','too','use'].includes(w));

    const scored = [];
    docs.forEach(doc => {
      (doc.pages || []).forEach(page => {
        const lower = page.text.toLowerCase();
        const hits = searchTerms.filter(t => lower.includes(t)).length;
        if (hits > 0) scored.push({ doc, page, hits });
      });
    });
    scored.sort((a, b) => b.hits - a.hits);
    const top = scored.slice(0, 25);

    if (!top.length) return res.json({ message: 'No relevant content found in your documents for this indicator. Try uploading more handbooks or policy documents.' });

    const contextBlock = top.map(s =>
      `[${s.doc.docName} | ${s.doc.docType} | Page ${s.page.page}]\n${s.page.text}`
    ).join('\n---\n');

    const prompt = `You are helping a childcare program find policy evidence for a Great Start to Quality self-reflection.

INDICATOR: ${itemText}

CRITERIA/CHECKLIST:
${(checklistItems || []).join('\n')}

SEARCH DOCUMENTS:
${contextBlock}

Find ALL passages that relate to this indicator — match BROADLY and GENEROUSLY. A parent communication policy counts for family engagement. A daily schedule counts for routine indicators. Staff meeting notes count for professional development.

Return a JSON array of matches. Each match:
{"docName":"exact doc name","docType":"exact doc type","page":number,"excerpt":"exact quote from document (2-4 sentences)","relevance":"why this is relevant"}

Return [] if truly nothing relates. ONLY return the JSON array, nothing else.`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
    });
    const apiData = await apiRes.json();
    let text = apiData.content?.[0]?.text || '[]';
    text = text.replace(/```json|```/g, '').trim();
    let matches = [];
    try { matches = JSON.parse(text); } catch { matches = []; }

    res.json({ matches });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TRACKER (Physical Evidence) ──────────────────────────────────────────────
app.get('/api/tracker', requireAuth, async (req, res) => {
  try {
    const locationId = req.query.locationId || (req.session.role !== 'admin' ? req.session.locationId : null);
    const allItems = await db.todoItems.find({});
    const items = locationId
      ? allItems.filter(i => i.locationId === locationId)
      : allItems;
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tracker', requireAuth, async (req, res) => {
  try {
    const { itemId, sectionId, evidenceLabel, status, notes } = req.body;
    const locationId = req.session.role === 'admin'
      ? (req.body.locationId || 'admin')
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

app.post('/api/tracker/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { itemId, sectionId, evidenceLabel, notes } = req.body;
    const locationId = req.session.role === 'admin'
      ? (req.body.locationId || 'admin')
      : req.session.locationId;

    // Check if this completes an assignment
    const assignment = await db.assignments.findOne({ itemId, sectionId, evidenceLabel, locationId, status: { $ne: 'completed' } });

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

    // Auto-complete the assignment if one exists
    if (assignment) {
      await db.assignments.update({ _id: assignment._id }, { $set: {
        status: 'completed',
        completedAt: new Date(),
        uploadedFilename: req.file.filename,
        uploadedOriginalName: req.file.originalname
      }});
    }

    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// ─── ASSIGNMENTS (Director Delegation) ────────────────────────────────────────

// Admin: create or update an assignment
app.post('/api/assignments', requireAdmin, async (req, res) => {
  try {
    const { itemId, sectionId, evidenceLabel, locationId, assignedTo, notes, priority } = req.body;
    // assignedTo = userId of the director
    const existing = await db.assignments.findOne({ itemId, sectionId, evidenceLabel, locationId });
    if (existing) {
      await db.assignments.update({ _id: existing._id }, { $set: {
        assignedTo, notes: notes || existing.notes, priority: priority || existing.priority, updatedAt: new Date()
      }});
      res.json({ ok: true, _id: existing._id });
    } else {
      const doc = await db.assignments.insert({
        itemId, sectionId, evidenceLabel, locationId,
        assignedTo,
        assignedBy: req.session.userId,
        status: 'pending',
        notes: notes || '',
        priority: priority || 'normal',
        createdAt: new Date(),
        updatedAt: new Date()
      });
      res.json(doc);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: bulk assign multiple items at once
app.post('/api/assignments/bulk', requireAdmin, async (req, res) => {
  try {
    const { items, assignedTo, locationId, notes, priority } = req.body;
    // items = array of { itemId, sectionId, evidenceLabel }
    const results = [];
    for (const item of items) {
      const existing = await db.assignments.findOne({
        itemId: item.itemId, sectionId: item.sectionId,
        evidenceLabel: item.evidenceLabel, locationId
      });
      if (existing) {
        await db.assignments.update({ _id: existing._id }, { $set: {
          assignedTo, notes: notes || '', priority: priority || 'normal', updatedAt: new Date()
        }});
        results.push({ ...existing, assignedTo });
      } else {
        const doc = await db.assignments.insert({
          itemId: item.itemId, sectionId: item.sectionId,
          evidenceLabel: item.evidenceLabel, locationId,
          assignedTo, assignedBy: req.session.userId,
          status: 'pending', notes: notes || '',
          priority: priority || 'normal',
          createdAt: new Date(), updatedAt: new Date()
        });
        results.push(doc);
      }
    }
    res.json({ ok: true, count: results.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get assignments — admin sees all (optionally filtered), directors see only theirs
app.get('/api/assignments', requireAuth, async (req, res) => {
  try {
    let query = {};
    if (req.session.role === 'admin') {
      if (req.query.locationId) query.locationId = req.query.locationId;
    } else {
      // Directors see assignments assigned to them
      query.assignedTo = req.session.userId;
    }
    const assignments = await db.assignments.find(query);
    // Enrich with assignee name
    const users = await db.users.find({});
    const userMap = {};
    users.forEach(u => { userMap[u._id] = u.name; });
    const enriched = assignments.map(a => ({
      ...a,
      assignedToName: userMap[a.assignedTo] || 'Unknown'
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Director: update assignment status (e.g. mark in-progress)
app.patch('/api/assignments/:id', requireAuth, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const assignment = await db.assignments.findOne({ _id: req.params.id });
    if (!assignment) return res.status(404).json({ error: 'Not found' });
    // Directors can only update their own assignments
    if (req.session.role !== 'admin' && assignment.assignedTo !== req.session.userId) {
      return res.status(403).json({ error: 'Not your assignment' });
    }
    const update = { updatedAt: new Date() };
    if (status) update.status = status;
    if (notes !== undefined) update.notes = notes;
    if (status === 'completed') update.completedAt = new Date();
    await db.assignments.update({ _id: req.params.id }, { $set: update });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Director: upload file for an assignment (appends to files array — supports multiple uploads)
app.post('/api/assignments/:id/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const assignment = await db.assignments.findOne({ _id: req.params.id });
    if (!assignment) return res.status(404).json({ error: 'Not found' });
    if (req.session.role !== 'admin' && assignment.assignedTo !== req.session.userId) {
      return res.status(403).json({ error: 'Not your assignment' });
    }

    // Build new file entry
    const fileEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      notes: req.body.notes || '',
      uploadedAt: new Date()
    };

    // Append to files array (migrate from old single-file format if needed)
    const existingFiles = assignment.files || [];
    // Migrate: if old format had uploadedFilename but no files array, convert it
    if (!assignment.files && assignment.uploadedFilename) {
      existingFiles.push({
        id: 'legacy',
        filename: assignment.uploadedFilename,
        originalName: assignment.uploadedOriginalName || 'Uploaded file',
        uploadedAt: assignment.completedAt || assignment.updatedAt
      });
    }
    existingFiles.push(fileEntry);

    // Update assignment — mark in-progress if was pending, but don't auto-complete
    const newStatus = assignment.status === 'pending' ? 'in-progress' : assignment.status;
    await db.assignments.update({ _id: req.params.id }, { $set: {
      files: existingFiles,
      status: newStatus,
      // Keep legacy fields for backward compat
      uploadedFilename: fileEntry.filename,
      uploadedOriginalName: fileEntry.originalName,
      updatedAt: new Date()
    }});

    // Also create a tracker entry so it shows in the evidence tracker
    await db.todoItems.insert({
      itemId: assignment.itemId,
      sectionId: assignment.sectionId,
      evidenceLabel: assignment.evidenceLabel,
      locationId: assignment.locationId,
      status: 'uploaded',
      notes: req.body.notes || 'Uploaded by director',
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    res.json({ ok: true, fileCount: existingFiles.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Director: delete a specific file from an assignment
app.delete('/api/assignments/:id/file/:fileId', requireAuth, async (req, res) => {
  try {
    const assignment = await db.assignments.findOne({ _id: req.params.id });
    if (!assignment) return res.status(404).json({ error: 'Not found' });
    if (req.session.role !== 'admin' && assignment.assignedTo !== req.session.userId) {
      return res.status(403).json({ error: 'Not your assignment' });
    }

    const files = assignment.files || [];
    const fileIdx = files.findIndex(f => f.id === req.params.fileId);
    if (fileIdx === -1) return res.status(404).json({ error: 'File not found' });

    // Delete physical file
    const file = files[fileIdx];
    if (file.filename) {
      const fp = path.join(UPLOADS_DIR, file.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }

    // Remove from array
    files.splice(fileIdx, 1);

    // If no files left, revert status to pending
    const newStatus = files.length === 0 ? 'pending' : assignment.status;
    await db.assignments.update({ _id: req.params.id }, { $set: {
      files,
      status: newStatus === 'completed' && files.length === 0 ? 'pending' : newStatus,
      uploadedFilename: files.length > 0 ? files[files.length - 1].filename : null,
      uploadedOriginalName: files.length > 0 ? files[files.length - 1].originalName : null,
      updatedAt: new Date()
    }});

    // Also remove from tracker
    if (file.filename) {
      await db.todoItems.remove({ filename: file.filename }, {});
    }

    res.json({ ok: true, filesRemaining: files.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Director: mark assignment as complete (separate from uploading)
app.post('/api/assignments/:id/complete', requireAuth, async (req, res) => {
  try {
    const assignment = await db.assignments.findOne({ _id: req.params.id });
    if (!assignment) return res.status(404).json({ error: 'Not found' });
    if (req.session.role !== 'admin' && assignment.assignedTo !== req.session.userId) {
      return res.status(403).json({ error: 'Not your assignment' });
    }
    await db.assignments.update({ _id: req.params.id }, { $set: {
      status: 'completed',
      completedAt: new Date(),
      updatedAt: new Date()
    }});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: delete an assignment
app.delete('/api/assignments/:id', requireAdmin, async (req, res) => {
  try {
    await db.assignments.remove({ _id: req.params.id }, {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: approve an assignment — copies all files to self-reflection evidence, then removes assignment
app.post('/api/assignments/:id/approve', requireAdmin, async (req, res) => {
  try {
    const assignment = await db.assignments.findOne({ _id: req.params.id });
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    const files = assignment.files || [];
    // Backward compat: migrate legacy single file
    if (!files.length && assignment.uploadedFilename) {
      files.push({
        id: 'legacy',
        filename: assignment.uploadedFilename,
        originalName: assignment.uploadedOriginalName || 'Uploaded file',
        mimetype: assignment.mimetype || 'application/octet-stream',
        size: assignment.size || 0
      });
    }

    if (!files.length) return res.status(400).json({ error: 'No files to approve' });

    // Copy each file into db.evidence for the self-reflection File Evidence tab
    let copied = 0;
    for (const f of files) {
      // Check if this file is already in evidence (avoid duplicates)
      const existing = await db.evidence.findOne({ filename: f.filename, sectionId: assignment.sectionId, itemId: assignment.itemId });
      if (!existing) {
        await db.evidence.insert({
          sectionId: assignment.sectionId,
          itemId: assignment.itemId,
          locationId: assignment.locationId,
          label: f.originalName || 'Director upload',
          filename: f.filename,
          originalName: f.originalName,
          mimetype: f.mimetype || 'application/octet-stream',
          size: f.size || 0,
          approvedFrom: 'assignment',
          assignmentId: assignment._id,
          createdAt: new Date()
        });
        copied++;
      }
    }

    // Remove the assignment
    await db.assignments.remove({ _id: req.params.id }, {});

    res.json({ ok: true, filesCopied: copied });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: reject an assignment — sends it back to in-progress with a note
app.post('/api/assignments/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const assignment = await db.assignments.findOne({ _id: req.params.id });
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    await db.assignments.update({ _id: req.params.id }, { $set: {
      status: 'in-progress',
      completedAt: null,
      rejectionReason: reason || 'Please review and resubmit',
      rejectedAt: new Date(),
      updatedAt: new Date()
    }});

    res.json({ ok: true });
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

// ─── DEBUG: User diagnostic + password reset (REMOVE AFTER FIXING) ────────────
// Visit: /api/debug/users to see all users (no passwords shown)
// Visit: /api/debug/reset-password?username=montessori&newpass=TccDir2025 to force-reset
app.get('/api/debug/users', async (req, res) => {
  try {
    const users = await db.users.find({});
    res.json(users.map(u => ({
      _id: u._id,
      username: u.username,
      name: u.name,
      role: u.role,
      locationId: u.locationId,
      hasPassword: !!u.password,
      passwordLength: u.password?.length || 0,
      createdAt: u.createdAt
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/reset-password', async (req, res) => {
  try {
    const { username, newpass } = req.query;
    if (!username || !newpass) return res.json({ error: 'Usage: /api/debug/reset-password?username=montessori&newpass=YourNewPassword' });
    const user = await db.users.findOne({ username: username.toLowerCase() });
    if (!user) return res.json({ error: `User "${username}" not found. Check /api/debug/users for existing usernames.` });
    const hashed = await bcrypt.hash(newpass, 10);
    await db.users.update({ _id: user._id }, { $set: { password: hashed } });
    // Verify it works
    const verify = await bcrypt.compare(newpass, hashed);
    res.json({ ok: true, message: `Password reset for "${username}". Verified: ${verify}. Try logging in now.` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/test-login', async (req, res) => {
  try {
    const { username, password } = req.query;
    if (!username || !password) return res.json({ error: 'Usage: /api/debug/test-login?username=montessori&password=YourPassword' });
    const user = await db.users.findOne({ username: username.toLowerCase() });
    if (!user) return res.json({ found: false, message: `No user with username "${username}"` });
    const valid = await bcrypt.compare(password, user.password);
    res.json({ found: true, username: user.username, passwordMatch: valid, role: user.role, locationId: user.locationId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ─── END DEBUG (remove the above block after fixing) ──────────────────────────

// ─── STATIC + CATCH-ALL ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`GSQ Self-Reflection Tool running on port ${PORT}`));
