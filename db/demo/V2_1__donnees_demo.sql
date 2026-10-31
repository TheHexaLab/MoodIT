-- ============================================================================
--  V2.1 — Données de DÉMO (dev, e2e, CI) : jamais en prod
-- ============================================================================
-- Chargées par Flyway seulement quand db/demo fait partie de FLYWAY_LOCATIONS (compose de dev et
-- e2e). Une nouvelle donnée de démo liée à une migration Vn s'ajoute en Vn_1__… dans ce dossier.

 -- questions d'un quiz dans l'ordre + cascade quiz_id

-- TRIGGER
-- (Retiré) L'email est désormais saisi par l'utilisateur à l'inscription et
-- conservé tel quel : il ne doit plus être dérivé du username, afin que le
-- username puisse différer de l'email utilisé pour se connecter.

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
  ('Démo MCP — cours moyen',                   'MCP150');   -- canal d'annonces : un par cours, seul le personnel publie

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
  (1,  3, 10);             -- 6 → coding

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

-- ============================================================
--  Démo MCP — deux cours contrastés pour l'analyse de cours.
--  Le score MCP dépend de 3 signaux : nb de quiz, nb de messages de forum,
--  nb d'étudiants inscrits.
--    MCP100 (actif)   : 8 quiz + 40 messages + 3 inscrits  → BONNE note.
--    MCP200 (inactif) : aucun quiz/message, aucun inscrit  → MAUVAISE note.
-- ============================================================

-- Rendre les deux cours visibles par l'admin : l'analyse MCP est réservée aux
-- administrateurs, et l'admin doit être abonné à un programme contenant le cours
-- (cf. autorisation canSeeCourse : program_course ↔ User_Program).
INSERT INTO program_course (program_id, course_id) VALUES
  (1, (SELECT id FROM Course WHERE code = 'MCP100')),
  (1, (SELECT id FROM Course WHERE code = 'MCP200'));

-- Abonner l'admin (user 1) au programme GIN (1) pour qu'il voie ces cours.
INSERT INTO User_Program (program_id, user_id) VALUES (1, 1);

-- Abonner mich (user 3) au programme GIN (1) aussi.
INSERT INTO User_Program (program_id, user_id) VALUES (1, 3);

-- ---- MCP100 (bonne note) : 3 inscrits, 10 quiz, ~22 messages avec de VRAIS avis,
-- un quiz de code tenté (≈78% de cas de test) et un quiz auto-corrigé tenté (67% de moyenne).
-- De quoi laisser l'agent MCP juger le RESSENTI (messages) et la RÉUSSITE (quiz + code). ----

INSERT INTO Enrollment (course_id, user_id)
SELECT (SELECT id FROM Course WHERE code = 'MCP100'), s.u
FROM (VALUES (1), (2), (3)) AS s(u);

INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id)
SELECT 'Quiz ' || g, FALSE, TRUE, FALSE, g,
       (SELECT id FROM Course WHERE code = 'MCP100')
FROM generate_series(1, 8) AS g;

-- Messages de forum réalistes (avis positifs ET négatifs) pour l'analyse du ressenti.
INSERT INTO Post (content, forum_id, user_id, is_pinned)
SELECT m.content,
       (SELECT f.id FROM Forum f
        WHERE f.course_id = (SELECT id FROM Course WHERE code = 'MCP100')
          AND f.f_type_id = 1),
       m.uid,
       FALSE
FROM (VALUES
   ('Franchement le cours est super clair, les explications aident vraiment à comprendre.', 2),
   ('Les quiz hebdomadaires sont parfaits pour réviser, j''adore ce format.', 3),
   ('Les exemples de code en classe sont très concrets, ça aide énormément.', 2),
   ('Merci pour la rétroaction rapide sur le forum, ça change tout.', 1),
   ('Le rythme est bien dosé, on a le temps d''assimiler la matière.', 3),
   ('J''ai enfin compris les boucles grâce aux exercices, vraiment top.', 2),
   ('La correction automatique des quiz est super pratique.', 3),
   ('Un des meilleurs cours du trimestre, bravo pour l''organisation.', 2),
   ('J''apprécie qu''on puisse refaire les quiz pour s''améliorer.', 3),
   ('Le forum est actif, on obtient de l''aide rapidement.', 1),
   ('Merci pour la disponibilité, ça motive à travailler.', 3),
   ('Les rétroactions détaillées sur mes réponses m''aident à progresser.', 2),
   ('Par contre les délais des travaux sont trop serrés, j''ai du mal à suivre.', 2),
   ('Le dernier quiz était beaucoup plus dur que les précédents, c''était déstabilisant.', 3),
   ('La section sur la récursivité va trop vite à mon goût.', 1),
   ('La charge de travail est un peu lourde cette semaine.', 2),
   ('Certains énoncés d''exercices manquent de précision.', 3),
   ('Un peu plus d''exemples pratiques seraient les bienvenus.', 2),
   ('Est-ce qu''on peut avoir un exemple supplémentaire sur les dictionnaires ?', 3),
   ('À quelle heure a lieu la séance de révision svp ?', 2),
   ('Le lien du quiz 3 fonctionne bien de mon côté.', 1),
   ('Bonne organisation générale, mais la dernière semaine était chargée.', 3)
) AS m(content, uid);

