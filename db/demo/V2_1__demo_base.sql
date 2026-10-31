-- ============================================================================
--  V2.1 — Démo : établissements, comptes, programme, cours, forums, posts et quiz de base
-- ============================================================================
-- Données de DÉMO (dev, e2e, CI ; jamais en prod). Chargées par Flyway seulement quand db/demo fait
-- partie de FLYWAY_LOCATIONS (compose de dev et e2e, deploy/reset-data.sh).
-- Les autres scripts de démo (V2.2 à V2.4) s'appuient sur celui-ci.

-- Établissements autorisés à s'inscrire (domaine email).
-- Les sous-domaines d'un domaine listé sont aussi acceptés (cf. AuthService.isAllowedDomain).
INSERT INTO Establishment (name, domain_email)
VALUES
   ('Université de Sherbrooke', 'usherbrooke.ca'),
   ('Cégep de Victoriaville', 'cegepvicto.ca')
ON CONFLICT (domain_email) DO NOTHING;

-- ============================================================
--  Données de départ — Application UdeS / Faculté de génie
-- ============================================================

-- ------------------------------------------------------------
-- Program  (programmes de génie offerts à l'UdeS)
-- ------------------------------------------------------------
-- Un seul programme conservé pour la démo (Génie informatique).
INSERT INTO Program (name, code, cohort, color, establishment_id) VALUES
  ('Génie informatique','GIN', '71',  '#1a6e3c', 1);

-- ------------------------------------------------------------
-- User  
-- ------------------------------------------------------------
INSERT INTO User_ (username, first_name, last_name, email, password_hash) VALUES
  ('admin', 'Admin', 'Admin', 'admin@usherbrooke.ca', 'hash.pour.tester');

INSERT INTO User_ (username, first_name, last_name, email, password_hash) VALUES
  ('rosie1234', 'rosie', 'HG', 'rosie1234@usherbrooke.ca', 'hash.pour.tester2');

INSERT INTO User_ (username, first_name, last_name, email, password_hash) VALUES
  ('mich1234', 'mich', 'normand', 'mich1234@usherbrooke.ca', 'hash.pour.tester3');

-- ------------------------------------------------------------
-- User_Role
-- ------------------------------------------------------------
-- Rôles GLOBAUX (User_Role) : rôles PLATEFORME.
--   admin (1) → Superadministrateur (3) : peut nommer/retirer administrateurs généraux ET
--               superadministrateurs. Superset des droits d'admin général.
--   mich  (3) → Administrateur (2)      : administrateur général (peut AJOUTER d'autres admins
--               généraux, mais pas en retirer ; ne peut pas toucher aux superadministrateurs).
-- rosie (2) n'a PAS de rôle global : ses droits viennent de User_Program_Role.
INSERT INTO User_Role (user_id, role_id) VALUES
  (1, 3),
  (3, 2);

-- ------------------------------------------------------------
-- User_Programme 
-- ------------------------------------------------------------
INSERT INTO User_Program (program_id, user_id) VALUES (1, 2);
-- ------------------------------------------------------------
-- Course  (cours transversaux + spécifiques génie)
-- ------------------------------------------------------------
-- Cours conservés pour la démo (ids 1..5 dans l'ordre d'insertion) :
--   1 MAT115 → héberge le quiz « tous les types (sauf code) »
--   2 GIF201 → héberge le quiz « Démo — Questions de code (multi-langages) »
--   3..5     → cours de DÉMO pour l'analyse MCP (actif / inactif / moyen)
INSERT INTO Course (title, code) VALUES
  ('Mathématiques pour ingénieurs I',          'MAT115'),   -- 1
  ('Structures de données et algorithmes',     'GIF201'),   -- 2
  -- Cours de DÉMO pour l'analyse MCP (feedback de cours). Ils héritent des forums
  -- auto-créés plus bas (un « Discussion » + un « Thread » par cours).
  ('Démo MCP — cours actif',                   'MCP100'),   -- 3 riche → bonne note
  ('Démo MCP — cours inactif',                 'MCP200'),   -- 4 vide → mauvaise note
  ('Démo MCP — cours moyen',                   'MCP150');   -- 5 tiède → zone warning

-- ------------------------------------------------------------
-- Forum  (un forum Q&R et un forum Annonces par cours)
-- ------------------------------------------------------------
INSERT INTO Forum (title, f_type_id, course_id, position)
SELECT
    'Discussion — ' || c.title,
    1,   -- Échange libre, un chat
    c.id, 1
FROM Course c;
 
INSERT INTO Forum (title, f_type_id, course_id, position)
SELECT
    'Thread — ' || c.title,
    2,   -- Post + réponses
    c.id, 1
FROM Course c;

-- Canal d'annonces : exactement un par cours (créé aussi à la création d'un cours, côté core).
INSERT INTO Forum (title, f_type_id, course_id, position)
SELECT
    'Annonces',
    3,   -- 'Announcement'
    c.id, 0
