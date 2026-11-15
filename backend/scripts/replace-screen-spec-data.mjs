import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import pg from 'pg';

const fixture = JSON.parse(await readFile(fileURLToPath(new URL('../fixtures/screen-spec-demo.json', import.meta.url)), 'utf8'));
const tables = [
  'branches', 'users', 'user_branches', 'auth_sessions', 'suppliers', 'materials',
  'branch_stock', 'branch_thresholds', 'recipes', 'recipe_versions', 'recipe_ingredients',
  'import_slips', 'import_items', 'import_receipts', 'import_receipt_items',
  'export_slips', 'export_items', 'stocktakes', 'stocktake_items', 'sales_imports',
  'sales_items', 'sales_unmatched_items', 'approval_requests', 'stock_movements', 'audit_logs',
];
const mode = process.argv[2] || '--dry-run';
if (!['--dry-run', '--apply'].includes(mode)) throw Error('Use --dry-run or --apply');
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is required');
if (!process.env.SEED_PASSWORD) throw Error('SEED_PASSWORD is required');

const rows = Object.fromEntries(tables.map(table => [table, []]));
const put = (table, row) => rows[table].push(row);
const users = [
  { id: 'u-1', username: 'buiducmanh', name: 'Bùi Đức Mạnh', role: 'chucuahang', branchId: 'all' },
  { id: 'u-2', username: 'nguyenthihuong', name: 'Nguyễn Thị Hương', role: 'quanly', branchId: 'hc' },
  { id: 'u-3', username: 'nguyenminhanh', name: 'Nguyễn Minh Anh', role: 'nhanvien', branchId: 'hc' },
];
const userId = name => users.find(user => user.name === name)?.id || 'u-2';
const hash = await bcrypt.hash(process.env.SEED_PASSWORD, 12);
for (const branch of fixture.branches) put('branches', { id: branch.id, name: branch.name, is_main: branch.id === 'hc' });
for (const user of users) {
  put('users', { id: user.id, username: user.username, name: user.name, password_hash: hash, role: user.role });
  for (const branch of fixture.branches.filter(branch => user.branchId === 'all' || user.branchId === branch.id))
    put('user_branches', { user_id: user.id, branch_id: branch.id });
}
const supplierNames = [...new Set(fixture.materials.map(material => material.supplier).filter(Boolean))];
const supplierId = name => `sup-${supplierNames.indexOf(name) + 1}`;
supplierNames.forEach(name => put('suppliers', { id: supplierId(name), name }));
for (const material of fixture.materials) {
  put('materials', {
    id: material.id, code: material.id, name: material.name, category: 'Nguyên vật liệu',
    unit: material.unit, standard_price: material.price, allowed_loss_quantity: material.allowance,
    supplier_id: supplierId(material.supplier), description: material.description || null, status: 'active',
  });
  for (const branch of fixture.branches) {
    const stock = fixture.stocks.find(item => item.branchId === branch.id && item.materialId === material.id);
    put('branch_stock', { branch_id: branch.id, material_id: material.id, quantity: stock?.quantity || 0 });
    put('branch_thresholds', { branch_id: branch.id, material_id: material.id, minimum_quantity: material.minimum });
  }
}

for (const recipe of fixture.recipes) {
  put('recipes', {
    id: recipe.id, code: recipe.id, name: recipe.name, category: recipe.category,
    size: recipe.size || null, sale_price: 0, status: recipe.active ? 'active' : 'inactive',
    current_version_id: `${recipe.id}-v${recipe.version}`, note: recipe.note,
  });
  const versions = recipe.history.length ? recipe.history : [{ version: recipe.version, date: '2026-10-20T10:15:00+07:00', approver: users[0].name, lines: recipe.lines, note: recipe.note }];
  for (const version of versions) {
    const id = `${recipe.id}-v${version.version}`;
    put('recipe_versions', {
      id, recipe_id: recipe.id, version_no: version.version,
      status: version.version === recipe.version ? 'active' : 'superseded',
      created_by: 'u-2', approved_by: userId(version.approver),
      created_at: version.date, approved_at: version.date, note: version.note || recipe.note,
    });
    for (const line of version.lines) put('recipe_ingredients', { version_id: id, material_id: line.materialId, quantity: line.quantity });
  }
}
// The pending recipe revision is a real version so approving CT-0012 works through the API.
const proposedRecipe = fixture.proposals.find(proposal => proposal.id === 'CT-0012');
const proposedVersionId = 'MON-001-v3';
put('recipe_versions', {
  id: proposedVersionId, recipe_id: 'MON-001', version_no: 3, status: 'pending',
  created_by: 'u-2', created_at: proposedRecipe.date, note: proposedRecipe.recipe.note,
});
for (const line of proposedRecipe.recipe.lines)
  put('recipe_ingredients', { version_id: proposedVersionId, material_id: line.materialId, quantity: line.quantity });

