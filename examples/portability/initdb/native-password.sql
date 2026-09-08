-- MySQL 8.4 creates its users with caching_sha2_password, which the MariaDB
-- connector Prisma uses for the `mysql` provider cannot authenticate against.
-- The server is started with the older plugin loaded (see docker-compose.yml);
-- this hands the two users it created over to it.
ALTER USER 'root'@'%' IDENTIFIED WITH mysql_native_password BY 'audit';
ALTER USER 'audit'@'%' IDENTIFIED WITH mysql_native_password BY 'audit';
