const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Setup Data & Upload Directories
const dataDir = process.env.DATA_DIR || './data';
const uploadsDir = path.join(dataDir, 'uploads');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// 2. Setup Database
const dbPath = path.join(dataDir, 'collection.db');
let db;
try {
    db = new Database(dbPath, { timeout: 10000 });
    db.pragma('journal_mode = DELETE');
    db.pragma('cache_size = -64000');
} catch (err) {
    console.error('CRITICAL ERROR: Could not open database.', err);
    process.exit(1); 
}

// 3. Schema Management
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'Toy',
    collection TEXT NOT NULL,
    barcode TEXT,
    owned INTEGER DEFAULT 0,
    data TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_barcode ON items(barcode);
  CREATE INDEX IF NOT EXISTS idx_category ON items(category);
`);

// 4. File Upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, uploadsDir); },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// 5. Middleware
app.use(express.json());
app.use(express.static('public')); 
app.use('/uploads', express.static(uploadsDir));

// 6. Routes
const processItemData = (req) => {
  const { name, category, collection, barcode, owned, data } = req.body;
  let dataObj = {};
  try { dataObj = typeof data === 'string' ? JSON.parse(data) : data; } catch (e) {}

  const existingImages = Array.isArray(dataObj.imageUrls) ? dataObj.imageUrls : [];
  const newImages = req.files ? req.files.map(f => `/uploads/${f.filename}`) : [];
  dataObj.imageUrls = [...existingImages, ...newImages];
  dataObj.imageUrl = dataObj.imageUrls.length > 0 ? dataObj.imageUrls[0] : null;

  return { name, category, collection, barcode, owned, dataObj };
};

// GET Items (Filtered)
app.get('/api/items', (req, res) => {
  try {
      const category = req.query.category;
      let query = 'SELECT * FROM items';
      const params = [];
      if (category) {
          query += ' WHERE category = ?';
          params.push(category);
      }
      query += ' ORDER BY created_at DESC';
      const stmt = db.prepare(query);
      const items = stmt.all(...params).map(item => ({
        ...item,
        owned: Boolean(item.owned),
        data: JSON.parse(item.data)
      }));
      res.json(items);
  } catch (e) {
      res.status(500).json({ error: "Database error" });
  }
});

// GET Metadata (For Autocomplete)
app.get('/api/metadata', (req, res) => {
    try {
        const items = db.prepare('SELECT collection, data FROM items').all();
        const metadata = {
            collections: new Set(),
            brands: new Set(),
            themes: new Set(),
            developers: new Set(),
            publishers: new Set()
        };

        items.forEach(i => {
            if(i.collection) metadata.collections.add(i.collection);
            const d = JSON.parse(i.data || '{}');
            if(d.brand) metadata.brands.add(d.brand);
            if(d.theme) metadata.themes.add(d.theme);
            if(d.developer) metadata.developers.add(d.developer);
            if(d.publisher) metadata.publishers.add(d.publisher);
        });

        res.json({
            collection: [...metadata.collections].sort(),
            brand: [...metadata.brands].sort(),
            theme: [...metadata.themes].sort(),
            developer: [...metadata.developers].sort(),
            publisher: [...metadata.publishers].sort()
        });
    } catch (e) {
        res.status(500).json({ error: "DB Error" });
    }
});

app.post('/api/items', upload.array('images'), (req, res) => {
  const { name, category, collection, barcode, owned, dataObj } = processItemData(req);
  const info = db.prepare(`INSERT INTO items (name, category, collection, barcode, owned, data) VALUES (?, ?, ?, ?, ?, ?)`).run(name, category || 'Toy', collection || 'General', barcode || null, (owned === 'true' || owned === true) ? 1 : 0, JSON.stringify(dataObj));
  res.json({ id: info.lastInsertRowid, ...dataObj });
});

app.put('/api/items/:id', upload.array('images'), (req, res) => {
  const { name, category, collection, barcode, owned, dataObj } = processItemData(req);
  db.prepare(`UPDATE items SET name = ?, category = ?, collection = ?, barcode = ?, owned = ?, data = ? WHERE id = ?`).run(name, category || 'Toy', collection || 'General', barcode || null, (owned === 'true' || owned === true) ? 1 : 0, JSON.stringify(dataObj), req.params.id);
  res.json({ id: req.params.id, ...dataObj });
});

app.post('/api/items/:id/toggle', (req, res) => {
  db.prepare('UPDATE items SET owned = ? WHERE id = ?').run(req.body.owned ? 1 : 0, req.params.id);
  res.json({ success: true });
});

app.delete('/api/items/:id', (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Server running on ${PORT}`));