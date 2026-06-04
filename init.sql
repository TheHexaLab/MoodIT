CREATE TABLE Establishment(
   Id_Establishment SERIAL,
   name VARCHAR(128) NOT NULL,
   domain_email VARCHAR(256),
   PRIMARY KEY(Id_Establishment)
);

CREATE TABLE Program(
   Id_Program SERIAL,
   name VARCHAR(128) NOT NULL,
   Id_Establishment INTEGER NOT NULL,
   PRIMARY KEY(Id_Program),
   FOREIGN KEY(Id_Establishment) REFERENCES Establishment(Id_Establishment)
      ON DELETE RESTRICT
      ON UPDATE CASCADE
);

CREATE TABLE Users(
   Id_User SERIAL,
   username VARCHAR(64) NOT NULL,
   created_at TIMESTAMP NOT NULL,
   email VARCHAR(256) NOT NULL UNIQUE,
   active_token_hash VARCHAR(256),
   password_hash VARCHAR(256) NOT NULL,
   PRIMARY KEY(Id_User)
);

CREATE TABLE Role(
   Id_Role SERIAL,
   name VARCHAR(128) NOT NULL,
   PRIMARY KEY(Id_Role)
);

CREATE TABLE Course(
   Id_Course SERIAL,
   title VARCHAR(128),
   description VARCHAR(256),
   code VARCHAR(128) NOT NULL,
   PRIMARY KEY(Id_Course)
);

CREATE TABLE Enrollment(
   Id_Enrollment SERIAL,
   enrolled_at TIMESTAMP NOT NULL,
   Id_Course INTEGER NOT NULL,
   Id_User INTEGER NOT NULL,
   PRIMARY KEY(Id_Enrollment),
   FOREIGN KEY(Id_Course) REFERENCES Course(Id_Course)
      ON DELETE CASCADE
      ON UPDATE CASCADE,
   FOREIGN KEY(Id_User) REFERENCES Users(Id_User)
      ON DELETE CASCADE
      ON UPDATE CASCADE,
   UNIQUE(Id_Course, Id_User)
);

CREATE TABLE F_Type(
   Id_F_Type SERIAL,
   name VARCHAR(256) NOT NULL,
   PRIMARY KEY(Id_F_Type)
);

CREATE TABLE Quiz(
   Id_Quiz SERIAL,
   title VARCHAR(128) NOT NULL,
   description VARCHAR(512),
   is_daily BOOLEAN,
   is_published BOOLEAN NOT NULL,
   created_at TIMESTAMP NOT NULL,
   PRIMARY KEY(Id_Quiz)
);

CREATE TABLE Q_Type(
   Id_Q_Type SERIAL,
   name VARCHAR(128) NOT NULL,
   PRIMARY KEY(Id_Q_Type)
);

CREATE TABLE Forum(
   Id_Forum SERIAL,
   title VARCHAR(128),
   Id_F_Type INTEGER NOT NULL,
   Id_Course INTEGER NOT NULL,
   PRIMARY KEY(Id_Forum),
   FOREIGN KEY(Id_F_Type) REFERENCES F_Type(Id_F_Type)
      ON DELETE RESTRICT
      ON UPDATE CASCADE,
   FOREIGN KEY(Id_Course) REFERENCES Course(Id_Course)
      ON DELETE CASCADE
      ON UPDATE CASCADE
);

CREATE TABLE Post(
   Id_Post SERIAL,
   created_at TIMESTAMP NOT NULL,
   content TEXT,
   Id_Forum INTEGER NOT NULL,
   Id_User INTEGER NOT NULL,
   Id_Post_Parent INTEGER,
   PRIMARY KEY(Id_Post),
   FOREIGN KEY(Id_Forum) REFERENCES Forum(Id_Forum)
      ON DELETE CASCADE
      ON UPDATE CASCADE,
   FOREIGN KEY(Id_User) REFERENCES Users(Id_User)
      ON DELETE CASCADE
      ON UPDATE CASCADE,
   FOREIGN KEY(Id_Post_Parent) REFERENCES Post(Id_Post)
      ON DELETE CASCADE
      ON UPDATE CASCADE
);

CREATE TABLE Vote(
   Id_Vote SERIAL,
   vote_value INTEGER NOT NULL,
   Id_Quiz INTEGER,
   Id_User INTEGER,
   Id_Post INTEGER,
   PRIMARY KEY(Id_Vote),
   FOREIGN KEY(Id_Quiz) REFERENCES Quiz(Id_Quiz)
      ON DELETE CASCADE
      ON UPDATE CASCADE,
   FOREIGN KEY(Id_User) REFERENCES Users(Id_User)
      ON DELETE CASCADE
      ON UPDATE CASCADE,
   FOREIGN KEY(Id_Post) REFERENCES Post(Id_Post)
      ON DELETE CASCADE
      ON UPDATE CASCADE,
   CONSTRAINT chk_vote_target CHECK (
       (Id_Post IS NOT NULL AND Id_Quiz IS NULL) OR
       (Id_Post IS NULL AND Id_Quiz IS NOT NULL)
   ),
   UNIQUE(Id_User, Id_Post),
   UNIQUE(Id_User, Id_Quiz)
);

