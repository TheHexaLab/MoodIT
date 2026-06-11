import {
  type CourseChannel,
  type Forum,
  type ForumType,
  type Quiz,
} from '../../types/domain.ts';

// Entités ré-exportées depuis le modèle de domaine (source unique). Les anciens
// noms `QuizChannelSource` / `ForumChannelSource` sont conservés en alias de compat :
// une source de quiz/forum EST l'entité Quiz / Forum.
export type { ForumType };
export type QuizChannelSource = Quiz;
export type ForumChannelSource = Forum;

export interface CourseChannelSources {
  channels?: CourseChannel[];
  quizzes?: Quiz[];
  forums?: Forum[];
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
  const normalizedQuizzes = sortByPosition(sources.quizzes ?? []).map((quiz) => ({
    id: quiz.id,
    name: quiz.title,
    type: 'quiz',
  }));
  const normalizedForums = sortByPosition(sources.forums ?? []).map((forum) => ({
    id: forum.id,
    name: forum.title,
    type: FORUM_TYPE_TO_CHANNEL_TYPE[forum.f_type ?? 'Thread'],
    messages: forum.messages,
  }));

  return [...normalizedChannels, ...normalizedQuizzes, ...normalizedForums];
}

/**
 * Trie par `position` croissante. Les entrees sans position gardent l'ordre
 * d'insertion, et le tri est stable (egalites departagees par l'index d'origine).
 */
function sortByPosition<T extends { position?: number }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const pa = a.item.position ?? a.index;
      const pb = b.item.position ?? b.index;
      return pa === pb ? a.index - b.index : pa - pb;
    })
    .map((entry) => entry.item);
}
