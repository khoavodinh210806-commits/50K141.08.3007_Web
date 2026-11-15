CREATE SCHEMA IF NOT EXISTS app;
CREATE TABLE IF NOT EXISTS app.branches (
 id varchar(40) PRIMARY KEY, name varchar(200) NOT NULL, address varchar(300) NOT NULL DEFAULT '', phone varchar(30) NOT NULL DEFAULT '', is_main boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS app.users (
 id varchar(40) PRIMARY KEY, username varchar(80) NOT NULL UNIQUE, name varchar(150) NOT NULL,
 password_hash varchar(100) NOT NULL, role varchar(20) NOT NULL CHECK(role IN ('chucuahang','quanly','ketoan','nhanvien')),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app.user_branches (
 user_id varchar(40) NOT NULL REFERENCES app.users(id), branch_id varchar(40) NOT NULL REFERENCES app.branches(id),
 CONSTRAINT pk_user_branches PRIMARY KEY(user_id,branch_id)
);
CREATE TABLE IF NOT EXISTS app.auth_sessions (
 id varchar(40) PRIMARY KEY, user_id varchar(40) NOT NULL REFERENCES app.users(id),
 expires_at timestamptz NOT NULL, revoked_at timestamptz NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app.suppliers (
 id varchar(40) PRIMARY KEY, name varchar(200) NOT NULL UNIQUE, phone varchar(30), address varchar(300)
);
CREATE TABLE IF NOT EXISTS app.materials (
 id varchar(40) PRIMARY KEY, code varchar(50) NOT NULL UNIQUE, name varchar(200) NOT NULL UNIQUE,
 category varchar(100) NOT NULL, unit varchar(30) NOT NULL, standard_price decimal(18,2) NOT NULL DEFAULT 0 CHECK(standard_price>=0),
 allowed_loss_percent decimal(8,4) NOT NULL DEFAULT 0 CHECK(allowed_loss_percent>=0),
 supplier_id varchar(40) NULL REFERENCES app.suppliers(id), description text,
 status varchar(20) NOT NULL DEFAULT 'active' CHECK(status IN ('active','pending','inactive')),
 deactivation_reason varchar(500), created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app.branch_stock (
 branch_id varchar(40) NOT NULL REFERENCES app.branches(id), material_id varchar(40) NOT NULL REFERENCES app.materials(id),
 quantity decimal(18,4) NOT NULL DEFAULT 0 CHECK(quantity>=0), updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT pk_branch_stock PRIMARY KEY(branch_id,material_id)
);
CREATE TABLE IF NOT EXISTS app.branch_thresholds (
 branch_id varchar(40) NOT NULL REFERENCES app.branches(id), material_id varchar(40) NOT NULL REFERENCES app.materials(id),
 minimum_quantity decimal(18,4) NOT NULL DEFAULT 0 CHECK(minimum_quantity>=0),
 CONSTRAINT pk_branch_thresholds PRIMARY KEY(branch_id,material_id)
);
CREATE TABLE IF NOT EXISTS app.recipes (
 id varchar(40) PRIMARY KEY, code varchar(50) NOT NULL UNIQUE, name varchar(200) NOT NULL,
 category varchar(100) NOT NULL, sale_price decimal(18,2) NOT NULL DEFAULT 0 CHECK(sale_price>=0),
 status varchar(30) NOT NULL DEFAULT 'active', current_version_id varchar(40) NULL, note text, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app.recipe_versions (
 id varchar(40) PRIMARY KEY, recipe_id varchar(40) NOT NULL REFERENCES app.recipes(id), version_no int NOT NULL,
 status varchar(30) NOT NULL CHECK(status IN ('pending','active','superseded','rejected')),
 created_by varchar(40) NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 approved_by varchar(40) NULL REFERENCES app.users(id), approved_at timestamptz NULL, note text,
 CONSTRAINT uq_recipe_version UNIQUE(recipe_id,version_no)
);
CREATE TABLE IF NOT EXISTS app.recipe_ingredients (
 version_id varchar(40) NOT NULL REFERENCES app.recipe_versions(id), material_id varchar(40) NOT NULL REFERENCES app.materials(id),
 quantity decimal(18,4) NOT NULL CHECK(quantity>0), CONSTRAINT pk_recipe_ingredients PRIMARY KEY(version_id,material_id)
);
CREATE TABLE IF NOT EXISTS app.import_slips (
 id varchar(40) PRIMARY KEY, code varchar(40) NOT NULL UNIQUE, branch_id varchar(40) NOT NULL REFERENCES app.branches(id),
 supplier_id varchar(40) NULL REFERENCES app.suppliers(id), creator_id varchar(40) NOT NULL REFERENCES app.users(id),
 expected_date date, status varchar(30) NOT NULL, note text, rejection_reason varchar(500),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app.import_items (
 slip_id varchar(40) NOT NULL REFERENCES app.import_slips(id), material_id varchar(40) NOT NULL REFERENCES app.materials(id),
 planned_quantity decimal(18,4) NOT NULL CHECK(planned_quantity>0), unit_price decimal(18,2) NOT NULL DEFAULT 0 CHECK(unit_price>=0),
 received_good_quantity decimal(18,4) NOT NULL DEFAULT 0, CONSTRAINT pk_import_items PRIMARY KEY(slip_id,material_id)
);
CREATE TABLE IF NOT EXISTS app.import_receipts (
 id varchar(40) PRIMARY KEY, slip_id varchar(40) NOT NULL REFERENCES app.import_slips(id), received_by varchar(40) NOT NULL REFERENCES app.users(id),
 received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, idempotency_key varchar(100) NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS app.import_receipt_items (
 receipt_id varchar(40) NOT NULL REFERENCES app.import_receipts(id), material_id varchar(40) NOT NULL REFERENCES app.materials(id),
 received_quantity decimal(18,4) NOT NULL CHECK(received_quantity>=0), defect_quantity decimal(18,4) NOT NULL DEFAULT 0 CHECK(defect_quantity>=0),
 defect_reason varchar(500), CONSTRAINT pk_import_receipt_items PRIMARY KEY(receipt_id,material_id),
 CONSTRAINT ck_receipt_defect CHECK(defect_quantity<=received_quantity)
);
CREATE TABLE IF NOT EXISTS app.export_slips (
 id varchar(40) PRIMARY KEY, code varchar(40) NOT NULL UNIQUE, branch_id varchar(40) NOT NULL REFERENCES app.branches(id),
 target_branch_id varchar(40) NULL REFERENCES app.branches(id), creator_id varchar(40) NOT NULL REFERENCES app.users(id),
 type varchar(30) NOT NULL, status varchar(30) NOT NULL, reason varchar(500) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app.export_items (
 slip_id varchar(40) NOT NULL REFERENCES app.export_slips(id), material_id varchar(40) NOT NULL REFERENCES app.materials(id),
 requested_quantity decimal(18,4) NOT NULL CHECK(requested_quantity>0), actual_quantity decimal(18,4),
 unit_cost decimal(18,2) NOT NULL DEFAULT 0, CONSTRAINT pk_export_items PRIMARY KEY(slip_id,material_id)
);
CREATE TABLE IF NOT EXISTS app.stocktakes (
 id varchar(40) PRIMARY KEY, code varchar(40) NOT NULL UNIQUE, branch_id varchar(40) NOT NULL REFERENCES app.branches(id),
 creator_id varchar(40) NOT NULL REFERENCES app.users(id), status varchar(30) NOT NULL DEFAULT 'draft',
 note text, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS app.stocktake_items (
 stocktake_id varchar(40) NOT NULL REFERENCES app.stocktakes(id), material_id varchar(40) NOT NULL REFERENCES app.materials(id),
 system_quantity decimal(18,4) NOT NULL, actual_quantity decimal(18,4) NULL CHECK(actual_quantity>=0),
 difference_reason varchar(500), CONSTRAINT pk_stocktake_items PRIMARY KEY(stocktake_id,material_id)
);
CREATE TABLE IF NOT EXISTS app.sales_imports (
 id varchar(40) PRIMARY KEY, branch_id varchar(40) NOT NULL REFERENCES app.branches(id), period varchar(50) NOT NULL,
 imported_by varchar(40) NOT NULL REFERENCES app.users(id), imported_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 file_name varchar(255), CONSTRAINT uq_sales_period UNIQUE(branch_id,period)
);
CREATE TABLE IF NOT EXISTS app.sales_items (
 import_id varchar(40) NOT NULL REFERENCES app.sales_imports(id), recipe_id varchar(40) NOT NULL REFERENCES app.recipes(id),
 recipe_version_id varchar(40) NULL REFERENCES app.recipe_versions(id), quantity int NOT NULL CHECK(quantity>=0),
 unit_price decimal(18,2) NOT NULL DEFAULT 0, CONSTRAINT pk_sales_items PRIMARY KEY(import_id,recipe_id)
);
CREATE TABLE IF NOT EXISTS app.approval_requests (
 id varchar(40) PRIMARY KEY, type varchar(40) NOT NULL, action varchar(30) NOT NULL,
 reference_id varchar(40) NOT NULL, branch_id varchar(40) NULL REFERENCES app.branches(id),
 requester_id varchar(40) NOT NULL REFERENCES app.users(id), payload text, reason varchar(500),
 status varchar(20) NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reviewed_by varchar(40) NULL REFERENCES app.users(id), reviewed_at timestamptz NULL, review_note varchar(500)
);
CREATE TABLE IF NOT EXISTS app.stock_movements (
 id varchar(40) PRIMARY KEY, branch_id varchar(40) NOT NULL REFERENCES app.branches(id), material_id varchar(40) NOT NULL REFERENCES app.materials(id),
 delta decimal(18,4) NOT NULL, balance_after decimal(18,4) NOT NULL, source_type varchar(40) NOT NULL,
 source_id varchar(40) NOT NULL, source_line_id varchar(100) NOT NULL, created_by varchar(40) NOT NULL REFERENCES app.users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT uq_movement_source UNIQUE(source_type,source_line_id)
);
CREATE TABLE IF NOT EXISTS app.audit_logs (
 id varchar(40) PRIMARY KEY, actor_id varchar(40) NULL REFERENCES app.users(id), action varchar(80) NOT NULL,
 entity_type varchar(50) NOT NULL, entity_id varchar(40) NOT NULL, before_json text, after_json text,
 reason varchar(500), created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
