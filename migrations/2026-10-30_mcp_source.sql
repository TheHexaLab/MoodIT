-- ============================================================================
--  Migration PROD — Origine des analyses MCP et verrou des analyses en cours (#32)
-- ============================================================================
-- init.sql ne s'exécute que sur une BD VIERGE (premier `docker volume`). Sur une base
-- déjà peuplée, appliquer CE script UNE FOIS avant de déployer la nouvelle image mcp-service
-- (qui tourne en `ddl-auto=validate` → l'entité McpResponse EXIGE la colonne `source`, sinon
-- le démarrage échoue). Les analyses existantes gardent `source` à NULL (origine inconnue).
-- Script IDEMPOTENT (réexécutable).
--
--   psql "$DATABASE_URL" -f migrations/2026-10-30_mcp_source.sql

-- Origine du contenu : 'LLM' (modèle de langage) ou 'DETERMINISTIC' (repli calculé sans IA).
ALTER TABLE MCP_Response ADD COLUMN IF NOT EXISTS source VARCHAR(16);

-- Verrou « une seule analyse en cours par (cours, utilisateur) » : l'index filtrait sur
-- 'pending' en minuscules alors que le statut est stocké 'PENDING' ; il ne couvrait donc
-- aucune ligne. Avant de le recréer, une seule analyse PENDING est gardée par (cours,
-- utilisateur), la plus récente ; les autres passent en FAILED.
UPDATE MCP_Response r SET status = 'FAILED'
WHERE r.status = 'PENDING'
  AND EXISTS (
    SELECT 1 FROM MCP_Response o
    WHERE o.status = 'PENDING' AND o.course_id = r.course_id AND o.user_id = r.user_id
      AND o.id > r.id
  );
DROP INDEX IF EXISTS uq_mcp_response_pending;
CREATE UNIQUE INDEX uq_mcp_response_pending ON MCP_Response(course_id, user_id) WHERE status = 'PENDING';
