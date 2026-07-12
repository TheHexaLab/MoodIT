-- ============================================================================
--  Migration PROD — Journal d'audit (feature « journalisation des actions de gestion »)
-- ============================================================================
-- init.sql ne s'exécute que sur une BD VIERGE (premier `docker volume`). Sur une base
-- déjà peuplée, appliquer CE script UNE FOIS avant de déployer la nouvelle image core-service
-- (qui tourne en `ddl-auto=validate` → l'entité AuditLog EXIGE la table `audit_log`, sinon le
-- démarrage échoue). Aucune donnée existante n'est touchée. Script IDEMPOTENT (réexécutable).
--
--   psql "$DATABASE_URL" -f migrations/2026-07-12_audit_log.sql
--
-- Rappel : le type d'entité 'ENROLLMENT' et l'auto-inscription du créateur sont purement
-- applicatifs (aucune migration de schéma requise pour eux).

-- Requis par les index GIN trigram (recherche LIKE '%…%' indexable).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS Audit_Log(
   id SERIAL,
   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
   actor_email VARCHAR(256),
   action VARCHAR(48) NOT NULL,
   entity_type VARCHAR(24) NOT NULL,
   entity_id INTEGER,
   summary VARCHAR(512) NOT NULL,
   details VARCHAR(1024),
   PRIMARY KEY(id)
);

-- Filet : si la table existait déjà sans `details` (déploiement partiel d'une version antérieure).
ALTER TABLE Audit_Log ADD COLUMN IF NOT EXISTS details VARCHAR(1024);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON Audit_Log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON Audit_Log(entity_type, entity_id);
-- fastupdate=off : index GIN sans pending list → immédiatement à jour après écriture (cf. init.sql).
CREATE INDEX IF NOT EXISTS idx_audit_log_summary_trgm ON Audit_Log USING gin (lower(summary) gin_trgm_ops) WITH (fastupdate = off);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_trgm ON Audit_Log USING gin (lower(actor_email) gin_trgm_ops) WITH (fastupdate = off);
CREATE INDEX IF NOT EXISTS idx_audit_log_details_trgm ON Audit_Log USING gin (lower(details) gin_trgm_ops) WITH (fastupdate = off);
