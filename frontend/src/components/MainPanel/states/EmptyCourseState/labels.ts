import type { EmptyCourseStateLabels } from './types.ts';

/** Tous les textes par défaut affichés par le composant. */
export const defaultLabels: EmptyCourseStateLabels = {
  title: 'Ce cours est vide',
  userSubtitle:
    "Aucun canal, forum ou quiz pour l'instant. Reviens plus tard, un responsable du cours en ajoutera.",
  adminSubtitle:
    "Aucun canal, forum ou quiz pour l'instant. Crée le premier canal pour lancer les échanges.",
  createChannel: 'Créer un canal',
  createQuiz: 'Créer un Quiz',
  createForum: 'Créer un Forum',
};
