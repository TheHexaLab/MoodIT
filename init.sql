CREATE TABLE Establishment(
   id SERIAL,
   name VARCHAR(128) NOT NULL,
   domain_email VARCHAR(256) NOT NULL UNIQUE,
   PRIMARY KEY(id),
   CONSTRAINT chk_domain_email CHECK (domain_email ~ '^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')
);

-- Établissements autorisés à s'inscrire (domaine email).
-- Les sous-domaines d'un domaine listé sont aussi acceptés (cf. AuthService.isAllowedDomain).
INSERT INTO Establishment (name, domain_email)
VALUES
   ('Université de Sherbrooke', 'usherbrooke.ca'),
   ('Cégep de Victoriaville', 'cegepvicto.ca')
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
   -- Réinitialisation de mot de passe : champs dédiés (séparés de verification_*, qui
   -- servent à la 2FA) pour éviter toute collision entre un code 2FA et un code de reset.
   reset_code VARCHAR(6),
   reset_code_expires_at TIMESTAMP,
   reset_attempts INTEGER NOT NULL DEFAULT 0,
   reset_last_sent_at TIMESTAMP,
   reset_locked_until TIMESTAMP,
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
   -- Portée d'ATTRIBUTION du rôle (pilote quels rôles apparaissent dans quel popup) :
   --   program_assignable : attribuable dans le popup « Gérer les rôles » d'un programme
   --                        (User_Program_Role) — ex. Enseignant, Administrateur.
   --   global_assignable  : attribuable dans le popup de gestion des administrateurs
   --                        (User_Role, rôles PLATEFORME) — ex. Administrateur, Superadministrateur.
   -- Le Superadministrateur est global_assignable = TRUE mais program_assignable = FALSE :
   -- il ne peut donc PAS être donné via le popup d'un programme.
   program_assignable BOOLEAN NOT NULL DEFAULT TRUE,
   global_assignable BOOLEAN NOT NULL DEFAULT FALSE,
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
   total_score NUMERIC(4,1) NOT NULL,   -- score au dixième près (format X.X)
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
-- Rôles (id dans l'ordre d'insertion) :
--   1 Enseignant          — PAR PROGRAMME : gère le contenu (cours/canaux/quiz/forums).
--   2 Administrateur      — PAR PROGRAMME : tout sauf supprimer le programme ; GLOBAL : admin
--                           général de la plateforme (peut supprimer un programme).
--   3 Superadministrateur — GLOBAL uniquement (au-dessus d'Administrateur) : gère qui devient
--                           administrateur général et superadministrateur. NON attribuable dans
--                           le popup d'un programme (program_assignable = FALSE).
INSERT INTO Role (name, program_assignable, global_assignable) VALUES
  ('Enseignant',          TRUE,  FALSE),
  ('Administrateur',      TRUE,  TRUE),
  ('Gardien', FALSE, TRUE);

-- ------------------------------------------------------------
-- User  
-- ------------------------------------------------------------
INSERT INTO User_ (username, first_name, last_name, email, password_hash) VALUES
  ('admin', 'Admin', 'Admin', 'admin@usherbrooke.ca', 'hash.pour.tester');

INSERT INTO User_ (username, first_name, last_name, email, password_hash) VALUES
  ('rosie1234', 'rosie', 'HG', 'rosie1234@usherbrooke.ca', 'hash.pour.tester2');

INSERT INTO User_ (username, first_name, last_name, email, password_hash) VALUES
  ('mich1234', 'mich', 'normand', 'mich1234@usherbrooke.ca', 'hash.pour.tester3');

-- Utilisateurs de TEST en masse (ids 4..43) : de quoi éprouver la pagination (10 par 10) et la
-- recherche serveur du popup de gestion des administrateurs. Prénoms variés pour tester le filtre.
INSERT INTO User_ (username, first_name, last_name, email, password_hash)
SELECT
  'user' || g,
  (ARRAY['Alice','Benoit','Chloé','David','Émilie','Félix','Gabrielle','Hugo','Inès','Jacob',
         'Katia','Louis','Maya','Nathan','Olivia','Pierre','Quentin','Rosalie','Samuel','Thomas'])[1 + (g % 20)],
  (ARRAY['Roy','Gagnon','Tremblay','Côté','Bouchard','Gauthier','Morin','Lavoie','Fortin','Bergeron'])[1 + (g % 10)],
  'user' || g || '@usherbrooke.ca',
  'hash.pour.tester'
FROM generate_series(1, 40) AS g;

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
-- Langages d'exécution (GET /api/languages). start_code_template : squelette montré à
-- l'ÉTUDIANT. harness_template : gabarit du harnais pour le PROF, écrit dans le langage DU
-- HARNAIS (celui de la question, ou son harness_language_id : HTML/JSON/JSX/TSX → JavaScript).
-- Contrat du sandbox rappelé dans chaque en-tête : le harnais RENVOIE un booléen (true = réussi ;
-- une exception/erreur vaut échec) ; le code de l'étudiant y est accessible (point d'entrée
-- solution(), ou contenu parsé pour HTML/JSON/JSX/TSX).
INSERT INTO Language (name, start_code_template, harness_template) VALUES
('Python',
 $sc$# Sandbox : bibliothèque standard complète + numpy, pandas, scipy, sympy (aucun réseau).
def solution():
    # à compléter
    pass
$sc$,
 $hc$# HARNAIS (Python) — exécuté après le code de l'étudiant, dans le même espace de noms.
# Contrat : RENVOIE True (réussi) ou False ; une exception (ex. assert) vaut échec.
# Le point d'entrée de l'étudiant est appelable directement, ex. solution(...).
# Sandbox : bibliothèque standard complète + numpy, pandas, scipy, sympy (aucun réseau).
return solution() == ATTENDU
$hc$),
('JavaScript',
 $sc$// Sandbox : Node.js 20, bibliothèque standard (aucun réseau, aucun paquet npm).
function solution() {
  // à compléter
}
$sc$,
 $hc$// HARNAIS (JavaScript) — exécuté après le code de l'étudiant, dans la même portée.
// Contrat : RENVOIE true (réussi) ou false ; un throw vaut échec.
// Le point d'entrée de l'étudiant est appelable directement, ex. solution(...).
return solution() === ATTENDU;
$hc$),
('TypeScript',
 $sc$// Sandbox : TypeScript 5 transpilé et exécuté sur Node.js 20 ; bibliothèque standard
// (aucun réseau, aucun paquet npm). Le typage est permissif à l'exécution.
function solution(): number {
  // à compléter
  return 0;
}
$sc$,
 $hc$// HARNAIS (TypeScript) — exécuté après le code de l'étudiant, dans la même portée.
// Contrat : RENVOIE true (réussi) ou false ; un throw vaut échec.
// Le point d'entrée de l'étudiant est appelable directement, ex. solution(...).
return solution() === ATTENDU;
$hc$),
('SQL',
 $sc$-- Sandbox : SQLite 3 en mémoire (aucun réseau). Écris une ou plusieurs requêtes (SELECT),
-- séparées par « ; ». Chacune est exposée au harnais comme une vue « solution1 », « solution2 »…
-- (dans l'ordre d'écriture ; « solution » = « solution1 »).
SELECT /* à compléter */;
$sc$,
 $hc$-- HARNAIS (SQL) — exemple prêt à adapter. Les requêtes de l'étudiant sont exposées comme des vues
-- « solution1 », « solution2 »… (« solution » = solution1).

-- Jeu de données de test (sur lequel porte la requête attendue) :
CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Alice', 1), ('Bob', 0), ('Carol', 1);

-- Verdict : TERMINE par UN SELECT booléen (dernière valeur = 1 → réussi ; une erreur SQL = échec).
-- Ici on valide l'ensemble EXACT — la bonne COLONNE et les bonnes LIGNES :
SELECT
      (SELECT count(*) FROM pragma_table_info('solution1')) = 1     -- une seule colonne…
  AND (SELECT name    FROM pragma_table_info('solution1')) = 'nom'  -- …nommée « nom »
  -- exactement les noms actifs, ni plus ni moins (listes triées, séparateur newline non ambigu) :
  AND (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM solution1 ORDER BY nom))
    = (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM utilisateurs WHERE actif = 1 ORDER BY nom));

