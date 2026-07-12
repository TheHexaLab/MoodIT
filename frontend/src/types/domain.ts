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

import type { ProgramRoleName } from '../helpers/roles.ts';

/** F_Type d'un forum (table F_Type) : 'Discussion' = chat, 'Thread' = post+réponses. */
export type ForumType = 'Discussion' | 'Thread';

/** Établissement (table Establishment). */
export interface Establishment {
  id: number;
  name: string;
  domainEmail?: string;
}

/**
 * Établissement enrichi (EstablishmentDTO) pour le gestionnaire des établissements (gardien) :
 * ajoute le nombre de programmes et les codes existants.
 */
export interface ManagedEstablishment extends Establishment {
  programCount?: number;
  programCodes?: string[];
}

/** Rôle (table Role) : Étudiant / Enseignant / Auxiliaire / Administrateur. */
export interface Role {
  id: number;
  name: string;
}

/**
 * Utilisateur (table User_, colonnes utiles côté client).
 * `avatarColor` est optionnel pour couvrir les vues d'auteur minimales.
 */
export interface User {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  avatarColor?: string;
  email?: string;
  /** URL d'une photo de profil (si l'utilisateur en a une). */
  avatarUrl?: string;
  /**
   * Rôles GLOBAUX (table User_Role), renvoyés par GET /api/me. Optionnel : les vues
   * d'auteur minimales ne les portent pas. Le front en dérive `isAdmin`.
   */
  roles?: Role[];
}

/**
 * Champs d'auteur mis à jour en temps réel (WS `user:updated`) quand un utilisateur modifie
 * son profil : le front remplace ces champs sur tous ses messages/posts chargés (par `id`).
 */
export interface AuthorUpdate {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  avatarColor?: string;
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
  establishmentId?: number;
  label?: string;
  courses?: Course[];
  /**
   * Rôle le plus élevé de l'utilisateur COURANT dans ce programme (User_Program_Role) :
   * Administrateur, Enseignant ou null/absent (aucun). Pilote les permissions front
   * (cf. permissions.ts). Renseigné par fetchPrograms via le champ `roleName` du ProgramDTO.
   */
  roleName?: ProgramRoleName | null;
}

/**
 * Cours (table Course). `title`/`code` peuvent manquer dans certaines vues UI.
 * `quizzes`/`forums` sont les sections embarquées au chargement (les canaux de
 * discussion sont des Forum de `fType: 'Discussion'`).
 */
export interface Course {
  id: number;
  title?: string;
  code?: string;
  /** Libellé UI déjà formaté (compat affichage). */
  name?: string;
  description?: string;
  quizzes?: Quiz[];
  forums?: Forum[];
}

/** Quiz (table Quiz). `position` = ordre d'affichage dans la section Quiz. */
export interface Quiz {
  id: number;
  title: string;
  position?: number;
  /** Quiz « du jour » (table Quiz.is_daily). */
  isDaily?: boolean;
  /** Publié aux étudiants (table Quiz.is_published) ; un brouillon ne l'est pas. */
  isPublished?: boolean;
  /** L'étudiant peut-il refaire le quiz (tentatives multiples, table Quiz.allow_retry) ? */
  allowRetry?: boolean;
  createdAt?: string;
  /**
   * Questions du quiz, embarquées au chargement du détail (table Question).
   * Absent dans les vues de liste (section Quiz d'un cours).
   */
  questions?: Question[];
  /**
   * Nombre de questions, fourni par les endpoints de LISTE (sans charger les questions).
   * La liste affiche `questions?.length ?? questionCount`. Absent dans le détail.
   */
  questionCount?: number;
}

/**
 * Type de question — DISCRIMINANT technique stable (slug), volontairement découplé
 * du libellé FR affiché (table Q_Type.name). Sert de clé de `switch` / map de
 * composants et ouvre l'i18n. Pour l'affichage, passer par `QUESTION_TYPE_LABELS`.
 */
