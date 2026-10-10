-- Local mirror of Shoptet data. Every table is keyed by store_key, the
-- merchant's store key from FLEXI_STORES. Other modules read these tables:
-- columns may be added later, never renamed or removed.

create table if not exists shoptet_orders (
  store_key text not null,
  code text not null,
  guid text,
  creation_time timestamptz,
  change_time timestamptz,
  status_id integer,
  status_name text,
  paid boolean,
  total_with_vat numeric,
  total_without_vat numeric,
  currency text,
  shipping_method text,
  payment_method text,
  -- false while only the list payload is stored (detail fetch failed);
  -- items and customer rows are then missing or stale until the next sync.
  detail_synced boolean not null default false,
  synced_at timestamptz not null default now(),
  primary key (store_key, code)
);

create index if not exists shoptet_orders_status_change_idx
  on shoptet_orders (store_key, status_id, change_time desc);
create index if not exists shoptet_orders_change_time_idx
  on shoptet_orders (store_key, change_time desc);
create index if not exists shoptet_orders_creation_time_idx
  on shoptet_orders (store_key, creation_time desc);

-- Personal data. Kept apart from shoptet_orders so it can carry a stricter scope.
create table if not exists shoptet_order_customers (
  store_key text not null,
  order_code text not null,
  email text,
  phone text,
  billing_name text,
  billing_company text,
  billing_street text,
  billing_city text,
  billing_zip text,
  billing_country text,
  delivery_name text,
  delivery_company text,
  delivery_street text,
  delivery_city text,
  delivery_zip text,
  delivery_country text,
  synced_at timestamptz not null default now(),
  primary key (store_key, order_code),
  foreign key (store_key, order_code) references shoptet_orders (store_key, code) on delete cascade
);

create table if not exists shoptet_order_items (
  store_key text not null,
  order_code text not null,
  item_id text not null,
  item_type text,
  product_guid text,
  code text,
  name text,
  variant_name text,
  amount numeric,
  -- Row totals (amount already multiplied in), never unit prices.
  line_total_with_vat numeric,
  line_total_without_vat numeric,
  vat_rate numeric,
  primary key (store_key, order_code, item_id),
  foreign key (store_key, order_code) references shoptet_orders (store_key, code) on delete cascade
);

create index if not exists shoptet_order_items_code_idx on shoptet_order_items (store_key, code);
create index if not exists shoptet_order_items_product_guid_idx on shoptet_order_items (store_key, product_guid);

create table if not exists shoptet_order_statuses (
  store_key text not null,
  id integer not null,
  name text not null,
  synced_at timestamptz not null default now(),
  primary key (store_key, id)
);

create table if not exists shoptet_products (
  store_key text not null,
  guid text not null,
  name text,
  visibility text,
  brand text,
  default_category_guid text,
  url text,
  creation_time timestamptz,
  change_time timestamptz,
  synced_at timestamptz not null default now(),
  -- Set when a full pass no longer returned the product. Rows are never deleted.
  deleted_at timestamptz,
  primary key (store_key, guid)
);

create index if not exists shoptet_products_category_idx on shoptet_products (store_key, default_category_guid);

create table if not exists shoptet_product_variants (
  store_key text not null,
  code text not null,
  product_guid text not null,
  name text,
  ean text,
  price_with_vat numeric,
  action_price_with_vat numeric,
  currency text,
  stock numeric,
  -- Availability that applies to the current stock level.
  availability_name text,
  -- Availability Shoptet shows while the variant is in stock.
  availability_in_stock_name text,
  -- Availability Shoptet shows once the variant is sold out.
  availability_sold_out_name text,
  visible boolean,
  image_url text,
  weight numeric,
  synced_at timestamptz not null default now(),
  -- Set when a full pass no longer returned the variant. Rows are never deleted.
  deleted_at timestamptz,
  primary key (store_key, code)
);

create index if not exists shoptet_product_variants_ean_idx on shoptet_product_variants (ean);
create index if not exists shoptet_product_variants_product_idx on shoptet_product_variants (store_key, product_guid);

create table if not exists shoptet_categories (
  store_key text not null,
  guid text not null,
  parent_guid text,
  name text,
  url text,
  visible boolean,
  synced_at timestamptz not null default now(),
  primary key (store_key, guid)
);

create index if not exists shoptet_categories_parent_idx on shoptet_categories (store_key, parent_guid);

create table if not exists shoptet_sync_state (
  store_key text not null,
  resource text not null,
  cursor timestamptz,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (store_key, resource)
);
