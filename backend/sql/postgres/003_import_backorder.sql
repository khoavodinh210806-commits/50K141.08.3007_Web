-- A receipt with outstanding good quantity is waiting for a replacement delivery.
UPDATE app.import_slips AS slip
SET status = 'backorder', updated_at = CURRENT_TIMESTAMP
WHERE slip.status = 'receiving'
  AND EXISTS (SELECT 1 FROM app.import_receipts AS receipt WHERE receipt.slip_id = slip.id)
  AND EXISTS (
    SELECT 1 FROM app.import_items AS item
    WHERE item.slip_id = slip.id AND item.received_good_quantity < item.planned_quantity
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'app.import_slips'::regclass AND conname = 'ck_import_slips_status'
  ) THEN
    ALTER TABLE app.import_slips ADD CONSTRAINT ck_import_slips_status
      CHECK (status IN ('pending_approval', 'approved', 'receiving', 'backorder',
                       'completed', 'rejected', 'cancelled'));
  END IF;
END $$;
