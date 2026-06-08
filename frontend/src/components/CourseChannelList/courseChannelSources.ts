import { type CourseChannel } from './CourseChannelList';

export interface QuizChannelSource {
  /** Identifiant du quiz (Quiz.id, SERIAL). */
  id: number;
  title: string;
}

/**
 * F_Type d'un forum (table F_Type) :
 * - 'Discussion' : echange libre facon chat → affiche comme un canal.
 * - 'Thread'     : post + reponses → affiche comme un forum.
 */
export type ForumType = 'Discussion' | 'Thread';

/**
 * Source unique pour les canaux ET les forums : dans la BD, les deux sont des
 * lignes de la table Forum, distinguees par leur f_type (FK vers F_Type).
 */
export interface ForumChannelSource {
  /** Identifiant du forum (Forum.id, SERIAL). */
  id: number;
  title: string;
  /** F_Type du forum ; defaut 'Thread' (forum) si absent. */
  f_type?: ForumType;
}

export interface CourseChannelSources {
  channels?: CourseChannel[];
  quizzes?: QuizChannelSource[];
  forums?: ForumChannelSource[];
}

/** Correspondance F_Type → type de canal affiche dans l'UI. */
const FORUM_TYPE_TO_CHANNEL_TYPE: Record<ForumType, string> = {
  Discussion: 'text',
  Thread: 'forum',
};

/**
 * Normalise les différentes collections de canaux (UI + backend) vers un
 * format unique pour l'affichage. Les forums de type 'Discussion' sont rendus
 * comme des canaux, ceux de type 'Thread' comme des forums.
 */
export function normalizeCourseChannelsFromSources(sources: CourseChannelSources): CourseChannel[] {
  const normalizedChannels = sources.channels ?? [];
  const normalizedQuizzes = (sources.quizzes ?? []).map((quiz) => ({
    id: quiz.id,
    name: quiz.title,
    type: 'quiz',
  }));
  const normalizedForums = (sources.forums ?? []).map((forum) => ({
    id: forum.id,
    name: forum.title,
    type: FORUM_TYPE_TO_CHANNEL_TYPE[forum.f_type ?? 'Thread'],
  }));

  return [...normalizedChannels, ...normalizedQuizzes, ...normalizedForums];
}
