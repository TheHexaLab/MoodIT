import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ForumView from './ForumView';
import type { ForumPost, ForumAuthor } from './forumThreads';
import type { Course } from '../../CourseMenu/CourseMenu';
import type { CourseChannel, ChannelMessageAuthor } from '../../CourseChannelList/CourseChannelList';

// jsdom ne fournit pas ResizeObserver (utilisé par le MarkdownEditor d'édition/réponse).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// jsdom ne fournit pas Element.scrollTo (appelé par ForumView.startCompose pour révéler le formulaire).
if (!HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = () => {};
}

// jsdom ne fournit pas matchMedia ; le popup de suppression y lit prefers-reduced-motion.
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

const me: ForumAuthor = {
  id: 1,
  username: 'jean',
  firstName: 'Jean',
  lastName: 'D.',
  avatarColor: '#1f4799',
};
const other: ForumAuthor = {
  id: 2,
  username: 'rosie',
  firstName: 'Rosie',
  lastName: 'HG',
  avatarColor: '#0a5cc0',
};

const course: Course = { id: 1, title: 'Génie logiciel' };
const channel: CourseChannel = { id: 3, name: 'questions-lab', type: 'Thread' };

function thread(id: number, over: Partial<ForumPost> = {}): ForumPost {
  return {
    id,
    title: `Sujet ${id}`,
    content: `Contenu ${id}`,
    createdAt: '2026-06-07T14:12:00',
    author: me,
    votes: [],
    replyCount: 0,
    ...over,
  };
}

/** Rend un ForumView dont les sujets racines viennent de `threads` (handler mocké). */
function renderForum(
  threads: ForumPost[],
  handlers: Partial<React.ComponentProps<typeof ForumView>> = {}
) {
  const onFetchThreads = vi.fn().mockResolvedValue(threads);
  const currentUser = me as ChannelMessageAuthor;
  const utils = render(
    <ForumView
      course={course}
      channel={channel}
      currentUser={currentUser}
      onFetchThreads={onFetchThreads}
      {...handlers}
    />
  );
  return { ...utils, onFetchThreads };
}

describe('ForumView', () => {
  it('affiche les sujets fournis après chargement', async () => {
    renderForum([thread(101, { title: 'Erreur de segmentation' })]);
    await waitFor(() => expect(screen.getByText('Erreur de segmentation')).toBeTruthy());
    expect(screen.getByText('Contenu 101')).toBeTruthy();
  });

  it("affiche l'état vide quand aucun sujet", async () => {
    renderForum([]);
    await waitFor(() =>
      expect(screen.getByText("Aucun sujet dans ce forum pour l'instant.")).toBeTruthy()
    );
  });

  it("affiche le nom du canal dans l'en-tête", async () => {
    renderForum([thread(101)]);
    await waitFor(() => expect(screen.getByText('questions-lab')).toBeTruthy());
  });

  it('voter vers le haut appelle onVotePost', async () => {
    const onVotePost = vi.fn().mockResolvedValue(undefined);
    // Sujet d'un AUTRE auteur : on peut voter (pas sa propre publication).
    renderForum([thread(101, { author: other })], { onVotePost });
    await waitFor(() => expect(screen.getByText('Sujet 101')).toBeTruthy());
    // Plusieurs contrôles de vote (vertical + mobile) : on prend le premier.
    fireEvent.click(screen.getAllByLabelText('Voter pour')[0]);
    await waitFor(() => expect(onVotePost).toHaveBeenCalledWith(101, 1));
  });

  it('on ne peut pas voter sur sa propre publication (bouton désactivé)', async () => {
    renderForum([thread(101, { author: me })]);
    await waitFor(() => expect(screen.getByText('Sujet 101')).toBeTruthy());
    const upBtn = screen.getAllByLabelText('Voter pour')[0] as HTMLButtonElement;
    expect(upBtn.disabled).toBe(true);
  });

  it('les actions modifier/supprimer sont présentes sur ses propres sujets', async () => {
    renderForum([thread(101, { author: me })]);
    await waitFor(() => expect(screen.getByText('Sujet 101')).toBeTruthy());
    expect(screen.getByLabelText('Modifier')).toBeTruthy();
    expect(screen.getByLabelText('Supprimer')).toBeTruthy();
  });

  it("les actions modifier/supprimer sont absentes sur les sujets d'autrui", async () => {
    renderForum([thread(101, { author: other })]);
    await waitFor(() => expect(screen.getByText('Sujet 101')).toBeTruthy());
    expect(screen.queryByLabelText('Modifier')).toBeNull();
    expect(screen.queryByLabelText('Supprimer')).toBeNull();
  });

  it('supprimer un sujet ouvre la confirmation qui appelle onDeletePost', async () => {
    const onDeletePost = vi.fn().mockResolvedValue(undefined);
    renderForum([thread(101, { author: me })], { onDeletePost });
    await waitFor(() => expect(screen.getByText('Sujet 101')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Supprimer'));
    // Popup de confirmation : bouton « Supprimer » (texte).
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(onDeletePost).toHaveBeenCalledWith(101));
  });

  it('modifier un sujet ouvre un éditeur inline avec le titre courant', async () => {
    renderForum([thread(101, { author: me, title: 'Titre initial' })]);
    await waitFor(() => expect(screen.getByText('Titre initial')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Modifier'));
    const titleInput = screen.getByLabelText('Titre du sujet') as HTMLInputElement;
    expect(titleInput.value).toBe('Titre initial');
  });

  it("le bouton « Répondre » ouvre le composer de réponse", async () => {
    renderForum([thread(101, { author: other })]);
    await waitFor(() => expect(screen.getByText('Sujet 101')).toBeTruthy());
    // Le bouton répondre porte role="answer" → cible par libellé.
    fireEvent.click(screen.getAllByLabelText('Répondre')[0]);
    // Le composer (MarkdownEditor) apparaît avec le placeholder de réponse.
    await waitFor(() => expect(screen.getByPlaceholderText('Votre réponse…')).toBeTruthy());
  });

  it('le bouton « Nouveau sujet » ouvre le formulaire de composition', async () => {
    renderForum([thread(101)]);
    await waitFor(() => expect(screen.getByText('Sujet 101')).toBeTruthy());
    fireEvent.click(screen.getByText('Nouveau sujet'));
    // Le formulaire affiche son titre + un champ titre.
    expect(screen.getByText('Nouveau post')).toBeTruthy();
    expect(screen.getByPlaceholderText('Rédige ton sujet…')).toBeTruthy();
  });

  it('bascule le tri sur « Récents »', async () => {
    renderForum([thread(101)]);
    await waitFor(() => expect(screen.getByText('Sujet 101')).toBeTruthy());
    const recentBtn = screen.getByRole('button', { name: 'Récents' });
    fireEvent.click(recentBtn);
    expect(recentBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it("affiche l'état d'erreur et « Réessayer » si le chargement échoue", async () => {
    const onFetchThreads = vi.fn().mockRejectedValue(new Error('réseau'));
    render(
      <ForumView
        course={course}
        channel={channel}
        currentUser={me as ChannelMessageAuthor}
        onFetchThreads={onFetchThreads}
      />
    );
    await waitFor(() => expect(screen.getByText('Réessayer')).toBeTruthy());
  });
});