const importDates = {
  'PNK-0009': '2026-11-03T09:10:00+07:00', 'PNK-0008': '2026-11-02T09:00:00+07:00',
  'PNK-0007': '2026-11-01T09:00:00+07:00', 'PNK-0006': '2026-10-29T09:00:00+07:00',
  'PNK-0005': '2026-10-28T09:00:00+07:00', 'PNK-0004': '2026-10-27T09:00:00+07:00',
};
const events = [];
for (const movement of fixture.movements) {
  if (movement.kind === 'inbound') {
    const status = { pending: 'pending_approval', receiving: 'approved', backorder: 'backorder', completed: 'completed' }[movement.status];
    const receiptId = `receipt-${movement.id}`;
    const hasReceipt = status === 'backorder' || status === 'completed';
    const createdAt = importDates[movement.id] || movement.date;
    put('import_slips', {
      id: movement.id, code: movement.id, branch_id: movement.branchId,
      supplier_id: supplierId(movement.supplier), creator_id: 'u-2', expected_date: movement.expectedDate,
      status, note: movement.note, created_at: createdAt, updated_at: createdAt,
    });
    if (hasReceipt) put('import_receipts', {
      id: receiptId, slip_id: movement.id, received_by: 'u-3',
      received_at: createdAt, idempotency_key: `fixture-${movement.id}`,
    });
    for (const line of movement.lines) {
      const defect = status === 'backorder' && line.materialId === 'NVL-002' ? 1 : 0;
      const received = hasReceipt ? line.quantity : 0;
      const good = received - defect;
      put('import_items', {
        slip_id: movement.id, material_id: line.materialId, planned_quantity: line.quantity,
        unit_price: fixture.materials.find(material => material.id === line.materialId).price,
        received_good_quantity: good,
      });
      if (hasReceipt) {
        put('import_receipt_items', {
          receipt_id: receiptId, material_id: line.materialId, received_quantity: received,
          defect_quantity: defect, defect_reason: defect ? 'Hàng lỗi cần giao bù' : null,
        });
        if (good > 0) events.push({ branchId: movement.branchId, materialId: line.materialId,
          delta: good, sourceType: 'import_receipt', sourceId: receiptId,
          lineId: `${receiptId}:${line.materialId}`, date: createdAt });
      }
    }
  } else {
    const status = { pending: 'pending_approval', ready: 'pending_confirmation', completed: 'completed' }[movement.status];
    put('export_slips', {
      id: movement.id, code: movement.id, branch_id: movement.branchId,
      target_branch_id: movement.destinationId || null, creator_id: 'u-2',
      type: movement.type === 'transfer' ? 'chuyen_kho' : 'cap_quay', status,
      reason: movement.reason || movement.note, created_at: movement.date, updated_at: movement.date,
    });
    for (const line of movement.lines) {
      put('export_items', {
        slip_id: movement.id, material_id: line.materialId, requested_quantity: line.quantity,
        actual_quantity: status === 'completed' ? line.quantity : null,
        unit_cost: fixture.materials.find(material => material.id === line.materialId).price,
      });
      if (status === 'completed') {
        events.push({ branchId: movement.branchId, materialId: line.materialId,
          delta: -line.quantity, sourceType: 'export', sourceId: movement.id,
          lineId: `${movement.id}:${line.materialId}:out`, date: movement.date });
        if (movement.destinationId) events.push({ branchId: movement.destinationId, materialId: line.materialId,
          delta: line.quantity, sourceType: 'internal_transfer', sourceId: movement.id,
          lineId: `${movement.id}:${line.materialId}:in`, date: movement.date });
      }
    }
  }
}

for (const count of fixture.counts) {
  put('stocktakes', {
    id: count.id, code: count.id, branch_id: count.branchId, creator_id: userId(count.creator),
    status: 'completed', period: count.period, note: count.note,
    created_at: count.date, completed_at: count.date,
  });
  for (const line of count.lines) put('stocktake_items', {
    stocktake_id: count.id, material_id: line.materialId,
    system_quantity: line.theoretical, actual_quantity: line.actual,
    difference_reason: line.actual === line.theoretical ? null : count.reason,
    remedy: line.actual === line.theoretical ? null : count.remedy,
  });
  put('audit_logs', { id: randomUUID(), actor_id: userId(count.creator), action: 'count',
    entity_type: 'stocktake', entity_id: count.id, created_at: count.date });
}
for (const sale of fixture.sales) {
  put('sales_imports', {
    id: sale.id, branch_id: sale.branchId, period: sale.period,
    period_start: '2026-10-01', period_end: '2026-10-31',
    imported_by: 'u-2', imported_at: sale.date, file_name: sale.filename,
  });
  for (const line of sale.lines) put('sales_items', {
    import_id: sale.id, recipe_id: line.recipeId, recipe_version_id: `${line.recipeId}-v1`,
    quantity: line.quantity, unit_price: 0,
  });
}

