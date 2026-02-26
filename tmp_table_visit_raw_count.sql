select count(*)::bigint as total_records,
       max(created_at) as latest_created_at,
       max(updated_at) as latest_updated_at
from feishu_generic_records
where table_id = 'tblpx5Efqc6eHo3L';
