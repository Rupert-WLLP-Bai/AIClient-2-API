
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, 'data/stats.db');
const db = new Database(DB_PATH, { readonly: true });

try {
    const tableInfo = db.pragma('table_info(request_logs)');
    console.log('Schema:', tableInfo);

    const rows = db.prepare('SELECT timestamp FROM request_logs ORDER BY timestamp DESC LIMIT 5').all();
    console.log('Sample timestamps:', rows);
    
    const now = db.prepare("SELECT datetime('now') as now").get();
    console.log('SQLite now:', now);

} catch (error) {
    console.error('Error:', error);
} finally {
    db.close();
}