export type QuestionType =
  | 'true_false'
  | 'single_choice'
  | 'multiple_choice'
  | 'ordering'
  | 'matching'
  | 'coding';

/**
 * Type de question tel que listé par l'API (table Q_Type) : `id` (q_type_id, pour la
 * persistance), `slug` (discriminant frontend) et `label` (Q_Type.name, FR affiché).
 * Alimente le sélecteur de type de l'éditeur de question.
 */
export interface QuestionTypeOption {
  id: number;
  slug: QuestionType;
  label: string;
}

/** Libellé FR par slug (jonction vers Q_Type.name). Seul point qui porte le texte affiché. */
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  true_false: 'Vrai/Faux',
  single_choice: 'Choix unique',
  multiple_choice: 'Choix multiple',
  ordering: 'Remise en ordre',
  matching: 'Association',
  coding: 'Code',
};

/**
 * Question d'un quiz (table Question). `prompt` est en **Markdown**, `totalScore` est
 * le barème. Les champs de support dépendent du `qType` (tables génériques partagées) :
 * - `true_false` / `single_choice` / `multiple_choice` → `answers`
 * - `ordering` / `matching` → `dragItems`
 * - `coding` → `language` + `startCode` + `testCases`
 */
export interface Question {
  id: number;
  /** Énoncé en Markdown (table Question.prompt). */
  prompt: string;
  qType: QuestionType;
  /**
   * Id du type en base (table Q_Type.id ; colonne Question.q_type_id, NOT NULL), pour
   * la PERSISTANCE. Dérivé du `qType` (slug, discriminant front) via la liste des
   * types chargée — le slug n'existant pas en base. Absent tant que les types ne sont
   * pas chargés ; le backend doit alors le résoudre lui-même.
   */
  qTypeId?: number;
  /** Barème de la question (table Question.total_score). */
  totalScore: number;
  /** Ordre d'affichage dans le quiz (table Question.order_index). */
  orderIndex?: number;
  /** Options (Vrai/Faux, choix unique, choix multiple). */
  answers?: Answer[];
  /** Éléments à ordonner (`ordering`) ou à classer (`matching`). */
  dragItems?: DragItem[];
  /**
   * Catégories (zones de dépôt) d'une question `matching` = groupes distincts. Exposées à
   * l'étudiant (il doit voir les zones), même quand le groupe correct de chaque item est masqué.
   */
  groups?: string[];
  /** Langage d'exécution (questions `coding`). */
  language?: Language;
  /** Squelette de code montré à l'étudiant (table Question.start_code). */
  startCode?: string;
  /**
   * Harnais de tests CACHÉS (table Test_Case). Présent seulement dans les vues
   * enseignant/éditeur ; jamais renvoyé au répondant.
   */
  testCases?: TestCase[];
}

/**
 * Option de réponse (table Answer) — Vrai/Faux, choix unique, choix multiple.
 * `isCorrect` est la vérité de correction : omis dans la vue du répondant.
 */
export interface Answer {
  id: number;
  content: string;
  isCorrect?: boolean;
}

/**
 * Élément déplaçable (table Drag_Item), partagé entre deux types :
 * - `ordering` → `correctOrder` = position attendue, `groupName` absent.
 * - `matching` → `groupName` = catégorie attendue ; `correctOrder` inutilisé (= 0).
 * Les champs de correction sont omis dans la vue du répondant.
 */
export interface DragItem {
  id: number;
  content: string;
  correctOrder?: number;
  groupName?: string | null;
}

/**
 * Cas de test d'une question `coding` (table Test_Case). Contrat minimal : le harnais
 * renvoie un BOOLÉEN (passe/échoue). `weight` donne le crédit partiel. Données cachées.
 */
export interface TestCase {
  id: number;
  name: string;
  /** Code du harnais exécuté contre la soumission (table Test_Case.harness_code). */
  harnessCode: string;
  weight: number;
}

