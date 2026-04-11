CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(255));

CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT REFERENCES users(id),
  total DECIMAL(10,2)
);

CREATE TABLE line_items (
  id INT PRIMARY KEY,
  order_id INT REFERENCES orders(id),
  product_id INT,
  quantity INT
);

CREATE TABLE products (id INT PRIMARY KEY, name VARCHAR(255), price DECIMAL(10,2));

CREATE TABLE categories (
  id INT PRIMARY KEY,
  parent_id INT REFERENCES categories(id),
  name VARCHAR(100)
);
