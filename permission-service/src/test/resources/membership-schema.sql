-- Schéma MINIMAL pour tester les requêtes SQL natives de MembershipRepository sous H2
-- (mode PostgreSQL). Noms de tables/colonnes IDENTIQUES à init.sql (seules les colonnes
-- réellement lues par les requêtes sont créées). Recréé avant chaque test (DROP + CREATE).

DROP TABLE IF EXISTS user_program_role;
DROP TABLE IF EXISTS user_program;
DROP TABLE IF EXISTS program_course;
DROP TABLE IF EXISTS user_role;
DROP TABLE IF EXISTS mcp_response;
DROP TABLE IF EXISTS vote;
DROP TABLE IF EXISTS post;
DROP TABLE IF EXISTS enrollment;
DROP TABLE IF EXISTS quiz;
DROP TABLE IF EXISTS forum;
DROP TABLE IF EXISTS role;
DROP TABLE IF EXISTS user_;

CREATE TABLE user_ (id INT PRIMARY KEY, email VARCHAR(256));
CREATE TABLE role (id INT PRIMARY KEY, name VARCHAR(128), global_assignable BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE user_role (user_id INT, role_id INT);
CREATE TABLE user_program (program_id INT, user_id INT);
CREATE TABLE user_program_role (program_id INT, user_id INT, role_id INT);
CREATE TABLE program_course (program_id INT, course_id INT);
CREATE TABLE forum (id INT PRIMARY KEY, course_id INT);
CREATE TABLE quiz (id INT PRIMARY KEY, course_id INT);
CREATE TABLE enrollment (id INT PRIMARY KEY, course_id INT, user_id INT);
CREATE TABLE post (id INT PRIMARY KEY, forum_id INT, user_id INT, post_parent_id INT);
CREATE TABLE vote (id INT PRIMARY KEY, user_id INT, post_id INT, quiz_id INT);
CREATE TABLE mcp_response (id INT PRIMARY KEY, user_id INT, course_id INT);
