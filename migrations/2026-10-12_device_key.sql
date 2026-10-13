-- ============================================================================
--  Migration PROD — Annuaire des clés d'appareil du vocal chiffré (E2EE)
-- ============================================================================
-- init.sql ne s'exécute que sur une BD VIERGE (premier `docker volume`). Sur une base
-- déjà peuplée, appliquer CE script UNE FOIS avant de déployer la nouvelle image core-service
-- (qui tourne en `ddl-auto=validate` → l'entité DeviceKey EXIGE la table `device_key`, sinon le
-- démarrage échoue).
--
-- Contexte : chaque appareil (profil de navigateur) publie ses clés PUBLIQUES d'identité
-- (ECDSA + ECDH P-256) ; les participants d'un salon vocal s'en servent pour échanger les clés
-- média sans que le serveur ne les connaisse jamais (cf. voice-service/E2EE.md).
--
--   psql "$DATABASE_URL" -f migrations/2026-10-12_device_key.sql
--
-- Aucune donnée existante n'est touchée. Script IDEMPOTENT (réexécutable).

CREATE TABLE IF NOT EXISTS Device_Key(
   id SERIAL,
   user_id INTEGER NOT NULL,
   device_id UUID NOT NULL UNIQUE,
   label VARCHAR(64),               -- libellé d'affichage (ex. « Edge · Windows »), non fiable
   sign_pub TEXT NOT NULL,          -- clé publique ECDSA P-256 (SPKI, Base64)
   dh_pub TEXT NOT NULL,            -- clé publique ECDH P-256 (SPKI, Base64)
   dh_sig TEXT NOT NULL,            -- signature de dh_pub par sign_pub (P1363, Base64)
   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
   revoked_at TIMESTAMP,
   PRIMARY KEY(id),
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_device_key_user ON Device_Key(user_id);
