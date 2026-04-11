-- Intentionally malformed SQL
CREATE TABLE valid_table (id INT PRIMARY KEY);

CRATE TABL broken_syntax (
  this is not valid sql at all
);

CREATE TABLE another_valid (name VARCHAR(100));
