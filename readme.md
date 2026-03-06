# GSQ Self-Reflection Tool
### Great Start to Quality — The Children's Center

A persistent web app for completing GSQ self-reflection efficiently, with AI-powered policy evidence search across your uploaded handbooks and policy documents.

---

## Features

- **Section & Item Management** — Add all GSQ sections and items with criteria text
- **Self-Reflection Narratives** — Write and save your response for each item; remembered every visit
- **Self-Rating** — Rate each item 1–5 on your implementation level
- **AI Policy Evidence Search** — Upload your handbooks/policies; AI finds exact quotes + page numbers automatically or via custom keyword search
- **Accept / Dismiss / Restore** — Review each suggested policy match and keep only what applies
- **File Evidence Attachments** — Attach photos, forms, documents as evidence per item
- **Progress Dashboard** — Visual completion tracking across all sections
- **Persistent Storage** — All data saved in local NeDB databases (survive restarts)

---

## Setup on Render

### 1. Create GitHub repo
Push all files to a new GitHub repository.

### 2. Create Render Web Service
- **Build Command:** `npm install`
- **Start Command:** `node server.js`
- **Node version:** 18+

### 3. Environment Variables on Render
Add these in Render Dashboard → Environment:
```
ANTHROPIC_API_KEY=sk-ant-...your key here...
```

### 4. Persistent Disk (IMPORTANT)
For data to survive Render restarts, add a **Persistent Disk** in Render:
- Mount path: `/opt/render/project/src/data`
- Also add a second disk or use same disk for uploads:
- Mount path: `/opt/render/project/src/uploads`

Without persistent disks, data resets on each deploy. On paid Render plans, disks cost ~$0.25/GB/month.

---

## Usage

### Adding GSQ Sections
1. Go to **Self-Reflection** tab
2. Click **+ Add Section**
3. Enter the section name (e.g., "Curriculum and Learning Environment")
4. Add each item/question with its criteria
5. Click Save

### Uploading Handbooks & Policies
1. Go to **Handbooks & Policies** tab
2. Drag-drop or click to upload a PDF or Word doc
3. Name it and choose its type (Staff Handbook, Family Handbook, Policy Doc)
4. Click **Upload & Index Document** — the AI will extract and index every page

### Completing Self-Reflection
1. Select a section from the sidebar
2. Click any item to expand it
3. **My Response tab** — Write your narrative, set your self-rating
4. **Policy Evidence tab** — Click ✨ Auto-Find to have AI search all your documents, or type keywords and click 🔍 Search
5. Review suggested matches → Accept what applies, dismiss what doesn't
6. **File Evidence tab** — Attach supporting photos or documents
7. Click 💾 Save Response

---

## File Structure
```
gsq-app/
├── server.js          # Express backend + API routes
├── public/
│   └── index.html     # Full frontend (single file)
├── data/              # NeDB databases (auto-created)
├── uploads/           # Uploaded files (auto-created)
├── .env               # Your API key (never commit this)
└── package.json
```