-- Question de MODIFICATION (UPDATE/DELETE) ? Mets une ligne « -- @student » entre les tables de
-- travail et le verdict : le code étudiant tourne alors ISOLÉ, ton verdict lit l'état final rechargé
-- (il ne peut pas fausser ta correction). Table de référence éventuelle → « CREATE TEMP TABLE ».
$hc$),
('Java',
 $sc$// Sandbox : bibliothèque standard Java (JDK, aucun réseau).
public class Solution {
    public static int solution() {
        // à compléter
        return 0;
    }

    public static void main(String[] args) {
        System.out.println(solution());
    }
}
$sc$,
 $hc$// HARNAIS (Java) — exécuté après le code de l'étudiant (son main est neutralisé, ses classes restent accessibles).
// Contrat : RENVOIE un boolean (true = réussi) ; une exception vaut échec.
// Appelle le point d'entrée QUALIFIÉ de l'étudiant, ex. Solution.solution(...).
return Solution.solution() == ATTENDU;
$hc$),
('C',
 $sc$// Sandbox : bibliothèque standard C (libc, aucun réseau).
#include <stdio.h>

int solution(void) {
    // à compléter
    return 0;
}

int main(void) {
    printf("%d\n", solution());
    return 0;
}
$sc$,
 $hc$// HARNAIS (C) — exécuté après le code de l'étudiant (son main est neutralisé, ses fonctions restent accessibles).
// Contrat : RENVOIE une valeur non nulle si réussi, 0 sinon.
// Appelle le point d'entrée de l'étudiant, ex. solution(...).
return solution() == ATTENDU;
$hc$),
('C++',
 $sc$// Sandbox : bibliothèque standard C++ (STL, aucun réseau).
#include <iostream>

int solution() {
    // à compléter
    return 0;
}

int main() {
    std::cout << solution() << std::endl;
    return 0;
}
$sc$,
 $hc$// HARNAIS (C++) — exécuté après le code de l'étudiant (son main est neutralisé, ses symboles restent accessibles).
// Contrat : RENVOIE true (réussi) ; une exception vaut échec.
// Appelle le point d'entrée de l'étudiant, ex. solution(...).
return solution() == ATTENDU;
$hc$),
('C#',
 $sc$// Sandbox : bibliothèque standard .NET/Mono (aucun réseau).
using System;

class Solution
{
    public static int solution()
    {
        // à compléter
        return 0;
    }

    static void Main()
    {
        Console.WriteLine(solution());
    }
}
$sc$,
 $hc$// HARNAIS (C#) — exécuté après le code de l'étudiant (son Main est neutralisé, ses classes restent accessibles).
// Contrat : RENVOIE un bool (true = réussi) ; une exception vaut échec.
// Appelle le point d'entrée QUALIFIÉ de l'étudiant, ex. Solution.solution(...).
return Solution.solution().Equals(ATTENDU);
$hc$),
('Bash',
 $sc$#!/usr/bin/env bash
# Sandbox : bash 5.2 + coreutils GNU (aucun réseau).
solution() {
  # à compléter
  :
}
$sc$,
 $hc$# HARNAIS (Bash) — exécuté après le script de l'étudiant.
# Le script de l'étudiant est sourcé : ses fonctions/variables sont disponibles, et sa sortie
# standard est capturable, ex. resultat="$(solution)".
# Contrat : code de sortie 0 = réussi, tout code non nul = échec (utilise test / [ ]).
[ "$(solution)" = "ATTENDU" ]
$hc$),
('HTML',
 $sc$<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title></title>
  </head>
  <body>
    <!-- à compléter -->
  </body>
</html>
$sc$,
 $hc$// HARNAIS en JavaScript pour une réponse HTML (le HTML n'est pas exécutable seul).
// Le HTML de l'étudiant est parsé en DOM et fourni via `doc` (un Document) — équivalent de :
//   const doc = new DOMParser().parseFromString(reponseHtml, "text/html");
// Interroge-le avec l'API DOM : doc.querySelector(...), .textContent, .getAttribute(...).
// Contrat : RENVOIE true (réussi) ; une exception vaut échec.
return doc.querySelector("h1")?.textContent.trim() === ATTENDU;
$hc$),
('Rust',
 $sc$// Sandbox : bibliothèque standard Rust (aucun réseau, pas de crate externe).
fn solution() -> i32 {
    // à compléter
    0
}

fn main() {
    println!("{}", solution());
}
$sc$,
 $hc$// HARNAIS (Rust) — exécuté après le code de l'étudiant (son main est neutralisé).
// Contrat : la DERNIÈRE expression est la valeur de retour (true = réussi) ; un panic! vaut échec.
// Appelle le point d'entrée de l'étudiant, ex. solution(...).
solution() == ATTENDU
$hc$),
('PHP',
 $sc$<?php
// Sandbox : PHP 8.2, bibliothèque standard (aucun réseau, aucun paquet Composer).
function solution() {
  // à compléter
}
$sc$,
 $hc$// HARNAIS (PHP) — exécuté après le code de l'étudiant.
// Contrat : RENVOIE true (réussi) ; une exception vaut échec.
// Appelle le point d'entrée de l'étudiant, ex. solution(...).
return solution() === ATTENDU;
$hc$),
('JSX',
 $sc$function Composant() {
  return (
    <div>{/* à compléter */}</div>
  );
}
$sc$,
 $hc$// HARNAIS en JavaScript pour un composant JSX (React). Disponible dans le harnais :
//   • html          : rendu statique de <Composant /> (sans props) ;
//   • render(C, p)  : rend un composant avec des props → HTML, ex. render(Composant, { nom: "X" }) ;
//   • mount(C, p)   : MONTE le composant dans le DOM (interactif) → renvoie le conteneur ;
//   • click(el) / fireEvent(el, type, init) : simulent un événement AVEC mise à jour de l'état ;
//   • document, window, React, useState/useEffect/…, et les fonctions définies par l'étudiant.
// Interactif : const c = mount(Composant); click(c.querySelector("button")); return c.textContent.includes("1");
// Contrat : RENVOIE true (réussi) ; une exception (transpilation / rendu échoué) vaut échec.
return html.includes(ATTENDU);
$hc$),
('TSX',
 $sc$function Composant(): JSX.Element {
  return (
    <div>{/* à compléter */}</div>
  );
}
$sc$,
 $hc$// HARNAIS en JavaScript pour un composant TSX (React + TypeScript). Disponible dans le harnais :
//   • html          : rendu statique de <Composant /> (sans props) ;
//   • render(C, p)  : rend un composant avec des props → HTML, ex. render(Composant, { nom: "X" }) ;
//   • mount(C, p)   : MONTE le composant dans le DOM (interactif) → renvoie le conteneur ;
//   • click(el) / fireEvent(el, type, init) : simulent un événement AVEC mise à jour de l'état ;
//   • document, window, React, useState/useEffect/…, et les fonctions définies par l'étudiant.
// Interactif : const c = mount(Composant); click(c.querySelector("button")); return c.textContent.includes("1");
// Contrat : RENVOIE true (réussi) ; une exception (transpilation / rendu échoué) vaut échec.
return html.includes(ATTENDU);
$hc$),
('JSON',
 $sc${
  "_commentaire": "à compléter — remplace ce contenu par ta réponse JSON"
}
$sc$,
 $hc$// HARNAIS en JavaScript pour une réponse JSON (données, non exécutables).
// Le JSON de l'étudiant est parsé et fourni via `data` (objet JS) — équivalent de :
//   const data = JSON.parse(reponseJson);
// Vérifie sa structure / ses valeurs : data.champ, Array.isArray(data), data.length…
// Contrat : RENVOIE true (réussi) ; une exception (JSON invalide) vaut échec.
return data.nom === ATTENDU;
$hc$),
('Go',
 $sc$// Sandbox : bibliothèque standard Go (aucun réseau).
package main

import "fmt"

func solution() int {
    // à compléter
    return 0
}

func main() {
    fmt.Println(solution())
}
$sc$,
 $hc$// HARNAIS (Go) — exécuté après le code de l'étudiant (son main est neutralisé).
// Contrat : RENVOIE true (réussi) ; un panic vaut échec.
// Appelle le point d'entrée de l'étudiant, ex. solution(...).
return solution() == ATTENDU
$hc$)
ON CONFLICT (name) DO NOTHING;

-- Harnais écrits dans un AUTRE langage : HTML/JSON/JSX/TSX (markup/données/vues, non
-- auto-testables) sont validés par un harnais JavaScript. Les autres → harnais dans leur
-- propre langage (harness_language_id NULL).
UPDATE Language SET harness_language_id = (SELECT id FROM Language WHERE name = 'JavaScript')
WHERE name IN ('HTML', 'JSON', 'JSX', 'TSX');

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
