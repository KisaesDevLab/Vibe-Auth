-- Second database for the reference product (the shared-Postgres pattern, D7).
CREATE ROLE ref WITH LOGIN PASSWORD 'ref';
CREATE DATABASE ref OWNER ref;
