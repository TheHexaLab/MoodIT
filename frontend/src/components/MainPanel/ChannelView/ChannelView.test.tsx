import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ChannelView from './ChannelView';
import type { Course } from '../../CourseMenu/CourseMenu';
import type {
  ChannelMessage,
  ChannelMessageAuthor,
  CourseChannel,
} from '../../CourseChannelList/CourseChannelList';

// jsdom ne fournit pas matchMedia ; le popup de suppression y lit prefers-reduced-motion.
// On force « reduce » pour que la confirmation exécute l'action de façon synchrone (sans
// attendre la fin d'une animation qui ne se déclenche pas sous jsdom).
window.matchMedia = ((query: string) => ({
  matches: query.includes('reduce'),
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

afterEach(cleanup);

const me: ChannelMessageAuthor = {
  id: 1,
  username: 'jean',
  firstName: 'Jean',
  lastName: 'D.',
  avatarColor: '#123456',
};
const other: ChannelMessageAuthor = {
  id: 2,
  username: 'rosie',
  firstName: 'Rosie',
  lastName: 'HG',
  avatarColor: '#0a5cc0',
};

const course: Course = { id: 1, title: 'Génie logiciel' };

function msg(id: number, author: ChannelMessageAuthor, content: string): ChannelMessage {
  return { id, content, createdAt: '2026-06-07T14:12:00', author };
}

/** Rend un ChannelView avec des messages initiaux (via channel.messages, pas de fetch). */
function renderChannel(
  messages: ChannelMessage[],
  handlers: Partial<React.ComponentProps<typeof ChannelView>> = {}
) {
  const channel: CourseChannel = {
    id: 5,
    name: 'general',
    type: 'Discussion',
    messages,
  };
  return render(
    <ChannelView course={course} channel={channel} currentUser={me} {...handlers} />
  );
}

describe('ChannelView', () => {
  it('affiche les messages fournis', () => {
    renderChannel([msg(1, me, 'Bonjour'), msg(2, other, 'Salut à toi')]);
    expect(screen.getByText('Bonjour')).toBeTruthy();
    expect(screen.getByText('Salut à toi')).toBeTruthy();
  });

  it('affiche le nom du canal et le titre du cours dans l\'en-tête', () => {
    renderChannel([msg(1, me, 'Coucou')]);
    expect(screen.getByText('general')).toBeTruthy();
    expect(screen.getByText('Génie logiciel')).toBeTruthy();
  });

  it('affiche l\'état vide quand il n\'y a aucun message', () => {
    renderChannel([]);
    expect(screen.getByText("Aucun message dans ce canal pour l'instant.")).toBeTruthy();
  });

  it('envoie un message : saisie puis clic sur Envoyer appelle onSendMessage', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    renderChannel([msg(1, me, 'Hi')], { onSendMessage });
    const input = screen.getByLabelText('Envoyer un message dans general') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Nouveau message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer le message' }));
    // Handler positionnel : (channelId, content, parentId, clientMessageId).
    await waitFor(() =>
      expect(onSendMessage).toHaveBeenCalledWith(5, 'Nouveau message', null, expect.any(String))
    );
  });

  it('envoie un message avec la touche Entrée', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    renderChannel([msg(1, me, 'Hi')], { onSendMessage });
    const input = screen.getByLabelText('Envoyer un message dans general');
    fireEvent.change(input, { target: { value: 'Via Entrée' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(onSendMessage).toHaveBeenCalledWith(5, 'Via Entrée', null, expect.any(String))
    );
  });

  it('le bouton Envoyer est désactivé quand le brouillon est vide', () => {
    renderChannel([msg(1, me, 'Hi')]);
    const sendBtn = screen.getByRole('button', { name: 'Envoyer le message' }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it('affiche les actions modifier/supprimer sur ses propres messages seulement', () => {
    renderChannel([msg(1, me, 'Le mien'), msg(2, other, 'Le sien')]);
    // Le bouton supprimer porte role="delete" (pas "button") → on cible par libellé.
    // Un seul message est le mien → un seul bouton supprimer.
    const deleteButtons = screen.getAllByLabelText('Supprimer le message');
    expect(deleteButtons.length).toBe(1);
  });

  it('édite un message : le stylo ouvre l\'éditeur, Enregistrer appelle onEditMessage', async () => {
    const onEditMessage = vi.fn().mockResolvedValue(undefined);
    renderChannel([msg(1, me, 'Original')], { onEditMessage });
    fireEvent.click(screen.getByRole('button', { name: 'Modifier le message' }));
    const editInput = screen.getByLabelText('Modifier le message') as HTMLInputElement;
    fireEvent.change(editInput, { target: { value: 'Modifié' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(onEditMessage).toHaveBeenCalledWith(1, 'Modifié'));
  });

  it('supprime un message : la corbeille ouvre la confirmation qui appelle onDeleteMessage', async () => {
    const onDeleteMessage = vi.fn().mockResolvedValue(undefined);
    renderChannel([msg(1, me, 'À supprimer')], { onDeleteMessage });
    // La corbeille (role="delete") ouvre la confirmation.
    fireEvent.click(screen.getByLabelText('Supprimer le message'));
    // Le popup de confirmation : bouton « Supprimer » (texte, role button).
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(onDeleteMessage).toHaveBeenCalledWith(1));
  });

  it('ouvre une réponse : le bouton Répondre affiche la barre "Répondre à"', () => {
    renderChannel([msg(1, other, 'Question ?')]);
    // Avant de répondre : pas de barre « Annuler la réponse ».
    expect(screen.queryByLabelText('Annuler la réponse')).toBeNull();
    // Le bouton répondre porte role="reply" → on cible par libellé.
    fireEvent.click(screen.getByLabelText('Répondre au message'));
    // La barre « Répondre à <auteur> » apparaît (bouton d'annulation propre à la barre).
    expect(screen.getByLabelText('Annuler la réponse')).toBeTruthy();
    expect(screen.getByText(/Répondre à/)).toBeTruthy();
  });
});
