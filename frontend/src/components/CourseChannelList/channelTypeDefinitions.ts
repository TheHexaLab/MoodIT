import { type ChannelTypeDefinition } from './CourseChannelList.tsx';

/** Types de sections par défaut (ordre = ordre d'affichage). Exporté à part du
 *  composant pour que les consommateurs (ex. boutons « Créer un canal/quiz/forum »)
 *  retrouvent la définition d'un type afin d'ouvrir le SectionEditorPopup
 *  correspondant — sans casser le fast-refresh de CourseChannelList. */
export const defaultTypeDefinitions: ChannelTypeDefinition[] = [
  { type: 'quiz', label: 'QUIZ', emptyLabel: 'Aucun quiz' },
  { type: 'text', label: 'CANAUX', emptyLabel: 'Aucun canal' },
  { type: 'forum', label: 'FORUMS', emptyLabel: 'Aucun forum' },
];
