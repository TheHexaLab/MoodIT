CREATE TABLE Establishment(
   id SERIAL,
   name VARCHAR(128) NOT NULL,
   domain_email VARCHAR(256) NOT NULL UNIQUE,
   PRIMARY KEY(id),
   CONSTRAINT chk_domain_email CHECK (domain_email ~ '^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')
);

-- Établissements autorisés à s'inscrire (domaine email).
INSERT INTO Establishment (name, domain_email)
VALUES ('Université de Sherbrooke', 'usherbrooke.ca')
ON CONFLICT (domain_email) DO NOTHING;

CREATE TABLE Program(
   id SERIAL,
   name VARCHAR(128) NOT NULL,
   code VARCHAR(128) NOT NULL,
   cohort VARCHAR(128) NOT NULL,
   color VARCHAR(9) NOT NULL DEFAULT '#0a5cc0',
   establishment_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(establishment_id) REFERENCES Establishment(id) ON DELETE CASCADE,
   CONSTRAINT uq_program_code_cohort_establishment UNIQUE (code, cohort, establishment_id)
);

CREATE TABLE User_(
   id SERIAL,
   username VARCHAR(64) NOT NULL UNIQUE,
   first_name VARCHAR(128) NOT NULL,
   last_name VARCHAR(128) NOT NULL,
   email VARCHAR(256) NOT NULL UNIQUE,
   settings TEXT,
   avatar_color VARCHAR(9) NOT NULL DEFAULT '#0a5cc0',
   active_token_hash VARCHAR(256) ,
   password_hash VARCHAR(256) NOT NULL,
   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
   verification_code VARCHAR(6),
   verification_code_expires_at TIMESTAMP,
   verification_attempts INTEGER NOT NULL DEFAULT 0,
   last_code_sent_at TIMESTAMP,
   verification_locked_until TIMESTAMP,
   failed_login_attempts INTEGER NOT NULL DEFAULT 0,
   login_locked_until TIMESTAMP,
   PRIMARY KEY(id)
);

-- Inscriptions en attente de vérification d'email : rien n'entre dans User_
-- tant que le code n'est pas confirmé (anti-flooding de la table des comptes).
CREATE TABLE Pending_Registration(
   id SERIAL,
   username VARCHAR(64) NOT NULL UNIQUE,
   first_name VARCHAR(128) NOT NULL,
   last_name VARCHAR(128) NOT NULL,
   email VARCHAR(256) NOT NULL UNIQUE,
   password_hash VARCHAR(256) NOT NULL,
   verification_code VARCHAR(6),
   verification_code_expires_at TIMESTAMP,
   resend_count INTEGER NOT NULL DEFAULT 0,
   verification_attempts INTEGER NOT NULL DEFAULT 0,
   last_code_sent_at TIMESTAMP,
   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
   PRIMARY KEY(id)
);

CREATE TABLE Role(
   id SERIAL,
   name VARCHAR(128) NOT NULL UNIQUE,
   PRIMARY KEY(id)
);

CREATE TABLE Course(
   id SERIAL,
   title VARCHAR(128) NOT NULL,
   code VARCHAR(128) NOT NULL,
   PRIMARY KEY(id)
);

CREATE TABLE Enrollment(
   id SERIAL,
   enrolled_at TIMESTAMP NOT NULL DEFAULT NOW(),
   course_id INTEGER NOT NULL,
   user_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   UNIQUE(user_id, course_id),
   FOREIGN KEY(course_id) REFERENCES Course(id) ON DELETE CASCADE,
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE
);

CREATE TABLE F_Type(
   id SERIAL,
   name VARCHAR(256) NOT NULL UNIQUE,
   PRIMARY KEY(id)
);

