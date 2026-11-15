ALTER TABLE app.materials ADD COLUMN IF NOT EXISTS allowed_loss_quantity decimal(18,4) NOT NULL DEFAULT 0 CHECK (allowed_loss_quantity >= 0);
ALTER TABLE app.stocktake_items ADD COLUMN IF NOT EXISTS remedy varchar(500);
ALTER TABLE app.stocktakes ADD COLUMN IF NOT EXISTS period varchar(20);
ALTER TABLE app.export_slips ADD COLUMN IF NOT EXISTS incident_status varchar(20);
ALTER TABLE app.export_slips ADD COLUMN IF NOT EXISTS incident_reason varchar(500);
ALTER TABLE app.sales_imports ADD COLUMN IF NOT EXISTS period_start date;
ALTER TABLE app.sales_imports ADD COLUMN IF NOT EXISTS period_end date;
CREATE INDEX IF NOT EXISTS ix_sales_import_period_range ON app.sales_imports(branch_id,period_start,period_end);
CREATE TABLE IF NOT EXISTS app.sales_unmatched_items (
 import_id varchar(40) NOT NULL REFERENCES app.sales_imports(id) ON DELETE CASCADE,
 item_code varchar(100) NOT NULL,
 item_name varchar(200),
 quantity int NOT NULL CHECK (quantity >= 0),
 PRIMARY KEY(import_id,item_code)
);
