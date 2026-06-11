/**
 * Modèle de domaine CANONIQUE de l'application — source unique de vérité des
 * entités échangées avec l'API et le WebSocket. Aligné sur `init.sql` :
 * convention **snake_case** (= forme des payloads JSON renvoyés par le backend).
 *
 * Règle : une seule interface par entité. Les composants/popups ne redéfinissent
 * plus ces entités — ils les importent d'ici, et dérivent leurs DTOs (création /
 * mise à jour / vues) via `Pick` / `Omit` / `&`.
 *
 * Certains champs sont optionnels pour couvrir les vues partielles renvoyées par
 * l'API selon l'endpoint (ex. l'auteur d'un message n'a pas l'email ; un GET
 * « programme + cours » embarque `courses`).
 */

/** F_Type d'un forum (table F_Type) : 'Discussion' = chat, 'Thread' = post+réponses. */
export type ForumType = 'Discussion' | 'Thread';

/** Établissement (table Establishment). */
export interface Establishment {
  id: number;
  name: string;
  domain_email?: string;
}

/** Rôle (table Role) : Étudiant / Enseignant / Auxiliaire / Administrateur. */
export interface Role {
  id: number;
  name: string;
}

/**
 * Utilisateur (table User_, colonnes utiles côté client).
 * `avatar_color` est optionnel pour couvrir les vues d'auteur minimales.
 */
export interface User {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  avatar_color?: string;
  email?: string;
  /** URL d'une photo de profil (si l'utilisateur en a une). */
  avatar_url?: string;
}

/**
 * Programme (table Program). `courses` / `label` sont des commodités côté front :
 * `courses` est embarqué par l'API au chargement d'un programme ; `label` est un
 * override d'affichage optionnel.
 */
export interface Program {
  id: number;
  name: string;
  code: string;
  cohort: string;
  color: string;
  establishment_id?: number;
  label?: string;
  courses?: Course[];
}

/**
 * Cours (table Course). `title`/`code` peuvent manquer dans certaines vues UI.
 * `channels`/`quizzes`/`forums` sont les sections embarquées au chargement.
 */
export interface Course {
  id: number;
  title?: string;
  code?: string;
  /** Libellé UI déjà formaté (compat affichage). */
  name?: string;
  description?: string;
  channels?: CourseChannel[];
  quizzes?: Quiz[];
  forums?: Forum[];
}

/** Quiz (table Quiz). `position` = ordre d'affichage dans la section Quiz. */
export interface Quiz {
  id: number;
  title: string;
  description?: string;
  position?: number;
}

/**
 * Forum (table Forum). Canaux ('Discussion') et forums ('Thread') sont tous deux
 * des lignes de Forum, distingués par `f_type`. `position` = ordre dans sa section.
 */
export interface Forum {
  id: number;
  title: string;
  f_type?: ForumType;
  position?: number;
  /** Messages (pertinent surtout pour un canal 'Discussion'). */
  messages?: ChannelMessage[];
}

/**
 * Canal NORMALISÉ pour l'affichage : quiz / canal ('Discussion') / forum ('Thread')
 * fusionnés en une seule ligne de liste, identifiée par `type` + `id`.
 */
export interface CourseChannel {
  id: number;
  name: string;
  type: string;
  messages?: ChannelMessage[];
}

/**
 * Message d'un canal 'Discussion' (= Post d'un Forum de f_type 'Discussion').
 * `client_msg_id` (nonce) permet de dédupliquer l'optimiste de son écho WS.
 */
export interface ChannelMessage {
  id: number;
  content: string;
  created_at: string;
  author: User;
  post_parent_id?: number | null;
  client_msg_id?: string;
}

/** Vote sur un post (table Vote) : value_ ∈ {-1, 1} ; score d'un post = SUM(value_). */
export interface PostVote {
  user_id: number;
  value: 1 | -1;
}

/**
 * Sujet ou réponse d'un forum 'Thread' (= Post d'un Forum de f_type 'Thread').
 * Les réponses (post_parent_id) sont imbriquées dans `replies` (chargées paresseusement).
 */
export interface ForumPost {
  id: number;
  content: string;
  created_at: string;
  author: User;
  is_pinned?: boolean;
  /** Titre du sujet (les posts racines d'un Thread en ont un). */
  title?: string;
  votes: PostVote[];
  /** Réponses directes ; `undefined` = pas encore chargées, `[]` = chargées et vides. */
  replies?: ForumPost[];
  /** Nombre de réponses directes, connu dès le chargement (avant dépliage). */
  reply_count?: number;
  /** Nonce de réconciliation optimiste ↔ écho WS. */
  client_post_id?: string;
}