-- Quiz noté avec une question de CODE + 3 cas de test, tenté par les 3 étudiants.
-- Résultats semés : user 1 → 3/3, users 2 et 3 → 2/3 (échec du 3e test) = 7/9 ≈ 78%.
INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id)
VALUES ('Quiz noté — exercice de code', FALSE, TRUE, FALSE, 9,
        (SELECT id FROM Course WHERE code = 'MCP100'));

INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
VALUES ('Écris une fonction somme(a, b) qui renvoie la somme de deux entiers.',
        (SELECT id FROM Language WHERE name = 'Python'),
        'def somme(a, b):' || chr(10) || '    pass', 0, 3, 6,
        (SELECT id FROM Quiz WHERE title = 'Quiz noté — exercice de code'
                             AND course_id = (SELECT id FROM Course WHERE code = 'MCP100')));

-- Le harnais Python doit RENVOYER un booléen (contrat : verdict = bool(harnais())) ; un `assert`
-- renverrait None → toujours faux même sur une bonne réponse. Cf. CodeAssembler.assemblePython.
INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT 'Test ' || g, 'return somme(1, 2) == 3', 1,
       (SELECT id FROM Question
        WHERE q_type_id = 6
          AND quiz_id = (SELECT id FROM Quiz WHERE title = 'Quiz noté — exercice de code'
                                             AND course_id = (SELECT id FROM Course WHERE code = 'MCP100')))
FROM generate_series(1, 3) AS g;

INSERT INTO Attempt (quiz_id, user_id, attempt_no)
SELECT (SELECT id FROM Quiz WHERE title = 'Quiz noté — exercice de code'
                            AND course_id = (SELECT id FROM Course WHERE code = 'MCP100')), s.u, 1
FROM (VALUES (1), (2), (3)) AS s(u);

INSERT INTO Submission (content, attempt_id, question_id, user_id)
SELECT 'def somme(a, b): return a + b', a.id,
       (SELECT id FROM Question WHERE q_type_id = 6 AND quiz_id = a.quiz_id),
       a.user_id
FROM Attempt a
WHERE a.quiz_id = (SELECT id FROM Quiz WHERE title = 'Quiz noté — exercice de code'
                                       AND course_id = (SELECT id FROM Course WHERE code = 'MCP100'));

INSERT INTO Submission_Test_Case (submission_id, test_case_id, passed)
SELECT sub.id, tc.id,
       CASE WHEN sub.uid = 1 THEN TRUE       -- user 1 réussit les 3 tests
            WHEN tc.rnk = 3 THEN FALSE        -- users 2 et 3 échouent le 3e
            ELSE TRUE END
FROM (SELECT s.id, s.user_id AS uid
      FROM Submission s JOIN Attempt a ON a.id = s.attempt_id
      WHERE a.quiz_id = (SELECT id FROM Quiz WHERE title = 'Quiz noté — exercice de code'
                                             AND course_id = (SELECT id FROM Course WHERE code = 'MCP100'))) sub
CROSS JOIN (SELECT id, row_number() OVER (ORDER BY id) AS rnk
            FROM Test_Case
            WHERE question_id = (SELECT id FROM Question
                 WHERE q_type_id = 6
                   AND quiz_id = (SELECT id FROM Quiz WHERE title = 'Quiz noté — exercice de code'
                                                      AND course_id = (SELECT id FROM Course WHERE code = 'MCP100')))) tc;

-- Quiz noté AUTO-CORRIGÉ (V/F + choix unique) tenté par les 3 étudiants. Réussite semée :
-- user1 = 2/2 (100%), user2 = 1/2 (50%), user3 = 1/2 (50%) → moyenne = 67%. Core recalcule
-- cette moyenne à la volée (endpoint interne quiz-stats) pour l'analyse MCP.
INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id)
VALUES ('Quiz noté — révision', FALSE, TRUE, FALSE, 10,
        (SELECT id FROM Course WHERE code = 'MCP100'));

INSERT INTO Question (prompt, order_index, total_score, q_type_id, quiz_id)
SELECT p.prompt, p.oidx, 1, p.qtype,
       (SELECT id FROM Quiz WHERE title = 'Quiz noté — révision'
                            AND course_id = (SELECT id FROM Course WHERE code = 'MCP100'))
FROM (VALUES
   ('Une pile (stack) fonctionne selon le principe LIFO.', 0, 1),  -- Vrai/Faux (q_type 1)
   ('Quelle structure suit le principe FIFO ?',            1, 2)   -- Choix unique (q_type 2)
) AS p(prompt, oidx, qtype);

