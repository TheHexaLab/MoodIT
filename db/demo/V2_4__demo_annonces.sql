-- ============================================================================
--  V2.4 — Démo : annonces du cours MAT115
-- ============================================================================
-- Données de DÉMO (dev, e2e, CI ; jamais en prod). Chargées par Flyway seulement quand db/demo fait
-- partie de FLYWAY_LOCATIONS (compose de dev et e2e, deploy/reset-data.sh).

-- ------------------------------------------------------------
-- Annonces (canal « Annonces » de MAT115)
-- ------------------------------------------------------------
-- Publiées par l'admin (Gardien). Une sans expiration, une expirée (grisée pour le personnel,
-- masquée pour les étudiants) et une qui expire dans une semaine. Insérées en ordre chronologique
-- (la liste est triée par id décroissant). Dates en UTC, comme le reste des posts lus par core.
INSERT INTO Post (title, content, forum_id, user_id, color, expires_at, created_at)
SELECT v.title, v.content, f.id, 1, v.color,
       (NOW() AT TIME ZONE 'UTC') + v.expires_in,
       (NOW() AT TIME ZONE 'UTC') - v.age
FROM (VALUES
  (1, 'Bienvenue dans MAT115 !',
      'Le plan de cours et les notes du chapitre 1 sont dans le forum. Bonne session à tous !',
      'blue', NULL::INTERVAL, INTERVAL '20 days'),
  (2, 'TP 3 : changement de local (cette semaine seulement)',
      'Le TP de mercredi a lieu au **D7-3018** au lieu du D7-2023.',
      'orange', INTERVAL '-2 days', INTERVAL '6 days'),
  (3, 'Examen intra déplacé au jeudi 5 novembre',
      'Même local, même heure. Matière : chapitres 1 à 5 (les intégrales doubles ne sont **pas** à l''examen).',
      'red', INTERVAL '7 days', INTERVAL '2 hours')
) AS v(ord, title, content, color, expires_in, age)
JOIN Forum f ON f.course_id = (SELECT id FROM Course WHERE code = 'MAT115')
            AND f.f_type_id = (SELECT id FROM F_Type WHERE name = 'Announcement')
ORDER BY v.ord;