CREATE TABLE Quiz(
   id SERIAL,
   title VARCHAR(128) NOT NULL,
   is_daily BOOLEAN NOT NULL DEFAULT FALSE,
   is_published BOOLEAN NOT NULL DEFAULT FALSE,
   -- L'étudiant peut-il refaire le quiz (tentatives multiples) ?
   allow_retry BOOLEAN NOT NULL DEFAULT FALSE,
   -- Ordre d'affichage dans la section Quiz d'un cours (réordonnable par l'enseignant).
   -- Même rôle que Forum.position / Question.order_index.
   position INTEGER NOT NULL DEFAULT 0,
   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
   course_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(course_id) REFERENCES Course(id) ON DELETE CASCADE
);

CREATE TABLE Q_Type(
   id SERIAL,
   name VARCHAR(128) NOT NULL UNIQUE,
   PRIMARY KEY(id)
);

CREATE TABLE Forum(
   id SERIAL,
   title VARCHAR(128) NOT NULL,
   f_type_id INTEGER NOT NULL,
   course_id INTEGER NOT NULL,
   position INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(f_type_id) REFERENCES F_Type(id),
   FOREIGN KEY(course_id) REFERENCES Course(id) ON DELETE CASCADE
);

CREATE TABLE Post(
   id SERIAL,
   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
   content TEXT NOT NULL,
   -- Titre d'un sujet racine de forum 'Thread' (NULL pour une réponse / message de canal).
   title VARCHAR(256),
   forum_id INTEGER NOT NULL,
   user_id INTEGER NOT NULL,
   post_parent_id INTEGER,
   is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
   PRIMARY KEY(id),
   FOREIGN KEY(forum_id) REFERENCES Forum(id) ON DELETE CASCADE,
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE,
   FOREIGN KEY(post_parent_id) REFERENCES Post(id) ON DELETE CASCADE
);

CREATE TABLE Vote(
   id SERIAL,
   value_ INTEGER NOT NULL,
   quiz_id INTEGER,
   user_id INTEGER NOT NULL,
   post_id INTEGER,
   PRIMARY KEY(id),
   UNIQUE(user_id, post_id),
   UNIQUE(user_id, quiz_id),
   CHECK(value_ IN (-1, 1)),
   CHECK((post_id IS NOT NULL AND quiz_id IS NULL) OR (post_id IS NULL AND quiz_id IS NOT NULL)),
   FOREIGN KEY(quiz_id) REFERENCES Quiz(id) ON DELETE CASCADE,
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE,
   FOREIGN KEY(post_id) REFERENCES Post(id) ON DELETE CASCADE
);

CREATE TABLE Language(
   id SERIAL,
   name VARCHAR(64) NOT NULL UNIQUE,
   harness_template TEXT ,
   start_code_template TEXT ,
   -- Langage dans lequel sont ecrits les harnais des questions utilisant CE langage
   -- (peut differer du langage du code etudiant ; ex. enonce en pseudocode, harnais
   -- en Python). NULL = harnais dans le meme langage que la question.
   harness_language_id INTEGER ,
   PRIMARY KEY(id),
   FOREIGN KEY(harness_language_id) REFERENCES Language(id)
);

CREATE TABLE Question(
   id SERIAL,
   prompt TEXT NOT NULL,
   language_id INTEGER ,
   start_code TEXT ,
   order_index INTEGER,
   total_score INTEGER NOT NULL,
   q_type_id INTEGER NOT NULL,
   quiz_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(language_id) REFERENCES Language(id),
   FOREIGN KEY(q_type_id) REFERENCES Q_Type(id),
   FOREIGN KEY(quiz_id) REFERENCES Quiz(id) ON DELETE CASCADE
);

CREATE TABLE Test_Case(
   id SERIAL,
   name VARCHAR(128) NOT NULL,
   harness_code TEXT NOT NULL,
   weight INTEGER NOT NULL DEFAULT 1,
   question_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(question_id) REFERENCES Question(id) ON DELETE CASCADE
);

CREATE TABLE Answer(
   id SERIAL,
   content VARCHAR(512) NOT NULL,
   is_correct BOOLEAN NOT NULL DEFAULT FALSE,
   question_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(question_id) REFERENCES Question(id) ON DELETE CASCADE
);

CREATE TABLE Drag_Item(
   id SERIAL,
   content VARCHAR(256) NOT NULL,
   correct_order INTEGER NOT NULL,
   group_name VARCHAR(128) ,
   question_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(question_id) REFERENCES Question(id) ON DELETE CASCADE
);

-- Une TENTATIVE de quiz par un utilisateur (regroupe les soumissions de la tentative).
-- `attempt_no` = 1, 2, … par (quiz, user). Les tentatives multiples ne sont possibles
-- que si Quiz.allow_retry = TRUE (contrôlé côté service).
CREATE TABLE Attempt(
   id SERIAL,
   quiz_id INTEGER NOT NULL,
   user_id INTEGER NOT NULL,
   attempt_no INTEGER NOT NULL,
   submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
   PRIMARY KEY(id),
   UNIQUE(quiz_id, user_id, attempt_no),
   FOREIGN KEY(quiz_id) REFERENCES Quiz(id) ON DELETE CASCADE,
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE
);

-- La réponse soumise est conservée (content) ; le score n'est PAS stocké : il est
-- recalculé dynamiquement à partir du quiz courant (cf. QuizService).
CREATE TABLE Submission(
   id SERIAL,
   content TEXT,
   submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
   attempt_id INTEGER NOT NULL,
   question_id INTEGER NOT NULL,
   user_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   -- Une seule soumission par (tentative, question).
   UNIQUE(attempt_id, question_id),
   FOREIGN KEY(attempt_id) REFERENCES Attempt(id) ON DELETE CASCADE,
   FOREIGN KEY(question_id) REFERENCES Question(id) ON DELETE CASCADE,
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE
);

-- Detail de correction d'une soumission de CODE : verdict (passe/echoue) par
-- harnais. Permet d'afficher en revision quels Test_Case ont reussi/echoue, sans
-- re-executer le code. Une ligne par (soumission, harnais).
CREATE TABLE Submission_Test_Case(
   submission_id INTEGER NOT NULL,
   test_case_id INTEGER NOT NULL,
   passed BOOLEAN NOT NULL,
   PRIMARY KEY(submission_id, test_case_id),
   FOREIGN KEY(submission_id) REFERENCES Submission(id) ON DELETE CASCADE,
   FOREIGN KEY(test_case_id) REFERENCES Test_Case(id) ON DELETE CASCADE
);

-- Feedback généré par le service MCP sur un COURS (points forts/faibles).
-- Rattaché au cours analysé ; user_id = l'enseignant qui a déclenché l'analyse.
-- Historique conservé : une ligne par analyse (tri par created_at).
-- status : 'pending' (job en cours), 'done' (analyse disponible), 'failed' (échec du job).
-- content NULL tant que le job n'a pas produit de résultat (pending/failed).
CREATE TABLE MCP_Response(
   id SERIAL,
   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
   content TEXT,
   -- Défaut 'pending' (état logique d'une ligne fraîchement insérée). Le service pose
   -- toujours le statut explicitement ; ce défaut protège un INSERT manuel oublié.
   status VARCHAR(16) NOT NULL DEFAULT 'pending',
   user_id INTEGER NOT NULL,
   course_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE,
   FOREIGN KEY(course_id) REFERENCES Course(id) ON DELETE CASCADE
);

-- Verrou « une seule analyse en cours par (cours, utilisateur) » : rend la garde de
-- tentative unique ATOMIQUE (deux POST concurrents → le 2e viole l'index → 409).
CREATE UNIQUE INDEX uq_mcp_response_pending ON MCP_Response(course_id, user_id) WHERE status = 'pending';

CREATE TABLE User_Program(
   program_id INTEGER,
   user_id INTEGER,
   PRIMARY KEY(program_id, user_id),
   FOREIGN KEY(program_id) REFERENCES Program(id) ON DELETE CASCADE,
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE
);

CREATE TABLE User_Role(
   user_id INTEGER,
   role_id INTEGER,
   PRIMARY KEY(user_id, role_id),
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE,
   FOREIGN KEY(role_id) REFERENCES Role(id) ON DELETE CASCADE
);

CREATE TABLE program_course(
   program_id INTEGER,
   course_id INTEGER,
   PRIMARY KEY(program_id, course_id),
   FOREIGN KEY(program_id) REFERENCES Program(id) ON DELETE CASCADE,
   FOREIGN KEY(course_id) REFERENCES Course(id) ON DELETE CASCADE
);

CREATE TABLE User_Program_Role(
   program_id INTEGER,
   user_id INTEGER,
   role_id INTEGER,
   PRIMARY KEY(program_id, user_id, role_id),
   FOREIGN KEY(program_id) REFERENCES Program(id) ON DELETE CASCADE,
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE,
   FOREIGN KEY(role_id) REFERENCES Role(id) ON DELETE CASCADE
);

-- Indexes simples sur les colonnes de cles etrangeres (non auto-indexees par PostgreSQL).
-- Les PK et contraintes UNIQUE creent deja leur propre index : non repetes ici.
-- Les FK couvertes par un index composite ci-dessous ne sont pas redoublees ici.
CREATE INDEX idx_program_establishment_id ON Program(establishment_id);
CREATE INDEX idx_enrollment_course_id ON Enrollment(course_id);
CREATE INDEX idx_forum_f_type_id ON Forum(f_type_id);
CREATE INDEX idx_forum_course_id ON Forum(course_id);
CREATE INDEX idx_post_user_id ON Post(user_id);
CREATE INDEX idx_question_q_type_id ON Question(q_type_id);
CREATE INDEX idx_question_language_id ON Question(language_id);
CREATE INDEX idx_test_case_question_id ON Test_Case(question_id);
CREATE INDEX idx_language_harness_language_id ON Language(harness_language_id);
CREATE INDEX idx_answer_question_id ON Answer(question_id);
CREATE INDEX idx_drag_item_question_id ON Drag_Item(question_id);
CREATE INDEX idx_submission_question_id ON Submission(question_id);
CREATE INDEX idx_submission_attempt_id ON Submission(attempt_id);
-- (user_id est deja couvert par la 1re colonne de l'index UNIQUE(user_id, question_id).)
-- (submission_id est deja couvert par la 1re colonne de la cle primaire composite.)
CREATE INDEX idx_submission_test_case_test_case_id ON Submission_Test_Case(test_case_id);
CREATE INDEX idx_mcp_response_user_id ON MCP_Response(user_id);
CREATE INDEX idx_mcp_response_course_id ON MCP_Response(course_id);
CREATE INDEX idx_user_program_user_id ON User_Program(user_id);
CREATE INDEX idx_user_role_role_id ON User_Role(role_id);
CREATE INDEX idx_program_course_course_id ON program_course(course_id);
CREATE INDEX idx_user_program_role_user_id ON User_Program_Role(user_id);
CREATE INDEX idx_user_program_role_role_id ON User_Program_Role(role_id);

-- Indexes composites (orientes requetes). La 1re colonne couvre aussi la FK,
-- donc ils remplacent les index simples correspondants (pas de doublon).
CREATE INDEX idx_post_forum_created ON Post(forum_id, created_at); -- liste d'un forum triee par date + cascade forum_id
CREATE INDEX idx_post_parent_created ON Post(post_parent_id, created_at); -- reponses d'un post (fil) ordonnees + cascade self-FK
CREATE INDEX idx_vote_post_value ON Vote(post_id, value_); -- score d'un post (SUM value_) + cascade post_id
CREATE INDEX idx_vote_quiz_value ON Vote(quiz_id, value_); -- score d'un quiz + cascade quiz_id
CREATE INDEX idx_quiz_course_daily ON Quiz(course_id, is_daily); -- "Quiz du jour" d'un cours + cascade course_id
CREATE INDEX idx_quiz_course_position ON Quiz(course_id, position); -- quiz d'un cours dans l'ordre d'affichage
CREATE INDEX idx_question_quiz_order ON Question(quiz_id, order_index); -- questions d'un quiz dans l'ordre + cascade quiz_id

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
INSERT INTO Program (name, code, cohort, color, establishment_id) VALUES
  ('Génie informatique','GIN', '71',  '#1a6e3c', 1),
  ('Génie logiciel',    'GLO', '71',  '#0a5cc0', 1),
  ('Génie électrique',  'GEL', '71',  '#8b1a1a', 1),
  ('Génie mécanique',   'GMC', '71',  '#7a4e1a', 1),
  ('Génie civil',       'GCI', '71',  '#3a3a7a', 1),
  ('Génie chimique',    'GCH', '71',  '#4a7a1a', 1),
  ('Génie de l''environnement',  'GEN', '2024',  '#0a7a6e', 1);

-- ------------------------------------------------------------
-- Role
-- ------------------------------------------------------------
INSERT INTO Role (name) VALUES
  ('Étudiant'),
  ('Enseignant'),
  ('Auxiliaire'),
  ('Administrateur');

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
INSERT INTO User_Role (user_id, role_id) VALUES
  (1, 4);  -- admin (user_id=1) → Administrateur (role_id=4)

INSERT INTO User_Role (user_id, role_id) VALUES
  (2, 1);  -- rosie (user_id=2) → etudiant (role_id=1)

INSERT INTO User_Role (user_id, role_id) VALUES
  (3, 1);  -- mich (user_id=3) → etudiant (role_id=1)

-- ------------------------------------------------------------
-- User_Programme 
-- ------------------------------------------------------------
INSERT INTO User_Program (program_id, user_id) VALUES (1, 2);
-- ------------------------------------------------------------
-- Course  (cours transversaux + spécifiques génie)
-- ------------------------------------------------------------
INSERT INTO Course (title, code) VALUES
  -- Tronc commun
  ('Mathématiques pour ingénieurs I',          'MAT115'),
  ('Mathématiques pour ingénieurs II',         'MAT215'),
  ('Physique pour ingénieurs I',               'PHY115'),
  ('Physique pour ingénieurs II',              'PHY215'),
  ('Chimie pour ingénieurs',                   'CHI105'),
  ('Communication en génie',                   'COM105'),
  ('Éthique et déontologie',                   'ETH105'),
  -- Génie informatique / logiciel
  ('Structures de données et algorithmes',     'GIF201'),
  ('Systèmes d''exploitation',                 'GIF301'),
  ('Réseaux informatiques',                    'GIF401'),
  ('Génie logiciel I',                         'GLO200'),
  ('Génie logiciel II',                        'GLO300'),
  ('Bases de données',                         'GIF501'),
  -- Génie électrique
  ('Circuits électriques I',                   'GEL201'),
  ('Circuits électriques II',                  'GEL301'),
  ('Électronique analogique',                  'GEL401'),
  ('Systèmes de contrôle',                     'GEL501'),
  -- Génie mécanique
  ('Mécanique des solides I',                  'GMC201'),
  ('Mécanique des fluides',                    'GMC301'),
  ('Thermodynamique appliquée',                'GMC401'),
  -- Génie civil
  ('Matériaux de construction',                'GCI201'),
  ('Hydraulique',                              'GCI301'),
  -- Génie chimique
  ('Opérations unitaires I',                   'GCH201'),
  ('Cinétique chimique',                       'GCH301'),
  -- Cours de DÉMO pour l'analyse MCP (feedback de cours). Ils héritent des forums
  -- auto-créés plus bas (un « Discussion » + un « Thread » par cours).
  ('Démo MCP — cours actif',                   'MCP100'),   -- riche → bonne note
  ('Démo MCP — cours inactif',                 'MCP200'),   -- vide → mauvaise note
  ('Démo MCP — cours moyen',                   'MCP150');   -- tiède → zone warning

-- ------------------------------------------------------------
-- F_Type  (types de forum)
-- ------------------------------------------------------------
INSERT INTO F_Type (name) VALUES
  ('Discussion'),
  ('Thread');

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

-- ------------------------------------------------------------
-- program_course  (association programmes ↔ cours)
-- Tronc commun (MAT115,MAT215,PHY115,PHY215,CHI105,COM105,ETH105)
-- attribué à tous les programmes.
-- Cours spécialisés selon le programme.
-- ------------------------------------------------------------

-- Tronc commun pour tous les programmes (ids 1..7 = cours 1..7)
INSERT INTO program_course (program_id, course_id)
SELECT p.id, c.id
FROM Program p, Course c
WHERE c.id BETWEEN 1 AND 7;   -- MAT115 → ETH105

-- GIN (1) : cours info/logiciel + bases communes spécialisées
INSERT INTO program_course (program_id, course_id) VALUES
  (1, 8), (1, 9), (1, 10), (1, 13), (1, 14), (1, 17);

-- GLO (2) : cours logiciel + info
INSERT INTO program_course (program_id, course_id) VALUES
  (2, 8), (2, 11), (2, 12), (2, 13);

-- GEL (3) : circuits + contrôle
INSERT INTO program_course (program_id, course_id) VALUES
  (3, 14), (3, 15), (3, 16), (3, 17);

-- GMC (4) : mécanique + fluides + thermo
INSERT INTO program_course (program_id, course_id) VALUES
  (4, 18), (4, 19), (4, 20);

-- GCI (5) : matériaux + hydraulique
INSERT INTO program_course (program_id, course_id) VALUES
  (5, 21), (5, 22);

-- GCH (6) : opérations unitaires + cinétique
INSERT INTO program_course (program_id, course_id) VALUES
  (6, 23), (6, 24);

-- GEN (7) : partage avec GCI et GCH
INSERT INTO program_course (program_id, course_id) VALUES
  (7, 19), (7, 21), (7, 22), (7, 23);

-- ------------------------------------------------------------
-- Post (quelques posts dans les forums existants)
-- ------------------------------------------------------------
INSERT INTO Post (content, forum_id, user_id, is_pinned) VALUES
  ('Bonjour, est-ce que quelqu''un peut m''expliquer la dérivée en chaîne?', 1, 2, FALSE),  -- post 1
  ('Voici une ressource utile pour MAT115!', 1, 3, TRUE),                                    -- post 2
  ('Je comprends pas les intégrales doubles...', 1, 2, FALSE),                               -- post 3
  ('Question sur les systèmes d''exploitation, comment fonctionne un deadlock?', 9, 3, FALSE), -- post 4
  ('Réponse au deadlock: c''est quand deux processus s''attendent mutuellement.', 9, 2, FALSE); -- post 5

-- Enfants du post 1
INSERT INTO Post (content, forum_id, user_id, post_parent_id, is_pinned) VALUES
  ('C''est une réponse au post 1!', 1, 3, 1, FALSE),           -- post 6
  ('Une deuxième réponse au post 1!', 1, 1, 1, FALSE);         -- post 7

-- Enfants du post 2
INSERT INTO Post (content, forum_id, user_id, post_parent_id, is_pinned) VALUES
  ('Merci pour la ressource, très utile!', 1, 2, 2, FALSE),    -- post 8
  ('Je confirme, excellente ressource!', 1, 1, 2, FALSE),      -- post 9
  ('Est-ce qu''il y a d''autres ressources?', 1, 3, 2, FALSE); -- post 10

-- Enfants du post 3
INSERT INTO Post (content, forum_id, user_id, post_parent_id, is_pinned) VALUES
  ('Moi non plus, on peut étudier ensemble?', 1, 1, 3, FALSE); -- post 11

-- Enfants du post 4
INSERT INTO Post (content, forum_id, user_id, post_parent_id, is_pinned) VALUES
  ('Bonne question, j''ai le même problème.', 9, 2, 4, FALSE), -- post 12
  ('Voici un lien utile sur les deadlocks!', 9, 1, 4, FALSE);  -- post 13

-- Enfant d'un enfant (post 6 → réponse à une réponse)
INSERT INTO Post (content, forum_id, user_id, post_parent_id, is_pinned) VALUES
  ('Je suis d''accord avec toi!', 1, 2, 6, FALSE);             -- post 14

-- ------------------------------------------------------------
-- Vote
-- ------------------------------------------------------------
INSERT INTO Vote (value_, user_id, post_id) VALUES
  (1,  2, 2),   -- rosie +1 post 2
  (1,  3, 2),   -- mich +1 post 2
  (1,  1, 2),   -- admin +1 post 2
  (-1, 3, 1),   -- mich -1 post 1
  (1,  2, 4),   -- rosie +1 post 4
  (-1, 1, 3),   -- admin -1 post 3
  (1,  3, 5),   -- mich +1 post 5
  (1,  1, 6),   -- admin +1 post 6
  (1,  2, 6),   -- rosie +1 post 6
  (-1, 3, 7),   -- mich -1 post 7
  (1,  1, 7),   -- admin +1 post 7
  (1,  1, 8),   -- admin +1 post 8
  (-1, 2, 9),   -- rosie -1 post 9
  (1,  3, 9),   -- mich +1 post 9
  (1,  2, 10),  -- rosie +1 post 10
  (1,  1, 11),  -- admin +1 post 11
  (-1, 3, 12),  -- mich -1 post 12
  (1,  2, 13),  -- rosie +1 post 13
  (1,  3, 14);  -- mich +1 post 14

-- ------------------------------------------------------------
-- Q_Type  (types de question — ordre = mapping vers les slugs front)
-- ------------------------------------------------------------
INSERT INTO Q_Type (name) VALUES
  ('Vrai/Faux'),        -- 1 → true_false
  ('Choix unique'),     -- 2 → single_choice
  ('Choix multiple'),   -- 3 → multiple_choice
  ('Remise en ordre'),  -- 4 → ordering
  ('Association'),       -- 5 → matching
  ('Code');             -- 6 → coding

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
INSERT INTO Language (name) VALUES ('Python') ON CONFLICT (name) DO NOTHING;

INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id)
VALUES ('Quiz noté — exercice de code', FALSE, TRUE, FALSE, 9,
        (SELECT id FROM Course WHERE code = 'MCP100'));

INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
VALUES ('Écris une fonction somme(a, b) qui renvoie la somme de deux entiers.',
        (SELECT id FROM Language WHERE name = 'Python'),
        'def somme(a, b):' || chr(10) || '    pass', 0, 3, 6,
        (SELECT id FROM Quiz WHERE title = 'Quiz noté — exercice de code'
                             AND course_id = (SELECT id FROM Course WHERE code = 'MCP100')));

INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT 'Test ' || g, 'assert somme(1, 2) == 3', 1,
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