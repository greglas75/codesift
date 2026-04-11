CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  action VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO audit_log (action) VALUES ('schema_created');

SELECT * FROM audit_log WHERE action = 'schema_created';

UPDATE audit_log SET action = 'migrated' WHERE id = 1;

DELETE FROM audit_log WHERE created_at < '2020-01-01';

CREATE INDEX idx_audit_action ON audit_log(action);