CREATE TABLE Question(
   Id_Question SERIAL,
   prompt VARCHAR(256) NOT NULL,
   code_language VARCHAR(64),
   expected_output TEXT,
   start_code TEXT,
   order_index INTEGER,
   total_score INTEGER,
   Id_Q_Type INTEGER NOT NULL,
   Id_Quiz INTEGER NOT NULL,
   PRIMARY KEY(Id_Question),
   FOREIGN KEY(Id_Q_Type) REFERENCES Q_Type(Id_Q_Type)
      ON DELETE RESTRICT
      ON UPDATE CASCADE,
   FOREIGN KEY(Id_Quiz) REFERENCES Quiz(Id_Quiz)
      ON DELETE CASCADE
      ON UPDATE CASCADE
);

CREATE TABLE Answer(
   Id_Answer SERIAL,
   content VARCHAR(512) NOT NULL,
   is_correct BOOLEAN NOT NULL,
   Id_Question INTEGER NOT NULL,
   PRIMARY KEY(Id_Answer),
   FOREIGN KEY(Id_Question) REFERENCES Question(Id_Question)
      ON DELETE CASCADE
      ON UPDATE CASCADE
);

CREATE TABLE Drag_Item(
   Id_Drag_Item SERIAL,
   content VARCHAR(256) NOT NULL,
   correct_order INTEGER NOT NULL,
   group_name VARCHAR(128),
   Id_Question INTEGER NOT NULL,
   PRIMARY KEY(Id_Drag_Item),
   FOREIGN KEY(Id_Question) REFERENCES Question(Id_Question)
      ON DELETE CASCADE
      ON UPDATE CASCADE
);

CREATE TABLE Submission(
   Id_Submission SERIAL,
   content TEXT,
   submitted_at TIMESTAMP NOT NULL,
   score INTEGER,
   Id_Question INTEGER NOT NULL,
   Id_User INTEGER NOT NULL,
   PRIMARY KEY(Id_Submission),
   FOREIGN KEY(Id_Question) REFERENCES Question(Id_Question)
      ON DELETE CASCADE
      ON UPDATE CASCADE,
   FOREIGN KEY(Id_User) REFERENCES Users(Id_User)
      ON DELETE CASCADE
      ON UPDATE CASCADE
);

CREATE TABLE MCP_Response(
   Id_MCP_Response SERIAL,
   created_at TIMESTAMP NOT NULL,
   content TEXT NOT NULL,
   Id_User INTEGER NOT NULL,
   Id_Forum INTEGER NOT NULL,
   PRIMARY KEY(Id_MCP_Response),
   FOREIGN KEY(Id_User) REFERENCES Users(Id_User)
      ON DELETE CASCADE
      ON UPDATE CASCADE,
   FOREIGN KEY(Id_Forum) REFERENCES Forum(Id_Forum)
      ON DELETE CASCADE
      ON UPDATE CASCADE
);

CREATE TABLE user_program(
   Id_Program INTEGER,
   Id_User INTEGER,
   PRIMARY KEY(Id_Program, Id_User),
   FOREIGN KEY(Id_Program) REFERENCES Program(Id_Program)
      ON DELETE RESTRICT
      ON UPDATE CASCADE,
   FOREIGN KEY(Id_User) REFERENCES Users(Id_User)
      ON DELETE CASCADE
      ON UPDATE CASCADE
);

CREATE TABLE user_role(
   Id_User INTEGER,
   Id_Role INTEGER,
   PRIMARY KEY(Id_User, Id_Role),
   FOREIGN KEY(Id_User) REFERENCES Users(Id_User)
      ON DELETE CASCADE
      ON UPDATE CASCADE,
   FOREIGN KEY(Id_Role) REFERENCES Role(Id_Role)
      ON DELETE RESTRICT
      ON UPDATE CASCADE
);

CREATE TABLE program_course(
   Id_Program INTEGER,
   Id_Course INTEGER,
   PRIMARY KEY(Id_Program, Id_Course),
   FOREIGN KEY(Id_Program) REFERENCES Program(Id_Program)
      ON DELETE RESTRICT
      ON UPDATE CASCADE,
   FOREIGN KEY(Id_Course) REFERENCES Course(Id_Course)
      ON DELETE CASCADE
      ON UPDATE CASCADE
);

CREATE TABLE course_quiz(
   Id_Course INTEGER,
   Id_Quiz INTEGER,
   PRIMARY KEY(Id_Course, Id_Quiz),
   FOREIGN KEY(Id_Course) REFERENCES Course(Id_Course)
      ON DELETE CASCADE
      ON UPDATE CASCADE,
   FOREIGN KEY(Id_Quiz) REFERENCES Quiz(Id_Quiz)
      ON DELETE CASCADE
      ON UPDATE CASCADE
);
