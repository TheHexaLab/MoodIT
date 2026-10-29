-- ============================================================================
--  Migration PROD — Canal d'annonces par cours
-- ============================================================================
-- init.sql ne s'exécute que sur une BD VIERGE (premier `docker volume`). Sur une base
-- déjà peuplée, appliquer CE script UNE FOIS avant de déployer la nouvelle image core-service
-- (qui tourne en `ddl-auto=validate` → l'entité Post EXIGE les colonnes `color` et
-- `expires_at`, sinon le démarrage échoue). Aucune donnée existante n'est touchée.
-- Script IDEMPOTENT (réexécutable).
--
--   psql "$DATABASE_URL" -f migrations/2026-10-28_announcements.sql

-- Type de forum 'Announcement' (core et permission-service le retrouvent par son NOM).
INSERT INTO F_Type (name) VALUES ('Announcement')
ON CONFLICT (name) DO NOTHING;

-- Une annonce : couleur de la palette et date d'expiration (NULL = jamais).
ALTER TABLE Post ADD COLUMN IF NOT EXISTS color VARCHAR(16);
ALTER TABLE Post ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

-- Un canal « Annonces » pour chaque cours existant qui n'en a pas encore.
INSERT INTO Forum (title, f_type_id, course_id, position)
SELECT 'Annonces', t.id, c.id, 0
FROM Course c
JOIN F_Type t ON t.name = 'Announcement'
WHERE NOT EXISTS (
  SELECT 1 FROM Forum f WHERE f.course_id = c.id AND f.f_type_id = t.id
);