FROM Course c;

-- ------------------------------------------------------------
-- program_course  (association programme ↔ cours)
-- GIN (1) ↔ MAT115 (1) et GIF201 (2). Les 3 cours de démo MCP sont ajoutés
-- plus bas, dans leurs sections respectives (par code, robuste aux ids).
-- ------------------------------------------------------------
INSERT INTO program_course (program_id, course_id) VALUES
  (1, 1),   -- GIN ↔ MAT115
  (1, 2);   -- GIN ↔ GIF201

-- ------------------------------------------------------------
-- Post (quelques posts dans les forums existants)
-- ------------------------------------------------------------
-- Tous sur le forum Discussion de MAT115 (forum 1). Les posts de GIF301 ont été retirés
-- avec ce cours ; les ids de post sont donc renumérotés 1..10.
INSERT INTO Post (content, forum_id, user_id, is_pinned) VALUES
  ('Bonjour, est-ce que quelqu''un peut m''expliquer la dérivée en chaîne?', 1, 2, FALSE),  -- post 1
  ('Voici une ressource utile pour MAT115!', 1, 3, TRUE),                                    -- post 2
  ('Je comprends pas les intégrales doubles...', 1, 2, FALSE);                               -- post 3

-- Enfants du post 1
INSERT INTO Post (content, forum_id, user_id, post_parent_id, is_pinned) VALUES
  ('C''est une réponse au post 1!', 1, 3, 1, FALSE),           -- post 4
  ('Une deuxième réponse au post 1!', 1, 1, 1, FALSE);         -- post 5

-- Enfants du post 2
INSERT INTO Post (content, forum_id, user_id, post_parent_id, is_pinned) VALUES
  ('Merci pour la ressource, très utile!', 1, 2, 2, FALSE),    -- post 6
  ('Je confirme, excellente ressource!', 1, 1, 2, FALSE),      -- post 7
  ('Est-ce qu''il y a d''autres ressources?', 1, 3, 2, FALSE); -- post 8

-- Enfant du post 3
INSERT INTO Post (content, forum_id, user_id, post_parent_id, is_pinned) VALUES
  ('Moi non plus, on peut étudier ensemble?', 1, 1, 3, FALSE); -- post 9

-- Enfant d'un enfant (post 4 → réponse à une réponse)
INSERT INTO Post (content, forum_id, user_id, post_parent_id, is_pinned) VALUES
  ('Je suis d''accord avec toi!', 1, 2, 4, FALSE);             -- post 10

