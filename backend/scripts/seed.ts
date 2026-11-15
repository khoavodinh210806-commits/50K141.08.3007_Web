import "dotenv/config";
import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import {
  INITIAL_BRANCHES,
  DEMO_USERS,
  INITIAL_MATERIALS,
  INITIAL_RECIPES,
} from "../../PTTKHT_Duyen/src/data/mockData";
import { pool, transaction, txQuery } from "../src/inventory/db";

async function main() {
  const password = process.env.SEED_PASSWORD;
  if (!password) throw new Error("SEED_PASSWORD is required");
  const hash = await bcrypt.hash(password, 12);
  await transaction(async (tx) => {
    for (const b of INITIAL_BRANCHES)
      await txQuery(
        tx,
        `INSERT INTO app.branches(id,name,address,phone,is_main) VALUES(@id,@name,@address,@phone,@main) ON CONFLICT DO NOTHING`,
        {
          id: b.id,
          name: b.name,
          address: b.address,
          phone: b.phone,
          main: !!b.isMain,
        },
      );
    for (const u of DEMO_USERS) {
      await txQuery(
        tx,
        `INSERT INTO app.users(id,username,name,password_hash,role) VALUES(@id,@username,@name,@hash,@role) ON CONFLICT DO NOTHING`,
        { id: u.id, username: u.username, name: u.name, hash, role: u.role },
      );
      for (const b of INITIAL_BRANCHES.filter(
        (b) => u.branchId === "all" || u.branchId === b.id,
      ))
        await txQuery(
          tx,
          `INSERT INTO app.user_branches(user_id,branch_id) VALUES(@user,@branch) ON CONFLICT DO NOTHING`,
          { user: u.id, branch: b.id },
        );
    }
    const supplierIds = new Map<string, string>();
    for (const m of INITIAL_MATERIALS)
      if (m.supplier) {
        if (!supplierIds.has(m.supplier))
          supplierIds.set(m.supplier, `sup-${supplierIds.size + 1}`);
        await txQuery(
          tx,
          `INSERT INTO app.suppliers(id,name) VALUES(@id,@name) ON CONFLICT DO NOTHING`,
          { id: supplierIds.get(m.supplier), name: m.supplier },
        );
      }
    for (const m of INITIAL_MATERIALS) {
      await txQuery(
        tx,
        `INSERT INTO app.materials(id,code,name,category,unit,standard_price,supplier_id,description,status,deactivation_reason)
        VALUES(@id,@code,@name,@category,@unit,@price,@supplier,@description,@status,@reason) ON CONFLICT DO NOTHING`,
        {
          id: m.id,
          code: m.code,
          name: m.name,
          category: m.category,
          unit: m.unit,
          price: m.standardPrice,
          supplier: m.supplier ? supplierIds.get(m.supplier) : null,
          description: m.description || null,
          status: m.status,
          reason: m.deactivationReason || null,
        },
      );
      for (const b of INITIAL_BRANCHES) {
        const qty = m.stocks[b.id] || 0,
          threshold = m.minStocks[b.id] || 0;
        await txQuery(
          tx,
          `INSERT INTO app.branch_stock(branch_id,material_id,quantity) VALUES(@branch,@material,@qty) ON CONFLICT DO NOTHING`,
          { branch: b.id, material: m.id, qty },
        );
        await txQuery(
          tx,
          `INSERT INTO app.branch_thresholds(branch_id,material_id,minimum_quantity) VALUES(@branch,@material,@qty) ON CONFLICT DO NOTHING`,
          { branch: b.id, material: m.id, qty: threshold },
        );
        if (qty > 0)
          await txQuery(
            tx,
            `INSERT INTO app.stock_movements(id,branch_id,material_id,delta,balance_after,source_type,source_id,source_line_id,created_by)
          VALUES(@id,@branch,@material,@qty,@qty,'opening','seed',@line,'u-1') ON CONFLICT DO NOTHING`,
            {
              id: randomUUID(),
              branch: b.id,
              material: m.id,
              qty,
              line: `${b.id}:${m.id}`,
            },
          );
      }
    }
    for (const rec of INITIAL_RECIPES) {
      await txQuery(
        tx,
        `INSERT INTO app.recipes(id,code,name,category,sale_price,status,note,current_version_id)
        VALUES(@id,@code,@name,@category,@price,@status,@note,@version) ON CONFLICT DO NOTHING`,
        {
          id: rec.id,
          code: rec.code,
          name: rec.name,
          category: rec.category,
          price: rec.price,
          status: rec.status === "active" ? "active" : "pending",
          note: rec.note || null,
          version: rec.status === "active" ? `${rec.id}-v1` : null,
        },
      );
      await txQuery(
        tx,
        `INSERT INTO app.recipe_versions(id,recipe_id,version_no,status,created_by,approved_by,approved_at,note)
        VALUES(@id,@recipe,1,@status,@creator,@approver,@date,@note) ON CONFLICT DO NOTHING`,
        {
          id: `${rec.id}-v1`,
          recipe: rec.id,
          status: rec.status === "active" ? "active" : "pending",
          creator: "u-2",
          approver: rec.status === "active" ? "u-1" : null,
          date: rec.status === "active" ? new Date() : null,
          note: rec.note || null,
        },
      );
      for (const ing of rec.ingredients)
        await txQuery(
          tx,
          `INSERT INTO app.recipe_ingredients(version_id,material_id,quantity) VALUES(@version,@material,@qty) ON CONFLICT DO NOTHING`,
          {
            version: `${rec.id}-v1`,
            material: ing.materialId,
            qty: ing.quantity,
          },
        );
    }
  });
  console.log(
    "Seeded branches, demo users, materials, opening stock and recipes",
  );
  await (await pool()).end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