/** Langage d'exécution d'une question `coding` (table Language). */
export interface Language {
  id: number;
  name: string;
  /** Gabarit de harnais de départ proposé au prof (table Language.harness_template). */
  harnessTemplate?: string;
  /** Code de départ par défaut proposé pour ce langage (table Language.start_code_template). */
  startCodeTemplate?: string;
  /**
   * Langage dans lequel s'écrivent les harnais des questions utilisant CE langage
   * (table Language.harness_language_id, auto-référence). Absent → harnais dans le
   * même langage que la question.
   */
  harnessLanguageId?: number;
}

/**
 * Forum (table Forum). Canaux ('Discussion') et forums ('Thread') sont tous deux
 * des lignes de Forum, distingués par `fType`. `position` = ordre dans sa section.
 */
export interface Forum {
  id: number;
  title: string;
  fType?: ForumType;
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
 * Message d'un canal 'Discussion' (= Post d'un Forum de fType 'Discussion').
 * `clientMsgId` (nonce) permet de dédupliquer l'optimiste de son écho WS.
 */
export interface ChannelMessage {
  id: number;
  content: string;
  createdAt: string;
  author: User;
  postParentId?: number | null;
  clientMsgId?: string;
}

/**
 * Réponse du service MCP : feedback automatisé d'un COURS (table MCP_Response).
 * `content` (TEXT en base) porte l'analyse structurée sérialisée (cf. McpAnalysis).
 * `userId` = l'enseignant qui a déclenché l'analyse ; historique trié par createdAt.
 */
export interface McpResponse {
  id: number;
  createdAt: string;
  content: string;
  userId: number;
  courseId: number;
  /** Auteur résolu (jointure sur user_id) : l'utilisateur qui a lancé l'analyse. */
  author?: User;
}

/**
 * Analyse MCP structurée, telle que sérialisée dans MCP_Response.content : le service
 * MCP produit ce contenu, le frontend le parse pour l'affichage (score, points forts,
 * points à améliorer, volumétrie des sources).
 */
export interface McpAnalysis {
  /** Score global du cours (0–100). */
  score: number;
  /** Synthèse narrative (2–4 phrases). Optionnel (absent des analyses antérieures). */
  summary?: string;
  /**
   * Sous-scores par dimension (0–100). Optionnel. `success`/`sentiment` peuvent être `null`
   * (N/D) quand la donnée sous-jacente est absente (aucune note/code, aucun message).
   */
  dimensions?: {
    content: number;
    engagement: number;
    success: number | null;
    sentiment: number | null;
  };
  /** Points forts identifiés. */
  strengths: string[];
  /** Points à améliorer. */
  improvements: string[];
  /** Recommandations actionnables et priorisées. Optionnel. */
  recommendations?: string[];
  /** Volumétrie ayant servi à l'analyse. */
  sources: {
    quizCount: number;
    forumMessageCount: number;
    studentCount: number;
  };
}

/**
 * Résumé d'une analyse MCP pour la LISTE de l'historique : projection légère de
 * MCP_Response (sans le `content`). Le détail complet est chargé à la demande (au clic).
 */
export interface McpResponseSummary {
  id: number;
  createdAt: string;
  strengthsCount: number;
  improvementsCount: number;
}

/** Vote sur un post (table Vote) : value_ ∈ {-1, 1} ; score d'un post = SUM(value_). */
export interface PostVote {
  userId: number;
  value: 1 | -1;
}

/**
 * Sujet ou réponse d'un forum 'Thread' (= Post d'un Forum de fType 'Thread').
 * Les réponses (postParentId) sont imbriquées dans `replies` (chargées paresseusement).
 */
