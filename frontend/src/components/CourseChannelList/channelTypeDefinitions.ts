import { type ChannelTypeDefinition } from './CourseChannelList.tsx';

/** Types de sections par défaut (ordre = ordre d'affichage). Exporté à part du
 *  composant pour que les consommateurs (ex. boutons « Créer un canal/quiz/forum »)
 *  retrouvent la définition d'un type afin d'ouvrir le SectionEditorPopup
 *  correspondant — sans casser le fast-refresh de CourseChannelList. */
export const defaultTypeDefinitions: ChannelTypeDefinition[] = [
  { type: 'text', label: 'Canaux', emptyLabel: 'Aucun canal' },
  { type: 'forum', label: 'Forums', emptyLabel: 'Aucun forum' },
  { type: 'quiz', label: 'Quiz', emptyLabel: 'Aucun quiz' },
];

/** Vues de l'entrée « Devoirs » : la liste ou un devoir (`assignment`), une remise à noter (`submission`). */
export function isAssignmentChannel(type: string | undefined): boolean {
  return type === 'assignment' || type === 'submission';
}
