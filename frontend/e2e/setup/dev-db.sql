-- Préparation de la BD de DEV pour les tests Playwright (idempotent, rejouable sans risque).
-- ⚠ DEV UNIQUEMENT : ne jamais appliquer en prod.
--
-- 1. Table Device_Key (vocal chiffré, branche feature/voice-chat-prototype) : absente des migrations
--    Flyway de main (db/migration) tant que le vocal n'y est pas fusionné ; créée ici pour les tests
--    du vocal. Copie de migrations/2026-10-12_device_key.sql de cette branche.
CREATE TABLE IF NOT EXISTS Device_Key(
   id SERIAL,
   user_id INTEGER NOT NULL,
   device_id UUID NOT NULL UNIQUE,
   label VARCHAR(64),
   sign_pub TEXT NOT NULL,
   dh_pub TEXT NOT NULL,
   dh_sig TEXT NOT NULL,
   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
   revoked_at TIMESTAMP,
   PRIMARY KEY(id),
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_device_key_user ON Device_Key(user_id);

-- 2. Domaine des comptes de test : `.test` est un TLD RÉSERVÉ (RFC 2606), jamais routable, donc
--    aucun email ne peut atteindre une vraie personne.
INSERT INTO Establishment (name, domain_email)
SELECT 'MoodIT E2E (dev)', 'e2e.test'
WHERE NOT EXISTS (SELECT 1 FROM Establishment WHERE domain_email = 'e2e.test');

-- 3. Modération vocale : e2e_carol est ENSEIGNANTE du programme de test (1), donc modératrice
--    de ses salons vocaux (e2e/voice/voice-moderation.spec.ts). Sans effet tant que le compte
--    n'existe pas : rejouer ce fichier APRÈS le premier `npm run e2e` (qui crée les comptes).
INSERT INTO User_Program_Role (program_id, user_id, role_id)
SELECT 1, u.id, r.id
FROM User_ u, Role r
WHERE u.email = 'carol@e2e.test' AND r.name = 'Enseignant'
ON CONFLICT DO NOTHING;