-- Options de la Q1 (Vrai/Faux)
INSERT INTO Answer (content, is_correct, question_id)
SELECT c.content, c.ok,
       (SELECT q.id FROM Question q JOIN Quiz z ON z.id = q.quiz_id
        WHERE z.title = 'Quiz noté — révision'
          AND z.course_id = (SELECT id FROM Course WHERE code = 'MCP100') AND q.order_index = 0)
FROM (VALUES ('Vrai', TRUE), ('Faux', FALSE)) AS c(content, ok);

-- Options de la Q2 (Choix unique)
INSERT INTO Answer (content, is_correct, question_id)
SELECT c.content, c.ok,
       (SELECT q.id FROM Question q JOIN Quiz z ON z.id = q.quiz_id
        WHERE z.title = 'Quiz noté — révision'
          AND z.course_id = (SELECT id FROM Course WHERE code = 'MCP100') AND q.order_index = 1)
FROM (VALUES ('File (queue)', TRUE), ('Pile (stack)', FALSE), ('Arbre binaire', FALSE)) AS c(content, ok);

INSERT INTO Attempt (quiz_id, user_id, attempt_no)
SELECT (SELECT id FROM Quiz WHERE title = 'Quiz noté — révision'
                            AND course_id = (SELECT id FROM Course WHERE code = 'MCP100')), s.u, 1
FROM (VALUES (1), (2), (3)) AS s(u);

-- Soumissions (content = JSON SubmittedAnswerDTO {"answerIds":[id]}). Pour chaque (user, question,
-- correct?), on choisit un id de réponse dont is_correct correspond au flag.
INSERT INTO Submission (content, attempt_id, question_id, user_id)
SELECT '{"answerIds":[' || ans.id || ']}', att.id, q.id, att.user_id
FROM (VALUES
   (1, 0, TRUE), (1, 1, TRUE),    -- user 1 : les deux bonnes  → 100%
   (2, 0, TRUE), (2, 1, FALSE),   -- user 2 : Q1 bonne, Q2 fausse → 50%
   (3, 0, FALSE), (3, 1, TRUE)    -- user 3 : Q1 fausse, Q2 bonne → 50%
) AS s(uid, oidx, correct)
JOIN Quiz z ON z.title = 'Quiz noté — révision'
           AND z.course_id = (SELECT id FROM Course WHERE code = 'MCP100')
JOIN Question q ON q.quiz_id = z.id AND q.order_index = s.oidx
JOIN Attempt att ON att.quiz_id = z.id AND att.user_id = s.uid AND att.attempt_no = 1
JOIN LATERAL (
    SELECT a.id FROM Answer a
    WHERE a.question_id = q.id AND a.is_correct = s.correct
    ORDER BY a.id LIMIT 1
) ans ON TRUE;

-- ---- MCP200 (mauvaise note) : volontairement VIDE ----
-- Ses deux forums (auto-créés plus haut) restent sans message ; aucun quiz,
-- aucun inscrit → l'analyse ne trouve que des axes d'amélioration.

-- ============================================================
--  Démo MCP — cours MOYEN (MCP150) : signaux TIÈDES → score attendu en zone « warning »
--  (50-69%, front). 6 quiz (dont 1 auto-corrigé à ~67% de moyenne), ~9 messages d'avis
--  MITIGÉS et ÉQUILIBRÉS (positif/neutre/négatif), 3 inscrits. Calibré pour que le LLM
--  (qwen2.5) lise « moyen », pas seulement le repli déterministe qui donnait 59.
--  NB : le score LLM n'est pas déterministe (température 0.2) → il peut osciller de
--  quelques points d'une analyse à l'autre.
-- ============================================================

INSERT INTO program_course (program_id, course_id) VALUES
  (1, (SELECT id FROM Course WHERE code = 'MCP150'));

INSERT INTO Enrollment (course_id, user_id)
SELECT (SELECT id FROM Course WHERE code = 'MCP150'), s.u
FROM (VALUES (1), (2), (3)) AS s(u);

-- 5 quiz génériques (pour le compte de quiz — signal « contenu » moyen, pas famélique).
INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id)
SELECT 'Quiz ' || g, FALSE, TRUE, FALSE, g, (SELECT id FROM Course WHERE code = 'MCP150')
FROM generate_series(1, 5) AS g;

-- Messages de forum MITIGÉS (ni enthousiastes ni catastrophés).
INSERT INTO Post (content, forum_id, user_id, is_pinned)
SELECT m.content,
       (SELECT f.id FROM Forum f
        WHERE f.course_id = (SELECT id FROM Course WHERE code = 'MCP150') AND f.f_type_id = 1),
       m.uid, FALSE
