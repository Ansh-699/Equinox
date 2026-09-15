# Worker

The Worker exposes market registry, ingestion and snapshot/stream endpoints.
D1 stores durable market projections; Durable Objects fan out sequence-bearing
events. Secrets are bindings, never response fields. Scheduled reconciliation,
leases and dead-letter processing use the projection tables added in migration
0003.
