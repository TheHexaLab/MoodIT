import type { SectionEditorPopupLabels } from './types.ts';

/** Tous les textes par défaut affichés par le composant. */
export const defaultLabels: SectionEditorPopupLabels = {
  title: 'Modifier les éléments',
  subtitle: 'Glisse pour réorganiser · ajoute, modifie ou supprime un élément',
  addButton: 'Ajouter un élément',
  emptyMessage: 'Aucun élément pour le moment.',
  addTitle: 'Nouvel élément',
  editTitle: "Modifier l'élément",
  deleteTitle: "Supprimer l'élément ?",
  deleteBody: (item, prefix) =>
    `L'élément « ${prefix ? `${prefix} ` : ''}${item.name} » et tous ses messages seront définitivement supprimés. Cette action est irréversible.`,
  cancel: 'Annuler',
  save: 'Enregistrer',
  hint: 'Lettres minuscules, chiffres et tirets uniquement',
  hintInvalid: '⚠  Lettres minuscules, chiffres et tirets uniquement',
  hintDuplicate: '⚠  Ce nom existe déjà',
  errorTitle: 'Une erreur est survenue',
  saveError: "Échec de l'enregistrement. Réessaie.",
  errorClose: 'Fermer',
};