-- ------------------------------------------------------------
-- Vote
-- ------------------------------------------------------------
-- post_id remappés après renumérotation des posts (les votes des posts GIF301 retirés).
INSERT INTO Vote (value_, user_id, post_id) VALUES
  (1,  2, 2),   -- rosie +1 post 2
  (1,  3, 2),   -- mich +1 post 2
  (1,  1, 2),   -- admin +1 post 2
  (-1, 3, 1),   -- mich -1 post 1
  (-1, 1, 3),   -- admin -1 post 3
  (1,  1, 4),   -- admin +1 post 4
  (1,  2, 4),   -- rosie +1 post 4
  (-1, 3, 5),   -- mich -1 post 5
  (1,  1, 5),   -- admin +1 post 5
  (1,  1, 6),   -- admin +1 post 6
  (-1, 2, 7),   -- rosie -1 post 7
  (1,  3, 7),   -- mich +1 post 7
  (1,  2, 8),   -- rosie +1 post 8
  (1,  1, 9),   -- admin +1 post 9
  (1,  3, 10);  -- mich +1 post 10

-- ------------------------------------------------------------
-- Enrollment  (rosie inscrite au cours 1 pour voir le quiz)
-- ------------------------------------------------------------
INSERT INTO Enrollment (course_id, user_id) VALUES (1, 2);  -- rosie (user 2) → MAT115 (cours 1)

-- ------------------------------------------------------------
-- Quiz  (un quiz publié dans le cours 1, tous les types sauf le code)
-- ------------------------------------------------------------
INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id) VALUES
  ('Quiz découverte — tous les types (sauf code)', FALSE, TRUE, TRUE, 0, 1);  -- quiz 1 (réessayable)

-- ------------------------------------------------------------
-- Question  (5 questions du quiz 1 : un type chacune, sauf code)
-- ------------------------------------------------------------
INSERT INTO Question (prompt, order_index, total_score, q_type_id, quiz_id) VALUES
  ('Le tri par fusion (merge sort) a une complexité en **O(n log n)** dans le pire cas.', 0, 1, 1, 1),  -- Q1 Vrai/Faux
  ('Quelle structure de données fonctionne en **LIFO** (dernier entré, premier sorti) ?', 1, 1, 2, 1),  -- Q2 Choix unique
  ('Parmi les suivants, lesquels sont des **langages de programmation** ?',               2, 2, 3, 1),  -- Q3 Choix multiple
  ('Remettez dans l''ordre les étapes classiques de compilation d''un programme C.',      3, 2, 4, 1),  -- Q4 Remise en ordre
  ('Associez chaque langage à son **paradigme** dominant.',                               4, 2, 5, 1);  -- Q5 Association

-- ------------------------------------------------------------
-- Answer  (options des questions à choix : Q1, Q2, Q3)
-- ------------------------------------------------------------
INSERT INTO Answer (content, is_correct, question_id) VALUES
  -- Q1 Vrai/Faux
  ('Vrai', TRUE,  1),
  ('Faux', FALSE, 1),
  -- Q2 Choix unique
  ('Pile (stack)',    TRUE,  2),
  ('File (queue)',    FALSE, 2),
  ('Liste chaînée',   FALSE, 2),
  ('Arbre binaire',   FALSE, 2),
  -- Q3 Choix multiple
  ('Python', TRUE,  3),
  ('HTML',   FALSE, 3),
  ('Java',   TRUE,  3),
  ('CSS',    FALSE, 3);

-- ------------------------------------------------------------
-- Drag_Item  (Q4 Remise en ordre : group_name NULL ; Q5 Association : par groupe)
-- ------------------------------------------------------------
INSERT INTO Drag_Item (content, correct_order, group_name, question_id) VALUES
  -- Q4 Remise en ordre (ordre attendu via correct_order)
  ('Prétraitement',     1, NULL, 4),
  ('Compilation',       2, NULL, 4),
  ('Assemblage',        3, NULL, 4),
  ('Édition des liens', 4, NULL, 4),
  -- Q5 Association (catégorie attendue via group_name ; correct_order non utilisé = 0)
  ('Haskell', 0, 'Fonctionnel',    5),
  ('Java',    0, 'Orienté objet',  5),
  ('Prolog',  0, 'Logique',        5),
  ('C',       0, 'Impératif',      5);
