CREATE VIEW greeting AS
SELECT * FROM users WHERE name = 'hello;world';

CREATE TABLE after_view (
  id INT PRIMARY KEY
);
