-- Circular foreign key references
CREATE TABLE departments (
  id INT PRIMARY KEY,
  name VARCHAR(100),
  manager_id INT REFERENCES employees(id)
);

CREATE TABLE employees (
  id INT PRIMARY KEY,
  name VARCHAR(100),
  department_id INT REFERENCES departments(id)
);
