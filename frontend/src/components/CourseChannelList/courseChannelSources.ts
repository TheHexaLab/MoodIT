import { type CourseChannel } from './CourseChannelList';

export interface QuizChannelSource {
  id?: string;
  id_quiz?: string | number;
  title: string;
}

export interface ForumChannelSource {
  id?: string;
  id_forum?: string | number;
  title: string;
}

export interface TextChannelSource {
  id?: string;
  id_text_channel?: string | number;
  name: string;
}

export interface CourseChannelSources {
  channels?: CourseChannel[];
  quizzes?: QuizChannelSource[];
  forums?: ForumChannelSource[];
  textChannels?: TextChannelSource[];
}

/**
 * Normalise les différentes collections de canaux (UI + backend) vers un
 * format unique pour l'affichage.
 */
export function normalizeCourseChannelsFromSources(sources: CourseChannelSources): CourseChannel[] {
  const normalizedChannels = sources.channels ?? [];
  const normalizedQuizzes = (sources.quizzes ?? []).map((quiz) => ({
    id: String(quiz.id ?? quiz.id_quiz ?? quiz.title),
    name: quiz.title,
    type: 'quiz',
  }));
  const normalizedForums = (sources.forums ?? []).map((forum) => ({
    id: String(forum.id ?? forum.id_forum ?? forum.title),
    name: forum.title,
    type: 'forum',
  }));
  const normalizedTextChannels = (sources.textChannels ?? []).map((channel) => ({
    id: String(channel.id ?? channel.id_text_channel ?? channel.name),
    name: channel.name,
    type: 'text',
  }));

  return [
    ...normalizedChannels,
    ...normalizedQuizzes,
    ...normalizedTextChannels,
    ...normalizedForums,
  ];
}
