-- All DDL constructs for testing

CREATE TABLE users (
  id INT PRIMARY KEY,
  name VARCHAR(255)
);

CREATE VIEW active_users AS
SELECT * FROM users WHERE active = true;

CREATE MATERIALIZED VIEW user_stats AS
SELECT count(*) AS total FROM users;

CREATE INDEX idx_users_name ON users(name);

CREATE UNIQUE INDEX idx_users_email ON users(email);

CREATE FUNCTION get_user_count() RETURNS INT
BEGIN
  RETURN (SELECT count(*) FROM users);
END;

CREATE PROCEDURE update_user_status(IN uid INT, IN new_status VARCHAR(50))
BEGIN
  UPDATE users SET status = new_status WHERE id = uid;
END;

CREATE TRIGGER trg_users_updated
AFTER UPDATE ON users
FOR EACH ROW
BEGIN
  INSERT INTO audit_log(table_name, action) VALUES ('users', 'UPDATE');
END;

CREATE SCHEMA inventory;

CREATE TYPE mood AS ENUM ('happy', 'sad', 'neutral');

CREATE SEQUENCE order_seq START WITH 1 INCREMENT BY 1;
