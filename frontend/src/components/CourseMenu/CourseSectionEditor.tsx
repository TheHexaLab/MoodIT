import React from 'react';
import {
  SectionEditorPopup,
  type ItemChange,
  type MaybePromise,
} from '../SectionEditorPopup/SectionEditorPopup.tsx';
import { getPrefixForType } from '../CourseChannelList/channelTypePrefix.ts';
import {
  type ChannelTypeDefinition,
  type CourseChannel,
} from '../CourseChannelList/CourseChannelList.tsx';

interface CourseSectionEditorProps {
  /** Section éditée (type + libellé). */
  section: ChannelTypeDefinition;
  /** Canaux normalisés du cours (toutes sections confondues). */
  channels: CourseChannel[];
  /**
   * Persiste une modification (ajout/renommage/suppression/réordre). Peut être
   * async ; le popup attend sa résolution et annule (rollback) en cas d'échec.
   */
  onChange?: (change: ItemChange) => MaybePromise<unknown>;
  /** Ferme le popup. */
  onClose: () => void;
}

/**
 * Éditeur d'une section d'un cours (canaux / quiz / forums) : projette les canaux
 * du type concerné dans le format du SectionEditorPopup et compose ses libellés.
 *
 * Réutilisé par CourseMenu (crayon d'édition d'une section) ET par les boutons
 * « Créer un canal/quiz/forum » des états vides du MainPanel : même popup, mêmes
 * actions. La création se fait via le bouton « Ajouter » du popup.
 */
export function CourseSectionEditor({
  section,
  channels,
  onChange,
  onClose,
}: CourseSectionEditorProps): React.ReactElement {
  const items = channels
    .filter((channel) => channel.type === section.type)
    .map((channel) => ({ id: String(channel.id), name: channel.name }));

  return (
    <SectionEditorPopup
      itemList={items}
      prefix={getPrefixForType(section.type).trim()}
      onClose={onClose}
      onChange={onChange}
      labels={sectionPopupLabels(section)}
    />
  );
}

function sectionPrefixLabel(type: string): string {
  switch (type) {
    case 'quiz':
      return "Le quiz";
    case 'forum':
      return "Le forum";
    case 'text':
      return "Le canal";
    default:
      return "L'élément";
  }
}

/** Libellés du popup d'édition, adaptés au type de section. */
function sectionPopupLabels(section: ChannelTypeDefinition) {
  const singular = sectionSingular(section.type);
  return {
    title: `Modifier les ${section.label.toLowerCase()}`,
    subtitle: `Glisse pour réorganiser · ajoute, modifie ou supprime ${singular.article}${singular.noun}`,
    addButton: `Ajouter ${singular.article}${singular.noun}`,
    emptyMessage: `Aucun ${singular.noun} pour le moment.`,
    addTitle: `Nouveau ${singular.noun}`,
    editTitle: `Modifier ${singular.article}${singular.noun}`,
    deleteTitle: `Supprimer ${singular.article}${singular.noun} ?`,
    deleteBody: (item: { name: string }) =>
      `${sectionPrefixLabel(section.type)} « ${item.name} » et tout son contenu seront définitivement supprimés. Cette action est irréversible.`,
  };
}

/** Nom singulier d'un type de section (pour composer les libellés du popup). */
function sectionSingular(type: string): { noun: string; article: string } {
  switch (type) {
    case 'quiz':
      return { noun: 'quiz', article: 'un ' };
    case 'forum':
      return { noun: 'forum', article: 'un ' };
    case 'text':
      return { noun: 'canal', article: 'un ' };
    default:
      return { noun: 'élément', article: 'un ' };
  }
}
