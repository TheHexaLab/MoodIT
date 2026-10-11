import { type ChannelTypeDefinition } from './CourseChannelList.tsx';
import { VOICE_ENABLED } from '../../services/voiceApi.ts';

/** Types de sections par défaut (ordre = ordre d'affichage). Exporté à part du
 *  composant pour que les consommateurs (ex. boutons « Créer un canal/quiz/forum »)
 *  retrouvent la définition d'un type afin d'ouvrir le SectionEditorPopup
 *  correspondant — sans casser le fast-refresh de CourseChannelList. */
export const defaultTypeDefinitions: ChannelTypeDefinition[] = [
  { type: 'quiz', label: 'QUIZ', emptyLabel: 'Aucun quiz' },
  { type: 'text', label: 'CANAUX', emptyLabel: 'Aucun canal' },
  { type: 'forum', label: 'FORUMS', emptyLabel: 'Aucun forum' },
];

/** Section vocale (prototype, greffon retirable). Hors de `defaultTypeDefinitions` pour que
 *  ce dernier reste la vérité « métier » stable ; injectée dans l'UI par `uiTypeDefinitions`. */
export const voiceTypeDefinition: ChannelTypeDefinition = {
  type: 'voice',
  label: 'VOCAL',
  emptyLabel: 'Aucun salon vocal',
};

/**
 * Définitions RENDUES dans la sidebar : les défauts, plus la section vocale insérée après
 * les CANAUX quand `VOICE_ENABLED` est actif. Flag OFF → strictement les défauts (la section
 * VOCAL disparaît entièrement de l'UI).
 */
export function uiTypeDefinitions(): ChannelTypeDefinition[] {
  if (!VOICE_ENABLED) return defaultTypeDefinitions;
  const afterText = defaultTypeDefinitions.findIndex((d) => d.type === 'text');
  const withVoice = [...defaultTypeDefinitions];
  withVoice.splice(afterText + 1, 0, voiceTypeDefinition);
  return withVoice;
}