FROM (VALUES
   ('Le cours est plutôt bien structuré et le prof reste disponible.', 1),
   ('Les quiz aident vraiment à réviser, j''ai senti une progression.', 2),
   ('Bonne ambiance générale, le contenu est correct dans l''ensemble.', 3),
   ('J''apprécie les retours du prof sur les exercices.', 1),
   ('Ça va, sans plus, j''attends de voir la suite.', 3),
   ('Les délais sont serrés mais gérables.', 2),
   ('Les explications manquent parfois de clarté sur les points avancés.', 2),
   ('Le rythme est un peu rapide par moments.', 3),
   ('On manque d''exemples concrets sur certains sujets.', 2)
) AS m(content, uid);

-- Quiz auto-corrigé « Quiz noté — mi-parcours » : moyenne 50% (chacun 1/2).
INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id)
VALUES ('Quiz noté — mi-parcours', FALSE, TRUE, FALSE, 6,
        (SELECT id FROM Course WHERE code = 'MCP150'));

INSERT INTO Question (prompt, order_index, total_score, q_type_id, quiz_id)
SELECT p.prompt, p.oidx, 1, p.qtype,
       (SELECT id FROM Quiz WHERE title = 'Quiz noté — mi-parcours'
                            AND course_id = (SELECT id FROM Course WHERE code = 'MCP150'))
FROM (VALUES
   ('Un tableau permet un accès direct par indice.', 0, 1),  -- Vrai/Faux
   ('Quelle est la complexité de la recherche binaire ?', 1, 2)  -- Choix unique
) AS p(prompt, oidx, qtype);

INSERT INTO Answer (content, is_correct, question_id)
SELECT c.content, c.ok,
       (SELECT q.id FROM Question q JOIN Quiz z ON z.id = q.quiz_id
        WHERE z.title = 'Quiz noté — mi-parcours'
          AND z.course_id = (SELECT id FROM Course WHERE code = 'MCP150') AND q.order_index = 0)
FROM (VALUES ('Vrai', TRUE), ('Faux', FALSE)) AS c(content, ok);

INSERT INTO Answer (content, is_correct, question_id)
SELECT c.content, c.ok,
       (SELECT q.id FROM Question q JOIN Quiz z ON z.id = q.quiz_id
        WHERE z.title = 'Quiz noté — mi-parcours'
          AND z.course_id = (SELECT id FROM Course WHERE code = 'MCP150') AND q.order_index = 1)
FROM (VALUES ('O(log n)', TRUE), ('O(n)', FALSE), ('O(n²)', FALSE)) AS c(content, ok);

INSERT INTO Attempt (quiz_id, user_id, attempt_no)
SELECT (SELECT id FROM Quiz WHERE title = 'Quiz noté — mi-parcours'
                            AND course_id = (SELECT id FROM Course WHERE code = 'MCP150')), s.u, 1
FROM (VALUES (1), (2), (3)) AS s(u);

INSERT INTO Submission (content, attempt_id, question_id, user_id)
SELECT '{"answerIds":[' || ans.id || ']}', att.id, q.id, att.user_id
FROM (VALUES
   (1, 0, TRUE), (1, 1, TRUE),     -- user 1 : 2/2 → 100%
   (2, 0, TRUE), (2, 1, FALSE),    -- user 2 : 1/2 → 50%
   (3, 0, FALSE), (3, 1, TRUE)     -- user 3 : 1/2 → 50% (moyenne = 4/6 ≈ 67%)
) AS s(uid, oidx, correct)
JOIN Quiz z ON z.title = 'Quiz noté — mi-parcours'
           AND z.course_id = (SELECT id FROM Course WHERE code = 'MCP150')
JOIN Question q ON q.quiz_id = z.id AND q.order_index = s.oidx
JOIN Attempt att ON att.quiz_id = z.id AND att.user_id = s.uid AND att.attempt_no = 1
JOIN LATERAL (
    SELECT a.id FROM Answer a
    WHERE a.question_id = q.id AND a.is_correct = s.correct
    ORDER BY a.id LIMIT 1
) ans ON TRUE;

-- ============================================================
--  Démo — Questions de CODE (multi-langages) : quiz prêt à l'emploi pour tester le bouton
--  « Tester » et le bouton « play » (exécution Piston) sur les 11 langages exécutables. UNE
--  question par langage, même tâche : doubler(n) renvoie 2 × n (identifiant valide partout —
--  on évite « double », mot-clé réservé). Attaché à GIF201. start_code = squelette ; on écrit
--  la solution dans l'onglet Tester. Chaque question a 2 harnais (retour booléen).
-- ============================================================
INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id)
VALUES ('Démo — Questions de code (multi-langages)', FALSE, TRUE, TRUE, 20,
        (SELECT id FROM Course WHERE code = 'GIF201'));

INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
SELECT v.prompt, (SELECT id FROM Language WHERE name = v.lang), v.start_code, v.oidx, 2, 6, q.id
FROM (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                          AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')) q,
(VALUES
   ('Python', 'Implémente doubler(n) qui renvoie le double de n.', 0,
    $sc$def doubler(n):
    pass
$sc$),
   ('JavaScript', 'Implémente doubler(n) qui renvoie le double de n.', 1,
    $sc$function doubler(n) {
  // à compléter
}
$sc$),
   ('TypeScript', 'Implémente doubler(n) qui renvoie le double de n.', 2,
    $sc$function doubler(n: number): number {
  // à compléter
  return 0;
}
$sc$),
   ('PHP', 'Implémente doubler(n) qui renvoie le double de n.', 3,
    $sc$<?php
function doubler($n) {
  // à compléter
}
$sc$),
   ('Bash', 'Implémente doubler qui écrit le double de son 1er argument.', 4,
    $sc$#!/usr/bin/env bash
doubler() {
  # à compléter
  echo 0
}
$sc$),
   ('Go', 'Implémente doubler(n) qui renvoie le double de n.', 5,
    $sc$package main

import "fmt"

func doubler(n int) int {
    // à compléter
    return 0
}

func main() {
    fmt.Println(doubler(5))
}
$sc$),
   ('Rust', 'Implémente doubler(n) qui renvoie le double de n.', 6,
    $sc$fn doubler(n: i32) -> i32 {
    // à compléter
    0
}

fn main() {
    println!("{}", doubler(5));
}
$sc$),
   ('C', 'Implémente doubler(n) qui renvoie le double de n.', 7,
    $sc$#include <stdio.h>

int doubler(int n) {
    // à compléter
    return 0;
}

int main(void) {
    printf("%d\n", doubler(5));
    return 0;
}
$sc$),
   ('C++', 'Implémente doubler(n) qui renvoie le double de n.', 8,
    $sc$#include <iostream>

int doubler(int n) {
    // à compléter
    return 0;
}

int main() {
    std::cout << doubler(5) << std::endl;
    return 0;
}
$sc$),
   ('C#', 'Implémente doubler(n) qui renvoie le double de n.', 9,
    $sc$using System;

class Solution {
    public static int doubler(int n) {
        // à compléter
        return 0;
    }

    static void Main() {
        Console.WriteLine(doubler(5));
    }
}
$sc$),
   ('Java', 'Implémente doubler(n) qui renvoie le double de n.', 10,
    $sc$public class Solution {
    public static int doubler(int n) {
        // à compléter
        return 0;
    }

    public static void main(String[] args) {
        System.out.println(doubler(5));
    }
}
$sc$)
) AS v(lang, prompt, oidx, start_code);

INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT v.name, v.hc, v.w, qn.id
FROM (VALUES
   (0, 'double de 5',   $h$return doubler(5) == 10$h$, 1),
   (0, 'négatif',       $h$return doubler(-3) == -6$h$, 1),
   (1, 'double de 5',   $h$return doubler(5) === 10;$h$, 1),
   (1, 'négatif',       $h$return doubler(-3) === -6;$h$, 1),
   (2, 'double de 5',   $h$return doubler(5) === 10;$h$, 1),
   (2, 'négatif',       $h$return doubler(-3) === -6;$h$, 1),
   (3, 'double de 5',   $h$return doubler(5) === 10;$h$, 1),
   (3, 'négatif',       $h$return doubler(-3) === -6;$h$, 1),
   (4, 'double de 5',   $h$[ "$(doubler 5)" = "10" ]$h$, 1),
   (4, 'négatif',       $h$[ "$(doubler -3)" = "-6" ]$h$, 1),
   (5, 'double de 5',   $h$return doubler(5) == 10$h$, 1),
   (5, 'négatif',       $h$return doubler(-3) == -6$h$, 1),
   (6, 'double de 5',   $h$doubler(5) == 10$h$, 1),
   (6, 'négatif',       $h$doubler(-3) == -6$h$, 1),
   (7, 'double de 5',   $h$return doubler(5) == 10;$h$, 1),
   (7, 'négatif',       $h$return doubler(-3) == -6;$h$, 1),
   (8, 'double de 5',   $h$return doubler(5) == 10;$h$, 1),
   (8, 'négatif',       $h$return doubler(-3) == -6;$h$, 1),
   (9, 'double de 5',   $h$return Solution.doubler(5) == 10;$h$, 1),
   (9, 'négatif',       $h$return Solution.doubler(-3) == -6;$h$, 1),
   (10, 'double de 5',  $h$return Solution.doubler(5) == 10;$h$, 1),
   (10, 'négatif',      $h$return Solution.doubler(-3) == -6;$h$, 1)
) AS v(oidx, name, hc, w)
JOIN Question qn ON qn.order_index = v.oidx
                 AND qn.quiz_id = (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                                                       AND course_id = (SELECT id FROM Course WHERE code = 'GIF201'));

-- ── Questions ORIENTÉES OBJET (POO) : classe/struct Rectangle(largeur, hauteur) + méthode aire().
-- Ajoutées au même quiz démo (ordre 11-19). Uniquement les langages POO (ni C ni Bash). Le harnais
-- instancie la classe étudiante et vérifie son aire. Validé end-to-end sur les 9 langages.
INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
SELECT v.prompt, (SELECT id FROM Language WHERE name = v.lang), v.start_code, v.oidx, 2, 6, q.id
FROM (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                          AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')) q,
(VALUES
   ('Python', 'POO : implémente Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 11,
    $sc$class Rectangle:
    def __init__(self, largeur, hauteur):
        # à compléter
        pass

    def aire(self):
        # à compléter
        pass
$sc$),
   ('JavaScript', 'POO : implémente Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 12,
    $sc$class Rectangle {
  constructor(largeur, hauteur) {
    // à compléter
  }
  aire() {
    // à compléter
  }
}
$sc$),
   ('TypeScript', 'POO : implémente Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 13,
    $sc$class Rectangle {
  constructor(private largeur: number, private hauteur: number) {}

  aire(): number {
    // à compléter
    return 0;
  }
}
$sc$),
   ('PHP', 'POO : implémente Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 14,
    $sc$<?php
class Rectangle {
  public function __construct($largeur, $hauteur) {
    // à compléter
  }
  public function aire() {
    // à compléter
  }
}
$sc$),
   ('Go', 'POO : implémente le type Rectangle (struct) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 15,
    $sc$package main

import "fmt"

type Rectangle struct {
    largeur, hauteur int
}

func (r Rectangle) aire() int {
    // à compléter
    return 0
}

func main() {
    fmt.Println(Rectangle{3, 4}.aire())
}
$sc$),
   ('Rust', 'POO : implémente le type Rectangle (struct) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 16,
    $sc$struct Rectangle {
    largeur: i32,
    hauteur: i32,
}

impl Rectangle {
    fn aire(&self) -> i32 {
        // à compléter
        0
    }
}

fn main() {
    let r = Rectangle { largeur: 3, hauteur: 4 };
    println!("{}", r.aire());
}
$sc$),
   ('C++', 'POO : implémente la classe Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 17,
    $sc$#include <iostream>

class Rectangle {
    int largeur, hauteur;
public:
    Rectangle(int largeur, int hauteur) : largeur(largeur), hauteur(hauteur) {}
    int aire() {
        // à compléter
        return 0;
    }
};

int main() {
    std::cout << Rectangle(3, 4).aire() << std::endl;
    return 0;
}
$sc$),
   ('C#', 'POO : implémente la classe Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 18,
    $sc$using System;

class Rectangle {
    int largeur, hauteur;
    public Rectangle(int largeur, int hauteur) { this.largeur = largeur; this.hauteur = hauteur; }
    public int aire() {
        // à compléter
        return 0;
    }
}

class Program {
    static void Main() {
        Console.WriteLine(new Rectangle(3, 4).aire());
    }
}
$sc$),
   ('Java', 'POO : implémente la classe Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 19,
    $sc$public class Rectangle {
    private int largeur, hauteur;

    public Rectangle(int largeur, int hauteur) {
        this.largeur = largeur;
        this.hauteur = hauteur;
    }

    public int aire() {
        // à compléter
        return 0;
    }

    public static void main(String[] args) {
        System.out.println(new Rectangle(3, 4).aire());
    }
}
$sc$)
) AS v(lang, prompt, oidx, start_code);

INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT v.name, v.hc, v.w, qn.id
FROM (VALUES
   (11, 'aire 3x4',  $h$return Rectangle(3, 4).aire() == 12$h$, 1),
   (11, 'carré 5x5', $h$return Rectangle(5, 5).aire() == 25$h$, 1),
   (12, 'aire 3x4',  $h$return new Rectangle(3, 4).aire() === 12;$h$, 1),
   (12, 'carré 5x5', $h$return new Rectangle(5, 5).aire() === 25;$h$, 1),
   (13, 'aire 3x4',  $h$return new Rectangle(3, 4).aire() === 12;$h$, 1),
   (13, 'carré 5x5', $h$return new Rectangle(5, 5).aire() === 25;$h$, 1),
   (14, 'aire 3x4',  $h$return (new Rectangle(3, 4))->aire() === 12;$h$, 1),
   (14, 'carré 5x5', $h$return (new Rectangle(5, 5))->aire() === 25;$h$, 1),
   (15, 'aire 3x4',  $h$r := Rectangle{largeur: 3, hauteur: 4}
return r.aire() == 12$h$, 1),
   (15, 'carré 5x5', $h$r := Rectangle{largeur: 5, hauteur: 5}
return r.aire() == 25$h$, 1),
   (16, 'aire 3x4',  $h$let r = Rectangle { largeur: 3, hauteur: 4 };
r.aire() == 12$h$, 1),
   (16, 'carré 5x5', $h$let r = Rectangle { largeur: 5, hauteur: 5 };
r.aire() == 25$h$, 1),
   (17, 'aire 3x4',  $h$return Rectangle(3, 4).aire() == 12;$h$, 1),
   (17, 'carré 5x5', $h$return Rectangle(5, 5).aire() == 25;$h$, 1),
   (18, 'aire 3x4',  $h$return new Rectangle(3, 4).aire() == 12;$h$, 1),
   (18, 'carré 5x5', $h$return new Rectangle(5, 5).aire() == 25;$h$, 1),
   (19, 'aire 3x4',  $h$return new Rectangle(3, 4).aire() == 12;$h$, 1),
   (19, 'carré 5x5', $h$return new Rectangle(5, 5).aire() == 25;$h$, 1)
) AS v(oidx, name, hc, w)
JOIN Question qn ON qn.order_index = v.oidx
                 AND qn.quiz_id = (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                                                       AND course_id = (SELECT id FROM Course WHERE code = 'GIF201'));

-- ── Questions données/requête (JSON, SQL) — ajoutées au même quiz démo (ordre 20-21). JSON :
-- validé par un harnais JS sur `data` (JSON parsé). SQL (lecture seule) : requête exposée comme la
-- vue `solution1` (alias `solution`), le harnais fournit les données et termine par un SELECT
-- booléen. Validé end-to-end.
INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
SELECT v.prompt, (SELECT id FROM Language WHERE name = v.lang), v.start_code, v.oidx, 2, 6, q.id
FROM (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                          AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')) q,
(VALUES
   ('JSON', 'Écris un objet JSON avec une clé nom (chaîne non vide) et une clé age (nombre entier positif).', 20,
    $sc${
  "nom": "",
  "age": 0
}
$sc$),
   ('SQL', 'Sélectionne les noms (colonne nom) des utilisateurs actifs (actif = 1) de la table utilisateurs.', 21,
    $sc$-- La table utilisateurs(nom, actif) est fournie par le test.
SELECT /* à compléter */;
$sc$)
) AS v(lang, prompt, oidx, start_code);

INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT v.name, v.hc, v.w, qn.id
FROM (VALUES
   (20, 'nom = chaîne non vide', $h$return typeof data.nom === 'string' && data.nom.length > 0;$h$, 1),
   (20, 'age = entier positif',  $h$return Number.isInteger(data.age) && data.age > 0;$h$, 1),
   (21, 'actifs seulement',      $h$CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Alice', 1), ('Bob', 0), ('Carol', 1);
-- Ensemble EXACT : colonne « nom » seule, ET la liste triée des noms == noms actifs.
SELECT (SELECT count(*) FROM pragma_table_info('solution')) = 1
   AND (SELECT name FROM pragma_table_info('solution')) = 'nom'
   AND (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM solution ORDER BY nom))
     = (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM utilisateurs WHERE actif = 1 ORDER BY nom));$h$, 1),
   (21, 'données mixtes',        $h$CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Anna', 1), ('Ben', 1), ('Cleo', 1), ('Dan', 0);
SELECT (SELECT count(*) FROM pragma_table_info('solution')) = 1
   AND (SELECT name FROM pragma_table_info('solution')) = 'nom'
   AND (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM solution ORDER BY nom))
     = (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM utilisateurs WHERE actif = 1 ORDER BY nom));$h$, 1),
   (21, 'un seul actif',         $h$CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Zoe', 0), ('Yan', 1);
SELECT (SELECT count(*) FROM pragma_table_info('solution')) = 1
   AND (SELECT name FROM pragma_table_info('solution')) = 'nom'
   AND (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM solution ORDER BY nom))
     = (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM utilisateurs WHERE actif = 1 ORDER BY nom));$h$, 1)
) AS v(oidx, name, hc, w)
JOIN Question qn ON qn.order_index = v.oidx
                 AND qn.quiz_id = (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                                                       AND course_id = (SELECT id FROM Course WHERE code = 'GIF201'));

