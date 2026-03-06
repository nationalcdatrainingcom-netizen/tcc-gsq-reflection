require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const Datastore = require('nedb-promises');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure directories exist
['uploads', 'data', 'public'].forEach(dir => {
  if (!fs.existsSync(path.join(__dirname, dir))) fs.mkdirSync(dir, { recursive: true });
});

// Databases
const db = {
  documents: Datastore.create({ filename: path.join(__dirname, 'data/documents.db'), autoload: true }),
  responses:  Datastore.create({ filename: path.join(__dirname, 'data/responses.db'),  autoload: true }),
  evidence:   Datastore.create({ filename: path.join(__dirname, 'data/evidence.db'),   autoload: true }),
  sections:   Datastore.create({ filename: path.join(__dirname, 'data/sections.db'),   autoload: true }),
};

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── SECTIONS API ──────────────────────────────────────────────────────────────

// Get all sections
app.get('/api/sections', async (req, res) => {
  try {
    const sections = await db.sections.find({}).sort({ order: 1 });
    res.json(sections);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create / update section
app.post('/api/sections', async (req, res) => {
  try {
    const { _id, name, description, order, items } = req.body;
    if (_id) {
      await db.sections.update({ _id }, { $set: { name, description, order, items } });
      res.json({ ok: true });
    } else {
      const doc = await db.sections.insert({ name, description, order: order || 0, items: items || [], createdAt: new Date() });
      res.json(doc);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sections/:id', async (req, res) => {
  try {
    await db.sections.remove({ _id: req.params.id }, {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── RESPONSES API ─────────────────────────────────────────────────────────────

// Get all responses for a section
app.get('/api/responses/:sectionId', async (req, res) => {
  try {
    const responses = await db.responses.find({ sectionId: req.params.sectionId });
    res.json(responses);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save / update a response
app.post('/api/responses', async (req, res) => {
  try {
    const { sectionId, itemId, narrative, policyMatches, rating, notes } = req.body;
    const existing = await db.responses.findOne({ sectionId, itemId });
    if (existing) {
      await db.responses.update({ _id: existing._id }, { $set: { narrative, policyMatches, rating, notes, updatedAt: new Date() } });
      res.json({ ok: true, _id: existing._id });
    } else {
      const doc = await db.responses.insert({ sectionId, itemId, narrative, policyMatches: policyMatches || [], rating, notes, createdAt: new Date(), updatedAt: new Date() });
      res.json(doc);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── EVIDENCE API ──────────────────────────────────────────────────────────────

app.get('/api/evidence/:sectionId/:itemId', async (req, res) => {
  try {
    const evidence = await db.evidence.find({ sectionId: req.params.sectionId, itemId: req.params.itemId });
    res.json(evidence);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/evidence/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { sectionId, itemId, label } = req.body;
    const doc = await db.evidence.insert({
      sectionId, itemId, label: label || req.file.originalname,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      createdAt: new Date()
    });
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/evidence/:id', async (req, res) => {
  try {
    const ev = await db.evidence.findOne({ _id: req.params.id });
    if (ev) {
      const fp = path.join(__dirname, 'uploads', ev.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      await db.evidence.remove({ _id: req.params.id }, {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DOCUMENTS API ─────────────────────────────────────────────────────────────

app.get('/api/documents', async (req, res) => {
  try {
    const docs = await db.documents.find({}).sort({ createdAt: -1 });
    res.json(docs.map(d => ({ ...d, pages: undefined }))); // don't send full page content in list
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/documents/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { docType, docName } = req.body; // docType: 'staff_handbook' | 'family_handbook' | 'policy' | 'other'

    const filePath = path.join(__dirname, 'uploads', req.file.filename);
    let pages = [];

    if (req.file.mimetype === 'application/pdf') {
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      // Split by form-feed chars or estimate pages by character count
      const rawPages = data.text.split(/\f/);
      pages = rawPages.map((text, i) => ({ page: i + 1, text: text.trim() })).filter(p => p.text);
      if (pages.length === 1 && data.numpages > 1) {
        // PDF didn't have form feeds, split by estimated page size
        const charsPerPage = Math.ceil(data.text.length / data.numpages);
        pages = [];
        for (let i = 0; i < data.numpages; i++) {
          pages.push({ page: i + 1, text: data.text.slice(i * charsPerPage, (i + 1) * charsPerPage).trim() });
        }
      }
    } else if (req.file.originalname.match(/\.docx?$/i)) {
      const result = await mammoth.extractRawText({ path: filePath });
      const lines = result.value.split('\n\n').filter(l => l.trim());
      // Approximate pages (every ~40 paragraphs = 1 page)
      const perPage = 40;
      for (let i = 0; i < Math.ceil(lines.length / perPage); i++) {
        pages.push({ page: i + 1, text: lines.slice(i * perPage, (i + 1) * perPage).join('\n\n') });
      }
    }

    const doc = await db.documents.insert({
      filename: req.file.filename,
      originalName: req.file.originalname,
      docType: docType || 'policy',
      docName: docName || req.file.originalname.replace(/\.[^/.]+$/, ''),
      mimetype: req.file.mimetype,
      size: req.file.size,
      pageCount: pages.length,
      pages,
      createdAt: new Date()
    });

    res.json({ _id: doc._id, docName: doc.docName, docType: doc.docType, pageCount: doc.pageCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/documents/:id', async (req, res) => {
  try {
    const doc = await db.documents.findOne({ _id: req.params.id });
    if (doc) {
      const fp = path.join(__dirname, 'uploads', doc.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      await db.documents.remove({ _id: req.params.id }, {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AI POLICY SEARCH ──────────────────────────────────────────────────────────

app.post('/api/ai/search-policies', async (req, res) => {
  try {
    const { itemText, criteria, searchQuery, docIds } = req.body;

    // Load selected (or all) documents
    const query = docIds && docIds.length ? { _id: { $in: docIds } } : {};
    const docs = await db.documents.find(query);

    if (!docs.length) return res.json({ matches: [] });

    // Build context: collect relevant page snippets using keyword pre-filter
    const keywords = (searchQuery || itemText || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    let pagePool = [];
    docs.forEach(doc => {
      (doc.pages || []).forEach(p => {
        const lower = p.text.toLowerCase();
        const hits = keywords.filter(k => lower.includes(k)).length;
        if (hits > 0 || !searchQuery) {
          pagePool.push({ docId: doc._id, docName: doc.docName, docType: doc.docType, page: p.page, text: p.text, hits });
        }
      });
    });

    // Sort by relevance, take top 20 pages
    pagePool.sort((a, b) => b.hits - a.hits);
    const topPages = pagePool.slice(0, 20);

    if (!topPages.length) return res.json({ matches: [] });

    const contextText = topPages.map(p =>
      `[Document: "${p.docName}" | Type: ${p.docType} | Page ${p.page}]\n${p.text.slice(0, 800)}`
    ).join('\n\n---\n\n');

    const prompt = `You are a childcare compliance expert helping a Michigan childcare director complete a Great Start to Quality self-reflection.

ITEM BEING EVALUATED:
${itemText}

WHAT EVALUATORS ARE LOOKING FOR:
${criteria || 'General compliance evidence'}

SEARCH QUERY (if any): ${searchQuery || 'none - use your best judgment'}

DOCUMENT PAGES TO SEARCH:
${contextText}

Your task: Find ALL passages in the above documents that could serve as evidence or policy citations for this GSQ item. For each match, return:
- The document name
- The page number
- A direct excerpt (2-5 sentences max) that is most relevant
- A brief explanation of why it applies

Respond ONLY with valid JSON array, no markdown, no preamble:
[
  {
    "docName": "...",
    "docType": "...",
    "page": 5,
    "excerpt": "...",
    "relevance": "..."
  }
]

If no relevant passages found, return: []`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    let text = data.content?.[0]?.text || '[]';
    text = text.replace(/```json|```/g, '').trim();
    let matches = [];
    try { matches = JSON.parse(text); } catch {}

    res.json({ matches });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PROGRESS API ──────────────────────────────────────────────────────────────

app.get('/api/progress', async (req, res) => {
  try {
    const sections = await db.sections.find({});
    const responses = await db.responses.find({});
    const result = sections.map(s => {
      const totalItems = (s.items || []).length;
      const completed = responses.filter(r => r.sectionId === s._id && r.narrative && r.narrative.trim()).length;
      return { _id: s._id, name: s.name, totalItems, completed };
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`GSQ app running on port ${PORT}`));
