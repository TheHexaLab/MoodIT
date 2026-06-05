CREATE TABLE Establishment(
   id SERIAL,
   name VARCHAR(128) NOT NULL,
   domain_email VARCHAR(256) NOT NULL UNIQUE,
   PRIMARY KEY(id),
   CONSTRAINT chk_domain_email CHECK (domain_email ~ '^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')
);

CREATE TABLE Program(
   id SERIAL,
   name VARCHAR(128) NOT NULL,
   code VARCHAR(128) NOT NULL,
   cohort VARCHAR(128) NOT NULL,
   color VARCHAR(9) NOT NULL DEFAULT '#0a5cc0',
   establishment_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(establishment_id) REFERENCES Establishment(id) ON DELETE CASCADE
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
   verified_email BOOLEAN NOT NULL,
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
   description VARCHAR(256) ,
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
   description VARCHAR(512) ,
   is_daily BOOLEAN NOT NULL DEFAULT FALSE,
   is_published BOOLEAN NOT NULL DEFAULT FALSE,
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
   --position INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(f_type_id) REFERENCES F_Type(id),
   FOREIGN KEY(course_id) REFERENCES Course(id) ON DELETE CASCADE
);

CREATE TABLE Post(
   id SERIAL,
   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
   content TEXT NOT NULL,
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

CREATE TABLE Question(
   id SERIAL,
   prompt VARCHAR(256) NOT NULL,
   code_language VARCHAR(64) ,
   expected_output VARCHAR(512) ,
   start_code VARCHAR(512) ,
   order_index INTEGER,
   total_score INTEGER NOT NULL,
   q_type_id INTEGER NOT NULL,
   quiz_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(q_type_id) REFERENCES Q_Type(id),
   FOREIGN KEY(quiz_id) REFERENCES Quiz(id) ON DELETE CASCADE
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

CREATE TABLE Submission(
   id SERIAL,
   content VARCHAR(512) ,
   submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
   score INTEGER,
   question_id INTEGER NOT NULL,
   user_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(question_id) REFERENCES Question(id) ON DELETE CASCADE,
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE
);

CREATE TABLE MCP_Response(
   id SERIAL,
   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
   content TEXT NOT NULL,
   user_id INTEGER NOT NULL,
   forum_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE,
   FOREIGN KEY(forum_id) REFERENCES Forum(id) ON DELETE CASCADE
);

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
CREATE INDEX idx_answer_question_id ON Answer(question_id);
CREATE INDEX idx_drag_item_question_id ON Drag_Item(question_id);
CREATE INDEX idx_submission_question_id ON Submission(question_id);
CREATE INDEX idx_submission_user_id ON Submission(user_id);
CREATE INDEX idx_mcp_response_user_id ON MCP_Response(user_id);
CREATE INDEX idx_mcp_response_forum_id ON MCP_Response(forum_id);
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
CREATE INDEX idx_question_quiz_order ON Question(quiz_id, order_index); -- questions d'un quiz dans l'ordre + cascade quiz_id

-- TRIGGER
--Générer le courriel de l'usager selon son username et son établissement
CREATE OR REPLACE FUNCTION generate_user_email()
RETURNS TRIGGER AS $$
DECLARE
    v_domain VARCHAR(256);
BEGIN
    SELECT domain_email INTO v_domain
    FROM Establishment
    LIMIT 1;

    NEW.email := NEW.username || '@' || v_domain;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_email
BEFORE INSERT ON User_
FOR EACH ROW
EXECUTE FUNCTION generate_user_email();

-- ============================================================
--  Données de départ — Application UdeS / Faculté de génie
-- ============================================================

-- ------------------------------------------------------------
-- Establishment
-- ------------------------------------------------------------
INSERT INTO Establishment (name, domain_email) VALUES
  ('Université de Sherbrooke', 'usherbrooke.ca');

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
INSERT INTO User_ (username, first_name, last_name, password_hash, verified_email) VALUES
  ('admin', 'Admin', 'Admin', 'hash.pour.tester', TRUE);

INSERT INTO User_ (username, first_name, last_name, password_hash, verified_email) VALUES
  ('rosie1234', 'rosie', 'HG', 'hash.pour.tester2', TRUE);

  INSERT INTO User_ (username, first_name, last_name, password_hash, verified_email) VALUES
  ('mich1234', 'mich', 'normand', 'hash.pour.tester3', TRUE);
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
INSERT INTO Course (title, description, code) VALUES
  -- Tronc commun
  ('Mathématiques pour ingénieurs I',    'Calcul différentiel et intégral appliqué au génie.',                   'MAT115'),
  ('Mathématiques pour ingénieurs II',   'Algèbre linéaire, équations différentielles ordinaires.',              'MAT215'),
  ('Physique pour ingénieurs I',         'Mécanique classique, thermodynamique de base.',                        'PHY115'),
  ('Physique pour ingénieurs II',        'Électromagnétisme, ondes.',                                            'PHY215'),
  ('Chimie pour ingénieurs',             'Notions fondamentales de chimie générale et de matériaux.',            'CHI105'),
  ('Communication en génie',             'Rédaction technique, présentation orale, normes IEEE/APA.',           'COM105'),
  ('Éthique et déontologie',             'Responsabilité professionnelle, développement durable, OIQ.',         'ETH105'),
  -- Génie informatique / logiciel
  ('Structures de données et algorithmes','Complexité, arbres, graphes, tables de hachage.',                    'GIF201'),
  ('Systèmes d''exploitation',           'Gestion de processus, mémoire, fichiers, sécurité.',                 'GIF301'),
  ('Réseaux informatiques',              'Modèle TCP/IP, protocoles, sécurité réseau.',                         'GIF401'),
  ('Génie logiciel I',                   'Processus de développement, UML, tests unitaires.',                   'GLO200'),
  ('Génie logiciel II',                  'Patrons de conception, CI/CD, DevOps.',                               'GLO300'),
  ('Bases de données',                   'Modèle relationnel, SQL, transactions, normalisation.',                'GIF501'),
  -- Génie électrique
  ('Circuits électriques I',             'Lois de Kirchhoff, théorèmes de Thévenin/Norton, régime sinusoïdal.','GEL201'),
  ('Circuits électriques II',            'Filtres, puissance, transformateurs.',                                 'GEL301'),
  ('Électronique analogique',            'Diodes, transistors, amplificateurs opérationnels.',                   'GEL401'),
  ('Systèmes de contrôle',               'Modélisation, fonction de transfert, stabilité.',                     'GEL501'),
  -- Génie mécanique
  ('Mécanique des solides I',            'Statique, résistance des matériaux.',                                  'GMC201'),
  ('Mécanique des fluides',              'Équation de Bernoulli, écoulements visqueux.',                         'GMC301'),
  ('Thermodynamique appliquée',          'Cycles thermodynamiques, transfert de chaleur.',                       'GMC401'),
  -- Génie civil
  ('Matériaux de construction',          'Béton, acier, bois : propriétés mécaniques et durabilité.',            'GCI201'),
  ('Hydraulique',                        'Écoulement en conduites et en surface libre.',                         'GCI301'),
  -- Génie chimique
  ('Opérations unitaires I',             'Distillation, extraction, absorption.',                                'GCH201'),
  ('Cinétique chimique',                 'Réacteurs, mécanismes réactionnels, modélisation.',                   'GCH301');

-- ------------------------------------------------------------
-- F_Type  (types de forum)
-- ------------------------------------------------------------
INSERT INTO F_Type (name) VALUES
  ('Discussion'),
  ('Thread');

-- ------------------------------------------------------------
-- Forum  (un forum Q&R et un forum Annonces par cours)
-- ------------------------------------------------------------
INSERT INTO Forum (title, f_type_id, course_id)
SELECT
    'Discussion — ' || c.title,
    1,   -- Échange libre, un chat
    c.id
FROM Course c;
 
INSERT INTO Forum (title, f_type_id, course_id)
SELECT
    'Thread — ' || c.title,
    2,   -- Post + réponses
    c.id
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

