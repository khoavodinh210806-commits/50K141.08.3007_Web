DO $$
DECLARE
  item record;
  highest bigint;
  current_value bigint;
  already_called boolean;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('code_nvl_seq', 'NVL', 'materials', 'code'),
      ('code_mon_seq', 'MON', 'recipes', 'code'),
      ('code_pnk_seq', 'PNK', 'import_slips', 'code'),
      ('code_pxk_seq', 'PXK', 'export_slips', 'code'),
      ('code_pkk_seq', 'PKK', 'stocktakes', 'code'),
      ('code_ct_seq', 'CT', 'approval_requests', 'id'),
      ('code_nvl_dc_seq', 'NVL-DC', 'approval_requests', 'id'),
      ('code_dc_seq', 'DC', 'approval_requests', 'id'),
      ('code_pd_seq', 'PD', 'approval_requests', 'id'),
      ('code_bh_seq', 'BH', 'sales_imports', 'id')
    ) AS codes(sequence_name, prefix, table_name, column_name)
  LOOP
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS app.%I', item.sequence_name);
    EXECUTE format(
      'SELECT COALESCE(MAX(substring(%I FROM %L)::bigint), 0) FROM app.%I WHERE %I ~ %L',
      item.column_name, '^' || item.prefix || '-([0-9]+)$',
      item.table_name, item.column_name, '^' || item.prefix || '-[0-9]+$'
    ) INTO highest;
    EXECUTE format('SELECT last_value, is_called FROM app.%I', item.sequence_name)
      INTO current_value, already_called;
    PERFORM setval(
      format('app.%I', item.sequence_name)::regclass,
      GREATEST(current_value, highest, 1),
      already_called OR highest > 0
    );
  END LOOP;
END $$;
