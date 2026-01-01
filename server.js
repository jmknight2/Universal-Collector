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

// 2. Setup Database with Network-Safe Settings
const dbPath = path.join(dataDir, 'collection.db');
console.log(`Attempting to open database at: ${dbPath}`);

let db;
try {
    db = new Database(dbPath, { timeout: 10000 }); // Increase busy timeout
    
    // CRITICAL FOR SMB: Force legacy journal mode. 
    // WAL mode relies on memory mapping which often fails on network shares.
    db.pragma('journal_mode = DELETE'); 
    
    // Optional: caching adjustments for network latency
    db.pragma('cache_size = -64000'); // 64MB cache
    
    console.log('Database opened successfully.');
} catch (err) {
    console.error('CRITICAL ERROR: Could not open database.', err);
    process.exit(1); 
}

// 3. Schema Management
// Step A: Create base table if it doesn't exist
// Note: We define the full schema here for new installs.
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
`);


// Create Indexes on potentially new columns
// We do this AFTER migration to ensure the column exists.
try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_category ON items(category);`);
} catch (e) {
    console.warn('Index creation warning:', e.message);
}

// 4. Setup File Upload (Multer)
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

// 6. API Routes
const processItemData = (req) => {
  const { name, category, collection, barcode, owned, data } = req.body;
  
  let dataObj = {};
  try {
    dataObj = typeof data === 'string' ? JSON.parse(data) : data;
  } catch (e) { console.error("JSON Parse Error", e); }

  const existingImages = Array.isArray(dataObj.imageUrls) ? dataObj.imageUrls : [];
  const newImages = req.files ? req.files.map(f => `/uploads/${f.filename}`) : [];
  const finalImageUrls = [...existingImages, ...newImages];
  
  dataObj.imageUrls = finalImageUrls;
  dataObj.imageUrl = finalImageUrls.length > 0 ? finalImageUrls[0] : null;

  return { name, category, collection, barcode, owned, dataObj };
};

app.get('/api/items', (req, res) => {
  try {
      const stmt = db.prepare('SELECT * FROM items ORDER BY created_at DESC');
      const items = stmt.all().map(item => ({
        ...item,
        owned: Boolean(item.owned),
        data: JSON.parse(item.data)
      }));
      res.json(items);
  } catch (e) {
      console.error("DB Error:", e);
      res.status(500).json({ error: "Database error" });
  }
});

app.post('/api/items', upload.array('images'), (req, res) => {
  const { name, category, collection, barcode, owned, dataObj } = processItemData(req);

  const stmt = db.prepare(`
    INSERT INTO items (name, category, collection, barcode, owned, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  
  const info = stmt.run(
    name, 
    category || 'Toy', 
    collection || 'General', 
    barcode || null, 
    (owned === 'true' || owned === true) ? 1 : 0, 
    JSON.stringify(dataObj)
  );
  
  res.json({ id: info.lastInsertRowid, ...dataObj });
});

app.put('/api/items/:id', upload.array('images'), (req, res) => {
  const { name, category, collection, barcode, owned, dataObj } = processItemData(req);
  const id = req.params.id;

  const stmt = db.prepare(`
    UPDATE items 
    SET name = ?, category = ?, collection = ?, barcode = ?, owned = ?, data = ?
    WHERE id = ?
  `);

  stmt.run(
    name, 
    category || 'Toy', 
    collection || 'General', 
    barcode || null, 
    (owned === 'true' || owned === true) ? 1 : 0, 
    JSON.stringify(dataObj),
    id
  );

  res.json({ id, name, category, collection, barcode, owned, data: dataObj });
});

app.post('/api/items/:id/toggle', (req, res) => {
  const { owned } = req.body;
  const stmt = db.prepare('UPDATE items SET owned = ? WHERE id = ?');
  stmt.run(owned ? 1 : 0, req.params.id);
  res.json({ success: true });
});

app.delete('/api/items/:id', (req, res) => {
  const stmt = db.prepare('DELETE FROM items WHERE id = ?');
  stmt.run(req.params.id);
  res.json({ success: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Collector Server running on port ${PORT}`);
});