const approval = (id, type, action, referenceId, branchId, payload, reason, date) => put('approval_requests', {
  id, type, action, reference_id: referenceId, branch_id: branchId,
  requester_id: 'u-2', payload: JSON.stringify(payload), reason, status: 'pending', created_at: date,
});
approval('CT-0012', 'recipe', 'update', 'MON-001', 'hc', {
  versionId: proposedVersionId, name: proposedRecipe.recipe.name,
  category: proposedRecipe.recipe.category, price: 0, note: proposedRecipe.recipe.note,
}, proposedRecipe.reason, proposedRecipe.date);
const materialProposal = fixture.proposals.find(proposal => proposal.id === 'NVL-DC-0015');
approval('NVL-DC-0015', 'threshold', 'update', 'NVL-001', 'hc',
  { minimumQuantity: materialProposal.material.minimum }, materialProposal.reason, materialProposal.date);
const adjustmentProposal = fixture.proposals.find(proposal => proposal.id === 'DC-0024');
approval('DC-0024', 'stock_adjustment', 'apply', 'PKK-0006', 'hc', {}, adjustmentProposal.reason, adjustmentProposal.date);
for (const movement of fixture.movements.filter(movement => movement.status === 'pending'))
  approval(`PD-${movement.id}`, movement.kind === 'inbound' ? 'import_plan' : 'export_transfer',
    'approve', movement.id, movement.branchId, {}, movement.note, movement.date);

// Start from an explainable opening balance, apply receipt events, then add historical
// usage where the spec's current stock is lower than the sum of documented receipts.
for (const stock of rows.branch_stock) {
  const related = events.filter(event => event.branchId === stock.branch_id && event.materialId === stock.material_id)
    .sort((a, b) => a.date.localeCompare(b.date));
  const total = related.reduce((sum, event) => sum + event.delta, 0);
  let balance = Math.max(0, Number(stock.quantity) - total);
  if (balance > 0) put('stock_movements', {
    id: randomUUID(), branch_id: stock.branch_id, material_id: stock.material_id,
    delta: balance, balance_after: balance, source_type: 'opening', source_id: 'screen-spec-fixture',
    source_line_id: `${stock.branch_id}:${stock.material_id}`, created_by: 'u-1',
    created_at: '2026-09-01T00:00:00+07:00',
  });
  for (const event of related) {
    balance += event.delta;
    put('stock_movements', {
      id: randomUUID(), branch_id: event.branchId, material_id: event.materialId,
      delta: event.delta, balance_after: balance, source_type: event.sourceType,
      source_id: event.sourceId, source_line_id: event.lineId, created_by: 'u-3', created_at: event.date,
    });
  }
  const correction = Number(stock.quantity) - balance;
  if (correction !== 0) put('stock_movements', {
    id: randomUUID(), branch_id: stock.branch_id, material_id: stock.material_id,
    delta: correction, balance_after: Number(stock.quantity), source_type: 'demo_usage',
    source_id: 'screen-spec-fixture', source_line_id: `${stock.branch_id}:${stock.material_id}`,
    created_by: 'u-2', created_at: '2026-11-03T10:00:00+07:00',
  });
}

const quote = name => `"${name.replaceAll('"', '""')}"`;
const insert = async (client, table, row) => {
  const columns = Object.keys(row);
  await client.query(`INSERT INTO app.${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
};
console.log('Screen-spec fixture:', Object.fromEntries(tables.map(table => [table, rows[table].length])));
if (mode === '--dry-run') process.exit(0);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
await client.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  const actualTables = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='app' AND table_type='BASE TABLE' ORDER BY table_name"))
    .rows.map(row => row.table_name);
  if (actualTables.join(',') !== [...tables].sort().join(',')) throw Error('Database table list differs from the reviewed schema; no data was changed.');
  const backup = {};
  for (const table of tables) backup[table] = (await client.query(`SELECT * FROM app.${quote(table)}`)).rows;
  const backupDir = fileURLToPath(new URL('../backups/', import.meta.url));
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = `${backupDir}/before-screen-spec-${new Date().toISOString().replaceAll(':', '-')}.json`;
  await writeFile(backupPath, JSON.stringify({ takenAt: new Date().toISOString(), rows: backup }, null, 2), { mode: 0o600, flag: 'wx' });
  console.log('Backup written:', backupPath);
  await client.query(`TRUNCATE ${tables.map(table => `app.${quote(table)}`).join(', ')}`);
  for (const table of tables) for (const row of rows[table]) await insert(client, table, row);
  await client.query(await readFile(fileURLToPath(new URL('../sql/postgres/005_ordered_codes.sql', import.meta.url)), 'utf8'));
  const mismatch = await client.query(`SELECT COUNT(*)::int AS n FROM app.branch_stock AS stock
    LEFT JOIN (SELECT branch_id, material_id, SUM(delta) AS total FROM app.stock_movements GROUP BY branch_id,material_id) AS ledger
      ON ledger.branch_id=stock.branch_id AND ledger.material_id=stock.material_id
    WHERE ABS(stock.quantity-COALESCE(ledger.total,0)) > 0.0001`);
  if (mismatch.rows[0].n) throw Error('Stock ledger does not match branch balances; rolled back.');
  await client.query('COMMIT');
  console.log('Screen-spec data applied. Stock ledger matches all branch balances.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
