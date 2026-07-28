-- ============================================================================
--  Migration PROD — Hachage des codes (2FA / vérification email / reset)
-- ============================================================================
-- init.sql ne s'exécute que sur une BD VIERGE (premier `docker volume`). Sur une base
-- déjà peuplée, appliquer CE script UNE FOIS avant de déployer la nouvelle image auth-service.
--
-- Contexte : les codes à 6 chiffres ne sont plus stockés en clair mais sous forme de HMAC-SHA256
-- keyé par le pepper (44 caractères en Base64). Les colonnes `verification_code` / `reset_code`,
-- initialement en VARCHAR(6), doivent être élargies, sinon toute écriture d'un code haché échoue
-- (« value too long for type character varying(6) ») → login / register / reset cassés.
--
--   psql "$DATABASE_URL" -f migrations/2026-07-14_hash_codes.sql
--
-- Aucune donnée existante n'est perdue. Script IDEMPOTENT (réexécutable : élargir une colonne
-- déjà en VARCHAR(64) est un no-op sans erreur). Les éventuels codes en clair déjà stockés
-- restent inoffensifs : ils ne matcheront plus la comparaison HMAC et seront écrasés au prochain
-- envoi de code (nouvelle connexion / « mot de passe oublié »).

ALTER TABLE user_                ALTER COLUMN verification_code TYPE VARCHAR(64);
ALTER TABLE user_                ALTER COLUMN reset_code        TYPE VARCHAR(64);
ALTER TABLE pending_registration ALTER COLUMN verification_code TYPE VARCHAR(64);
