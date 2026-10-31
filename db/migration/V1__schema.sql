-- ============================================================================
--  V1 — Schéma de référence (tables, contraintes, index)
-- ============================================================================
-- Point de départ de l'historique Flyway (#96) : le schéma de init.sql tel qu'il était en prod au
-- passage à Flyway, migrations 2026-07-12 à 2026-10-30 comprises. Une base existante (prod) est
-- marquée à la version 2 sans rejouer V1 ni V2 (baseline, voir deploy/DEPLOY.md).
-- Ne JAMAIS modifier une migration appliquée : tout changement passe par une nouvelle version.

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
   -- verification_code / reset_code : HMAC du code (Base64, 44 car.), jamais le code en clair.
   verification_code VARCHAR(64),
   verification_code_expires_at TIMESTAMP,
   verification_attempts INTEGER NOT NULL DEFAULT 0,
   last_code_sent_at TIMESTAMP,
   verification_locked_until TIMESTAMP,
   failed_login_attempts INTEGER NOT NULL DEFAULT 0,
   login_locked_until TIMESTAMP,
   -- Réinitialisation de mot de passe : champs dédiés (séparés de verification_*, qui
   -- servent à la 2FA) pour éviter toute collision entre un code 2FA et un code de reset.
   reset_code VARCHAR(64),
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
   -- HMAC du code (Base64, 44 car.), jamais le code en clair — cf. AuthService.hashCode.
   verification_code VARCHAR(64),
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
   -- Annonce (forum 'Announcement') : couleur de la palette et date d'expiration (NULL = jamais).
   color VARCHAR(16),
   expires_at TIMESTAMP,
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
-- status : 'pending' (correction du code en cours, soumission async) → 'done' (corrigée).
-- Une tentative dont l'évaluation code échoue est SUPPRIMÉE (la tentative unique n'est
-- donc pas consommée) ; 'failed' ne persiste pas en base.
CREATE TABLE Attempt(
   id SERIAL,
   quiz_id INTEGER NOT NULL,
   user_id INTEGER NOT NULL,
   attempt_no INTEGER NOT NULL,
   -- Défaut 'done' : un INSERT manuel / de démo est une tentative DÉJÀ corrigée. La
   -- soumission async pose explicitement 'pending' puis 'done'.
   status VARCHAR(16) NOT NULL DEFAULT 'done',
   submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
   PRIMARY KEY(id),
   UNIQUE(quiz_id, user_id, attempt_no),
   FOREIGN KEY(quiz_id) REFERENCES Quiz(id) ON DELETE CASCADE,
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE
);

-- Verrou « une seule correction en cours par (quiz, utilisateur) » : rend l'anti-double-
-- soumission ATOMIQUE (deux POST concurrents → le 2e viole l'index → 409). Miroir de
-- uq_mcp_response_pending.
CREATE UNIQUE INDEX uq_attempt_pending ON Attempt(quiz_id, user_id) WHERE status = 'pending';

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
-- source : origine du contenu ('LLM' ou 'DETERMINISTIC'), NULL tant que pas de résultat.
CREATE TABLE MCP_Response(
   id SERIAL,
   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
   content TEXT,
   -- Défaut 'pending' (état logique d'une ligne fraîchement insérée). Le service pose
   -- toujours le statut explicitement ; ce défaut protège un INSERT manuel oublié.
   status VARCHAR(16) NOT NULL DEFAULT 'pending',
   -- Origine du contenu : 'LLM' (modèle de langage) ou 'DETERMINISTIC' (repli calculé sans IA).
   -- NULL tant que l'analyse n'est pas terminée (et pour les analyses antérieures à la colonne).
   source VARCHAR(16),
   user_id INTEGER NOT NULL,
   course_id INTEGER NOT NULL,
   PRIMARY KEY(id),
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE,
   FOREIGN KEY(course_id) REFERENCES Course(id) ON DELETE CASCADE
);

-- Verrou « une seule analyse en cours par (cours, utilisateur) » : rend la garde de
-- tentative unique ATOMIQUE (deux POST concurrents → le 2e viole l'index → 409).
-- Majuscules : McpStatus est stocké par son nom (EnumType.STRING).
CREATE UNIQUE INDEX uq_mcp_response_pending ON MCP_Response(course_id, user_id) WHERE status = 'PENDING';

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

-- ── Journal d'audit ────────────────────────────────────────────────────────────
-- Trace les actions de GESTION (rôles global/programme, établissements, programmes, cours,
-- forums, quiz, analyses MCP) — PAS les actions étudiantes (soumissions, messages). Append-only,
-- consultable par les Gardiens uniquement. `actor_email` est un INSTANTANÉ (survit à la suppression
-- de l'auteur → pas de FK). Écrit dans la MÊME transaction que la mutation (atomique avec elle).
-- pg_trgm : requis par les index GIN trigram de recherche ci-dessous (LIKE '%…%' indexable).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE Audit_Log(
   id SERIAL,
   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
   actor_email VARCHAR(256),            -- instantané de l'auteur (NULL si contexte absent)
   action VARCHAR(48) NOT NULL,         -- ex. 'ROLE_ASSIGN', 'QUIZ_CREATE', 'FORUM_DELETE'
   entity_type VARCHAR(24) NOT NULL,    -- 'ROLE','PROGRAM','COURSE','FORUM','QUIZ','ESTABLISHMENT','ENROLLMENT','MCP'
   entity_id INTEGER,                   -- id de l'entité concernée (peut être NULL)
   summary VARCHAR(512) NOT NULL,       -- phrase lisible (FR) construite au moment de l'action
   details VARCHAR(1024),               -- contexte PARENT capturé au moment de l'action (établissement,
                                        -- programmes, cours…) : survit à la suppression de l'entité. NULL si sans objet
   PRIMARY KEY(id)
);
CREATE INDEX idx_audit_log_created_at ON Audit_Log(created_at);
CREATE INDEX idx_audit_log_entity ON Audit_Log(entity_type, entity_id);
-- Recherche plein-texte (LIKE '%…%', joker en tête) : index GIN trigram sur lower(col), aligné sur
-- AuditLogRepository.search (summary/auteur/details). Le planificateur bitmap-OR les 3 index.
-- fastupdate=off : pas de pending list → l'index est IMMÉDIATEMENT à jour après écriture (les
-- recherches l'utilisent sans attendre l'autovacuum). Écritures d'audit rares → coût négligeable.
CREATE INDEX idx_audit_log_summary_trgm ON Audit_Log USING gin (lower(summary) gin_trgm_ops) WITH (fastupdate = off);
CREATE INDEX idx_audit_log_actor_trgm ON Audit_Log USING gin (lower(actor_email) gin_trgm_ops) WITH (fastupdate = off);
CREATE INDEX idx_audit_log_details_trgm ON Audit_Log USING gin (lower(details) gin_trgm_ops) WITH (fastupdate = off);
CREATE INDEX idx_quiz_course_position ON Quiz(course_id, position); -- quiz d'un cours dans l'ordre d'affichage
CREATE INDEX idx_question_quiz_order ON Question(quiz_id, order_index); -- questions d'un quiz dans l'ordre + cascade quiz_id

-- TRIGGER
-- (Retiré) L'email est désormais saisi par l'utilisateur à l'inscription et
-- conservé tel quel : il ne doit plus être dérivé du username, afin que le
-- username puisse différer de l'email utilisé pour se connecter.
