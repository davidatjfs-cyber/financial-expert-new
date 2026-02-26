import 'dotenv/config';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: DATABASE_URL });

async function testStores() {
  try {
    console.log('Testing /api/stores logic...\n');
    
    // Query hrms_state table
    const r = await pool.query('select data from hrms_state where key = $1 limit 1', ['default']);
    const row = r.rows?.[0] || null;
    
    if (!row || !row.data) {
      console.log('ERROR: No data found in hrms_state table');
      process.exit(1);
    }
    
    const stateStores = Array.isArray(row.data.stores) ? row.data.stores : [];
    console.log('Found stores in database:', stateStores.length);
    console.log('\nStore names:');
    stateStores.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.name}`);
    });
    
    const items = stateStores.map(s => ({
      id: s.id || s.name,
      name: s.name,
      address: s.address || '',
      manager_name: s.manager || s.managerName || '',
      phone: s.phone || '',
      is_active: String(s.status || 'active') === 'active'
    }));
    
    console.log('\nAPI response would be:');
    console.log(JSON.stringify({ items }, null, 2));
    
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('ERROR:', e.message);
    await pool.end();
    process.exit(1);
  }
}

testStores();
