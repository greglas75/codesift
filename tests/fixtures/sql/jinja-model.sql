{{ config(materialized='table') }}

{% if is_incremental() %}
  -- incremental logic
{% endif %}

CREATE TABLE derived_orders (
  id INT PRIMARY KEY,
  order_date DATE
);

SELECT * FROM {{ ref('orders') }};
