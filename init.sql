CREATE TABLE Establishment(
   id SERIAL,
   name VARCHAR(128) NOT NULL,
   domain_email VARCHAR(256) NOT NULL UNIQUE,
   PRIMARY KEY(id)
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