export interface ForumPost {
  id: number;
  content: string;
  createdAt: string;
  author: User;
  isPinned?: boolean;
  /** Titre du sujet (les posts racines d'un Thread en ont un). */
  title?: string;
  /**
   * Votes CONNUS localement : le vote de l'utilisateur courant (0 ou 1 entrée) plus,
   * transitoirement, les votes live d'autres utilisateurs reçus par WebSocket. Le total
   * serveur (hors utilisateur courant) est porté à part par `othersVoteTotal` — le backend
   * n'envoie qu'un agrégat, pas la liste complète des votes.
   */
  votes: PostVote[];
  /** Somme des votes des AUTRES utilisateurs (= voteTotalValue serveur − vote propre).
   *  Base du score affiché, à laquelle s'ajoute le vote (optimiste) de l'utilisateur. */
  othersVoteTotal?: number;
  /** Réponses directes ; `undefined` = pas encore chargées, `[]` = chargées et vides. */
  replies?: ForumPost[];
  /** Nombre de réponses directes, connu dès le chargement (avant dépliage). */
  replyCount?: number;
  /** Nonce de réconciliation optimiste ↔ écho WS. */
  clientPostId?: string;
}

// ── Formes de réponse brutes du backend (DTO) ──────────────────────────────────
// Telles que sérialisées par core-service, avant normalisation vers le modèle de
// domaine ci-dessus (cf. les mappers dans dashboardApi.ts).

/** Forum renvoyé par le backend (ForumDTO) : le type est porté par `fTypeName`. */
export interface ForumResponse {
  id: number;
  title: string;
  position?: number;
  courseId: number;
  fTypeId: number;
  fTypeName: ForumType; // 'Discussion' (canal) | 'Thread' (forum)
}

/** Quiz renvoyé par le backend (QuizDTO, méta seule sans les questions). */
export interface QuizResponse {
  id: number;
  title: string;
  position?: number;
  isPublished?: boolean;
  isDaily?: boolean;
  allowRetry?: boolean;
  questionCount?: number;
  createdAt?: string;
}

/** Cours renvoyé par l'endpoint enrollments (CourseForumsDTO) : forums + quiz embarqués. */
export interface CourseForumsResponse {
  id: number;
  title?: string;
  code?: string;
  forums?: ForumResponse[];
  quizzes?: QuizResponse[];
}

/** Option de réponse renvoyée par le backend (AnswerDTO). */
export interface AnswerResponse {
  id: number;
  content: string;
  isCorrect?: boolean;
}

/** Élément déplaçable renvoyé par le backend (DragItemDTO). */
export interface DragItemResponse {
  id: number;
  content: string;
  correctOrder?: number;
  groupName?: string | null;
}

/** Question renvoyée par le backend (QuestionDTO) ; `qType` = slug résolu serveur. */
export interface QuestionResponse {
  id: number;
  prompt: string;
  qType: QuestionType;
  qTypeId?: number;
  totalScore: number;
  orderIndex?: number;
  /** Langage d'exécution (questions Code) : light (id + name) renvoyé par le backend. */
  language?: Language;
  startCode?: string;
  answers?: AnswerResponse[];
  dragItems?: DragItemResponse[];
  /** Catégories (zones) d'une association : groupes distincts, exposés même en passation. */
  groups?: string[];
  /** Harnais de test (questions Code) : présent UNIQUEMENT côté éditeur (absent en passation). */
  testCases?: TestCase[];
}

/** Détail d'un quiz renvoyé par le backend (QuizDetailDTO). */
export interface QuizDetailResponse {
  id: number;
  title: string;
  position?: number;
  isPublished?: boolean;
  isDaily?: boolean;
  allowRetry?: boolean;
  questions?: QuestionResponse[];
}

/** Post renvoyé par le backend (PostVoteUserDTO). */
export interface PostVoteUserDTO {
  id: number;
  content: string;
  createdAt: string;
  title?: string;
  isPinned?: boolean;
  postParentId?: number | null;
  author: User;
  voteTotalValue?: number;
  /** Vote de l'utilisateur COURANT sur ce post (1 / -1 / null s'il n'a pas voté). */
  userVoteValue?: number | null;
  childrenCount?: number;
  children?: PostVoteUserDTO[];
}
