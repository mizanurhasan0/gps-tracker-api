-- Runs only when the official PostgreSQL image initializes an empty volume.
\getenv app_password APP_DB_PASSWORD
CREATE ROLE gps_tracker LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE gps_tracker OWNER gps_tracker;