-- ── Questions vues/markup (HTML, JSX, TSX) — ordre 22-24. HTML : harnais JS sur `doc` (DOM parsé
-- via parseur embarqué) ; JSX/TSX : composant rendu en HTML (`html`) via React/Babel embarqués.
-- Validé end-to-end.
INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
SELECT v.prompt, (SELECT id FROM Language WHERE name = v.lang), v.start_code, v.oidx, 2, 6, q.id
FROM (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                          AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')) q,
(VALUES
   ('HTML', 'Crée une page avec un titre h1 contenant « Bonjour » et un lien a vers https://exemple.com.', 22,
    $sc$<!DOCTYPE html>
<html lang="fr">
  <head><meta charset="utf-8" /><title></title></head>
  <body>
    <!-- à compléter : un <h1> et un <a> -->
  </body>
</html>
$sc$),
   ('JSX', 'Complète Composant pour rendre un h1 contenant « Bonjour ».', 23,
    $sc$function Composant() {
  return (
    <div>{/* à compléter */}</div>
  );
}
$sc$),
   ('TSX', 'Complète Composant (TSX) pour rendre, dans un span, la somme de 2 et 3.', 24,
    $sc$function Composant(): JSX.Element {
  return (
    <div>{/* à compléter */}</div>
  );
}
$sc$)
) AS v(lang, prompt, oidx, start_code);

INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT v.name, v.hc, v.w, qn.id
FROM (VALUES
   (22, 'titre h1 = Bonjour',    $h$return doc.querySelector('h1')?.textContent.trim() === 'Bonjour';$h$, 1),
   (22, 'lien vers exemple.com', $h$return doc.querySelector('a')?.getAttribute('href') === 'https://exemple.com';$h$, 1),
   (23, 'rend h1 Bonjour',       $h$return html.includes('<h1>Bonjour</h1>');$h$, 1),
   (24, 'somme dans span',       $h$return html.includes('<span>5</span>');$h$, 1)
) AS v(oidx, name, hc, w)
JOIN Question qn ON qn.order_index = v.oidx
                 AND qn.quiz_id = (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                                                       AND course_id = (SELECT id FROM Course WHERE code = 'GIF201'));

-- ── Question INTERACTIVE (compteur React) — ordre 25. Montre mount()/click() : le harnais monte le
-- composant dans un DOM (happy-dom), clique et vérifie que l'état React a changé. Validé end-to-end.
INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
SELECT v.prompt, (SELECT id FROM Language WHERE name = v.lang), v.start_code, v.oidx, 2, 6, q.id
FROM (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                          AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')) q,
(VALUES
   ('JSX', 'Interactif : écris Composant, un bouton affichant un compteur (départ 0) incrémenté à chaque clic.', 25,
    $sc$function Composant() {
  // Astuce : const [n, setN] = React.useState(0);
  return (
    <button>{/* à compléter : afficher le compteur, +1 au clic */}</button>
  );
}
$sc$)
) AS v(lang, prompt, oidx, start_code);

INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT v.name, v.hc, v.w, qn.id
FROM (VALUES
   (25, 'départ à 0',         $h$const c = mount(Composant);
return c.querySelector('button').textContent.trim() === '0';$h$, 1),
   (25, 'incrémente au clic', $h$const c = mount(Composant);
const btn = c.querySelector('button');
click(btn);
if (btn.textContent.trim() !== '1') return false;
click(btn);
return btn.textContent.trim() === '2';$h$, 1)
) AS v(oidx, name, hc, w)
JOIN Question qn ON qn.order_index = v.oidx
                 AND qn.quiz_id = (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                                                       AND course_id = (SELECT id FROM Course WHERE code = 'GIF201'));

-- ── Question SQL de MODIFICATION (UPDATE) — ordre 26. Exécution ISOLÉE en 2 phases : le code
-- étudiant s'exécute dans un bac à sable jetable, puis un noteur séparé recharge l'état final et
-- vérifie. Le harnais place « -- @student » entre les données de départ et le SELECT de verdict.
INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
SELECT v.prompt, (SELECT id FROM Language WHERE name = v.lang), v.start_code, v.oidx, 2, 6, q.id
FROM (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                          AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')) q,
(VALUES
   ('SQL', 'Désactive tous les utilisateurs : mets actif = 0 pour toutes les lignes de la table utilisateurs.', 26,
    $sc$-- La table utilisateurs(nom, actif) est fournie par le test (données de départ).
-- Écris l'instruction UPDATE qui désactive tous les utilisateurs.
UPDATE utilisateurs SET /* à compléter */;
$sc$)
) AS v(lang, prompt, oidx, start_code);

-- Chaque harnais vérifie l'état COMPLET (nombre de lignes CONSERVÉ *et* TOUTES inactives), sur un
-- jeu de données DIFFÉRENT : seule une vraie instruction UPDATE globale passe les trois. Un DELETE
-- (lignes perdues), un SET actif = 1, un UPDATE partiel ou un SET actif = NULL échoue partout — plus
-- de crédit partiel accidentel. Le code étudiant tourne isolé ; le verdict lit l'état final rechargé.
INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT v.name, v.hc, v.w, qn.id
FROM (VALUES
   (26, 'trois utilisateurs',   $h$CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Alice', 1), ('Bob', 1), ('Carol', 1);
-- @student
SELECT (SELECT count(*) FROM utilisateurs) = 3
   AND (SELECT count(*) FROM utilisateurs WHERE actif = 0) = 3;$h$, 1),
   (26, 'données mixtes',       $h$CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Alice', 1), ('Bob', 0), ('Carol', 1), ('Dan', 1);
-- @student
SELECT (SELECT count(*) FROM utilisateurs) = 4
   AND (SELECT count(*) FROM utilisateurs WHERE actif = 0) = 4;$h$, 1),
   (26, 'un seul utilisateur',  $h$CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Zoe', 1);
-- @student
SELECT (SELECT count(*) FROM utilisateurs) = 1
   AND (SELECT count(*) FROM utilisateurs WHERE actif = 0) = 1;$h$, 1)
) AS v(oidx, name, hc, w)
JOIN Question qn ON qn.order_index = v.oidx
                 AND qn.quiz_id = (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                                                       AND course_id = (SELECT id FROM Course WHERE code = 'GIF201'));

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

