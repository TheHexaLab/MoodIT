import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import ForumView from './ForumView';
import { MAX_POST_CONTENT_LENGTH } from '../../../helpers/forumLimits';
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

  it("modérateur : supprimer est présent sur les sujets d'autrui, pas modifier", async () => {
    renderForum([thread(101, { author: other })], { canModerate: true });
    await waitFor(() => expect(screen.getByText('Sujet 101')).toBeTruthy());
    // Le modérateur peut supprimer le sujet d'autrui…
    expect(screen.getByLabelText('Supprimer')).toBeTruthy();
    // …mais pas l'éditer (édition réservée à l'auteur).
    expect(screen.queryByLabelText('Modifier')).toBeNull();
  });

  it("modérateur : supprimer le sujet d'autrui appelle onDeletePost", async () => {
    const onDeletePost = vi.fn().mockResolvedValue(undefined);
    renderForum([thread(101, { author: other })], { canModerate: true, onDeletePost });
    await waitFor(() => expect(screen.getByText('Sujet 101')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Supprimer'));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(onDeletePost).toHaveBeenCalledWith(101));
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

  it('éditeur : dépasser la limite → bouton Enregistrer désactivé (pas de troncature)', async () => {
    renderForum([thread(101, { author: me })]); // titre par défaut 'Sujet 101' (non vide)
    await waitFor(() => expect(screen.getByText('Sujet 101')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Modifier'));
    const editor = screen.getByLabelText('Éditeur Markdown') as HTMLTextAreaElement;
    const tooLong = 'a'.repeat(MAX_POST_CONTENT_LENGTH + 1);
    fireEvent.change(editor, { target: { value: tooLong } });
    // Pas de troncature + le compteur rouge et le bouton Enregistrer désactivé bloquent l'envoi.
    expect(editor.value.length).toBe(MAX_POST_CONTENT_LENGTH + 1);
    expect(
      (screen.getByRole('button', { name: 'Enregistrer' }) as HTMLButtonElement).disabled
    ).toBe(true);
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

/** Réponse (commentaire) d'un sujet, par défaut écrite par `other`. */
function reply(id: number, over: Partial<ForumPost> = {}): ForumPost {
  return {
    id,
    content: `Réponse ${id}`,
    createdAt: '2026-06-07T15:00:00',
    author: other,
    votes: [],
    replyCount: 0,
    ...over,
  };
}

/** Promesse résolue à la demande. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Rend le forum et attend que le sujet `title` soit affiché. */
async function renderLoaded(
  threads: ForumPost[],
  handlers: Partial<React.ComponentProps<typeof ForumView>> = {},
  title = threads[0]?.title ?? ''
) {
  const utils = renderForum(threads, handlers);
  await waitFor(() => expect(screen.getByText(title)).toBeTruthy());
  return utils;
}

/** Éditeurs Markdown ouverts (composer de réponse, édition, nouveau sujet). */
function openEditor(): HTMLElement {
  return document.querySelector('[role^="markdown-editor"]') as HTMLElement;
}

/** Bouton de dépliage des réponses d'un sujet / commentaire (premier trouvé). */
function repliesToggle(scope: HTMLElement | Document = document): HTMLElement {
  return scope.querySelector('[role="replies-toggle"]') as HTMLElement;
}

/** Titres des sujets, dans l'ordre d'affichage. */
function threadTitles(): string[] {
  return Array.from(document.querySelectorAll('[role="thread-title"]')).map(
    (el) => el.textContent ?? ''
  );
}

describe('ForumView — fil de réponses', () => {
  it('déplier charge les réponses (spinner pendant le chargement), replier les masque, sans re-fetch', async () => {
    const children = deferred<ForumPost[]>();
    const onFetchReplies = vi.fn().mockReturnValue(children.promise);
    await renderLoaded([thread(101, { replyCount: 2 })], { onFetchReplies });

    const toggle = repliesToggle();
    expect(toggle.textContent).toContain('2 réponses');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Déplier les réponses');

    fireEvent.click(toggle);
    expect(onFetchReplies).toHaveBeenCalledWith(3, 101);
    expect(screen.getByText('Chargement des réponses…')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Replier les réponses');

    await act(async () => {
      children.resolve([reply(201), reply(202)]);
      await children.promise;
    });
    expect(screen.getByText('Réponse 201')).toBeTruthy();
    expect(screen.getByText('Réponse 202')).toBeTruthy();
    expect(screen.queryByText('Chargement des réponses…')).toBeNull();

    fireEvent.click(repliesToggle());
    expect(screen.queryByText('Réponse 201')).toBeNull();
    // Re-déplier : la branche est déjà chargée, pas de nouvel appel.
    fireEvent.click(repliesToggle());
    expect(screen.getByText('Réponse 201')).toBeTruthy();
    expect(onFetchReplies).toHaveBeenCalledTimes(1);
  });

  it('« 1 réponse » au singulier, « Aucune réponse » sans réponse', async () => {
    await renderLoaded([
      thread(101, { title: 'A', replyCount: 1 }),
      thread(102, { title: 'B', replyCount: 0 }),
    ]);
    expect(screen.getByText('1 réponse')).toBeTruthy();
    expect(screen.getByText('Aucune réponse')).toBeTruthy();
  });

  it('échec du chargement de branche : message + « Réessayer » qui recharge', async () => {
    const onFetchReplies = vi
      .fn()
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce([reply(201)]);
    await renderLoaded([thread(101, { replyCount: 1 })], { onFetchReplies });
    fireEvent.click(repliesToggle());
    const errorBox = await screen.findByText('Impossible de charger les réponses.');
    const retry = within(errorBox.parentElement as HTMLElement).getByRole('button', {
      name: 'Réessayer',
    });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText('Réponse 201')).toBeTruthy());
    expect(onFetchReplies).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Impossible de charger les réponses.')).toBeNull();
  });

  it('commentaire imbriqué : déplier charge son niveau ; le filet vertical replie la branche', async () => {
    const onFetchReplies = vi.fn(async (_forum: number, postId: number) =>
      postId === 101 ? [reply(201, { replyCount: 1 })] : [reply(301)]
    );
    await renderLoaded([thread(101, { replyCount: 1 })], { onFetchReplies });
    fireEvent.click(repliesToggle());
    await waitFor(() => expect(screen.getByText('Réponse 201')).toBeTruthy());

    const comment = screen.getByText('Réponse 201').closest('[role="comment"]') as HTMLElement;
    fireEvent.click(repliesToggle(comment));
    await waitFor(() => expect(screen.getByText('Réponse 301')).toBeTruthy());
    expect(onFetchReplies).toHaveBeenLastCalledWith(3, 201);

    fireEvent.click(comment.querySelector('[role="collapse-rail"]') as HTMLElement);
    expect(screen.queryByText('Réponse 301')).toBeNull();
    // Le sujet reste déplié.
    expect(screen.getByText('Réponse 201')).toBeTruthy();
  });

  it("au-delà du plateau d'indentation, les réponses profondes s'alignent (data-flat, sans filet)", async () => {
    // Chaîne 101 → 201 → 202 → 203 → 204 : chaque niveau a une réponse.
    const chain: Record<number, number> = { 101: 201, 201: 202, 202: 203, 203: 204 };
    const onFetchReplies = vi.fn(async (_forum: number, postId: number) => [
      reply(chain[postId], { replyCount: chain[chain[postId]] ? 1 : 0 }),
    ]);
    await renderLoaded([thread(101, { replyCount: 1 })], { onFetchReplies });
    fireEvent.click(repliesToggle());
    for (const id of [201, 202, 203]) {
      await waitFor(() => expect(screen.getByText(`Réponse ${id}`)).toBeTruthy());
      const comment = screen.getByText(`Réponse ${id}`).closest('[role="comment"]') as HTMLElement;
      fireEvent.click(repliesToggle(comment));
    }
    await waitFor(() => expect(screen.getByText('Réponse 204')).toBeTruthy());
    const deep = screen.getByText('Réponse 203').closest('[role="comment"]') as HTMLElement;
    // Profondeur 3 (plateau) : liste d'enfants plate, aucun filet de repli.
    expect(deep.querySelector(':scope > ul[role="replies"]')?.getAttribute('data-flat')).toBe(
      'true'
    );
    expect(deep.querySelector(':scope > [role="collapse-rail"]')).toBeNull();
    const shallow = screen.getByText('Réponse 201').closest('[role="comment"]') as HTMLElement;
    expect(shallow.querySelector(':scope > [role="replies-wrap"]')).not.toBeNull();
  });
});

describe('ForumView — réponses (rédaction)', () => {
  it('répondre à un sujet replié : charge la branche AVANT de publier, puis affiche la réponse', async () => {
    const onFetchReplies = vi.fn(async () => [reply(201)]);
    const onCreatePost = vi.fn(async (_f: number, content: string) => ({
      ...reply(500, { content, author: me }),
    }));
    await renderLoaded([thread(101, { author: other, replyCount: 1 })], {
      onFetchReplies,
      onCreatePost,
    });
    fireEvent.click(screen.getAllByLabelText('Répondre')[0]);
    const editor = openEditor();
    fireEvent.change(within(editor).getByLabelText('Éditeur Markdown'), {
      target: { value: '  Ma réponse  ' },
    });
    fireEvent.click(within(editor).getByRole('button', { name: 'Répondre' }));

    await waitFor(() => expect(screen.getByText('Ma réponse')).toBeTruthy());
    expect(onCreatePost).toHaveBeenCalledWith(3, 'Ma réponse', 101, expect.any(String));
    expect(onFetchReplies.mock.invocationCallOrder[0]).toBeLessThan(
      onCreatePost.mock.invocationCallOrder[0]
    );
    // La réponse existante est conservée, le composer est fermé, le compteur incrémenté.
    expect(screen.getByText('Réponse 201')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Votre réponse…')).toBeNull();
    expect(repliesToggle().textContent).toContain('2 réponses');
  });

  it('échec de publication : le composer se rouvre avec la saisie et une erreur s’affiche', async () => {
    const onCreatePost = vi.fn(async () => {
      throw new Error('net');
    });
    await renderLoaded([thread(101, { author: other, replies: [], replyCount: 0 })], {
      onCreatePost,
    });
    fireEvent.click(screen.getAllByLabelText('Répondre')[0]);
    fireEvent.change(screen.getByPlaceholderText('Votre réponse…'), {
      target: { value: 'Brouillon' },
    });
    fireEvent.click(within(openEditor()).getByRole('button', { name: 'Répondre' }));

    await waitFor(() =>
      expect(screen.getByText("La réponse n'a pas pu être publiée. Réessayez.")).toBeTruthy()
    );
    const composer = screen.getByPlaceholderText('Votre réponse…') as HTMLTextAreaElement;
    expect(composer.value).toBe('Brouillon');

    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    await waitFor(() =>
      expect(screen.queryByText("La réponse n'a pas pu être publiée. Réessayez.")).toBeNull()
    );
  });

  it('Annuler ferme le composer sans rien publier', async () => {
    const onCreatePost = vi.fn();
    await renderLoaded([thread(101, { author: other })], { onCreatePost });
    fireEvent.click(screen.getAllByLabelText('Répondre')[0]);
    fireEvent.click(within(openEditor()).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByPlaceholderText('Votre réponse…')).toBeNull();
    expect(onCreatePost).not.toHaveBeenCalled();
  });

  it('réponse vide : Ctrl+Entrée ne publie rien (filet de sécurité)', async () => {
    const onCreatePost = vi.fn();
    await renderLoaded([thread(101, { author: other })], { onCreatePost });
    fireEvent.click(screen.getAllByLabelText('Répondre')[0]);
    const composer = screen.getByPlaceholderText('Votre réponse…');
    fireEvent.change(composer, { target: { value: '   ' } });
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true });
    expect(onCreatePost).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Votre réponse…')).toBeTruthy();
  });

  it('répondre à un commentaire ouvre le composer sous ce commentaire', async () => {
    const onCreatePost = vi.fn(async (_f: number, content: string) =>
      reply(600, { content, author: me })
    );
    await renderLoaded(
      [thread(101, { author: other, replies: [reply(201, { replies: [] })], replyCount: 1 })],
      { onCreatePost }
    );
    fireEvent.click(repliesToggle());
    const comment = screen.getByText('Réponse 201').closest('[role="comment"]') as HTMLElement;
    fireEvent.click(within(comment).getByLabelText('Répondre'));
    const composer = within(comment).getByPlaceholderText('Votre réponse…');
    fireEvent.change(composer, { target: { value: 'Sous-réponse' } });
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onCreatePost).toHaveBeenCalledWith(3, 'Sous-réponse', 201, expect.any(String)));
    await waitFor(() => expect(within(comment).getByText('Sous-réponse')).toBeTruthy());
  });
});

describe('ForumView — édition', () => {
  it('enregistre titre + contenu rognés, ferme l’éditeur et affiche la nouvelle version', async () => {
    const onEditPost = vi.fn(async () => undefined);
    await renderLoaded([thread(101, { title: 'Ancien titre', content: 'Ancien contenu' })], {
      onEditPost,
    });
    fireEvent.click(screen.getByLabelText('Modifier'));
    expect((screen.getByLabelText('Éditeur Markdown') as HTMLTextAreaElement).value).toBe(
      'Ancien contenu'
    );
    fireEvent.change(screen.getByLabelText('Titre du sujet'), {
      target: { value: ' Nouveau titre ' },
    });
    fireEvent.change(screen.getByLabelText('Éditeur Markdown'), {
      target: { value: ' Nouveau contenu ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(onEditPost).toHaveBeenCalledWith(101, 'Nouveau contenu', 'Nouveau titre'));
    expect(screen.queryByLabelText('Éditeur Markdown')).toBeNull();
    expect(screen.getByText('Nouveau titre')).toBeTruthy();
    expect(screen.getByText('Nouveau contenu')).toBeTruthy();
  });

  it('titre vidé : Enregistrer désactivé', async () => {
    await renderLoaded([thread(101)]);
    fireEvent.click(screen.getByLabelText('Modifier'));
    fireEvent.change(screen.getByLabelText('Titre du sujet'), { target: { value: '   ' } });
    expect(
      (screen.getByRole('button', { name: 'Enregistrer' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('échec : l’éditeur se rouvre avec la saisie, le contenu d’origine est rétabli, erreur affichée', async () => {
    const onEditPost = vi.fn(async () => {
      throw new Error('net');
    });
    await renderLoaded([thread(101, { title: 'Titre', content: 'Avant' })], { onEditPost });
    fireEvent.click(screen.getByLabelText('Modifier'));
    fireEvent.change(screen.getByLabelText('Titre du sujet'), { target: { value: 'Titre 2' } });
    fireEvent.change(screen.getByLabelText('Éditeur Markdown'), { target: { value: 'Après' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() =>
      expect(
        screen.getByText("La modification n'a pas pu être enregistrée. Réessayez.")
      ).toBeTruthy()
    );
    expect((screen.getByLabelText('Éditeur Markdown') as HTMLTextAreaElement).value).toBe('Après');
    expect((screen.getByLabelText('Titre du sujet') as HTMLInputElement).value).toBe('Titre 2');
    // Le titre affiché au-dessus de l'éditeur est revenu à l'original (rollback).
    expect(document.querySelector('[role="thread-title"]')?.textContent).toBe('Titre');
  });

  it('Annuler restaure l’affichage sans appel serveur', async () => {
    const onEditPost = vi.fn();
    await renderLoaded([thread(101, { content: 'Texte' })], { onEditPost });
    fireEvent.click(screen.getByLabelText('Modifier'));
    fireEvent.change(screen.getByLabelText('Éditeur Markdown'), { target: { value: 'Brouillon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByLabelText('Éditeur Markdown')).toBeNull();
    expect(screen.getByText('Texte')).toBeTruthy();
    expect(onEditPost).not.toHaveBeenCalled();
  });

  it('modifier une réponse : pas de champ titre, envoi sans titre', async () => {
    const onEditPost = vi.fn(async () => undefined);
    await renderLoaded(
      [thread(101, { author: other, replies: [reply(201, { author: me })], replyCount: 1 })],
      { onEditPost }
    );
    fireEvent.click(repliesToggle());
    const comment = screen.getByText('Réponse 201').closest('[role="comment"]') as HTMLElement;
    fireEvent.click(within(comment).getByLabelText('Modifier'));
    expect(screen.queryByLabelText('Titre du sujet')).toBeNull();
    fireEvent.change(within(comment).getByLabelText('Éditeur Markdown'), {
      target: { value: 'Réponse corrigée' },
    });
    fireEvent.click(within(comment).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(onEditPost).toHaveBeenCalledWith(201, 'Réponse corrigée', undefined));
    expect(within(comment).getByText('Réponse corrigée')).toBeTruthy();
  });

  it("ouvrir une réponse pendant l'édition d'un commentaire ferme l'édition", async () => {
    await renderLoaded([
      thread(101, { author: other, replies: [reply(201, { author: me })], replyCount: 1 }),
    ]);
    fireEvent.click(repliesToggle());
    const comment = screen.getByText('Réponse 201').closest('[role="comment"]') as HTMLElement;
    fireEvent.click(within(comment).getByLabelText('Modifier'));
    expect(within(comment).getByLabelText('Éditeur Markdown')).toBeTruthy();
    // « Répondre » du sujet (premier bouton Répondre, hors commentaire).
    fireEvent.click(screen.getAllByLabelText('Répondre')[0]);
    expect(within(comment).queryByPlaceholderText('Modifier le message…')).toBeNull();
    expect(screen.getByPlaceholderText('Votre réponse…')).toBeTruthy();
  });
});

describe('ForumView — suppression', () => {
  it('Annuler dans la confirmation ne supprime rien', async () => {
    const onDeletePost = vi.fn();
    await renderLoaded([thread(101)], { onDeletePost });
    fireEvent.click(screen.getByLabelText('Supprimer'));
    expect(screen.getByText('Supprimer le message')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByText('Supprimer le message')).toBeNull());
    expect(onDeletePost).not.toHaveBeenCalled();
    expect(screen.getByText('Sujet 101')).toBeTruthy();
  });

  it('confirmer retire le sujet de la liste', async () => {
    const onDeletePost = vi.fn(async () => undefined);
    await renderLoaded([thread(101), thread(102)], { onDeletePost });
    const card = screen.getByText('Sujet 101').closest('li') as HTMLElement;
    fireEvent.click(within(card).getByLabelText('Supprimer'));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(screen.queryByText('Sujet 101')).toBeNull());
    expect(screen.getByText('Sujet 102')).toBeTruthy();
  });

  it('échec : le sujet revient et une erreur s’affiche', async () => {
    const onDeletePost = vi.fn(async () => {
      throw new Error('net');
    });
    await renderLoaded([thread(101)], { onDeletePost });
    fireEvent.click(screen.getByLabelText('Supprimer'));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    await waitFor(() =>
      expect(screen.getByText("La suppression n'a pas pu être effectuée. Réessayez.")).toBeTruthy()
    );
    expect(screen.getByText('Sujet 101')).toBeTruthy();
  });

  it('supprimer une réponse décrémente le compteur du sujet', async () => {
    const onDeletePost = vi.fn(async () => undefined);
    await renderLoaded(
      [
        thread(101, {
          author: other,
          replies: [reply(201, { author: me }), reply(202)],
          replyCount: 2,
        }),
      ],
      { onDeletePost }
    );
    fireEvent.click(repliesToggle());
    const comment = screen.getByText('Réponse 201').closest('[role="comment"]') as HTMLElement;
    fireEvent.click(within(comment).getByLabelText('Supprimer'));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(screen.queryByText('Réponse 201')).toBeNull());
    expect(onDeletePost).toHaveBeenCalledWith(201);
    expect(repliesToggle().textContent).toContain('1 réponse');
  });
});

describe('ForumView — nouveau sujet', () => {
  it('publie titre + contenu rognés, revient à la liste et affiche le sujet', async () => {
    const saved = deferred<ForumPost>();
    const onCreatePost = vi.fn().mockReturnValue(saved.promise);
    await renderLoaded([thread(101)], { onCreatePost });
    fireEvent.click(screen.getByText('Nouveau sujet'));
    fireEvent.change(screen.getByLabelText('Titre du sujet'), { target: { value: ' Mon sujet ' } });
    fireEvent.change(screen.getByPlaceholderText('Rédige ton sujet…'), {
      target: { value: ' Mon contenu ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publier' }));
    expect(onCreatePost).toHaveBeenCalledWith(3, 'Mon contenu', null, expect.any(String), 'Mon sujet');
    // Envoi en cours : spinner à la place du libellé, formulaire toujours ouvert.
    expect(screen.queryByRole('button', { name: 'Publier' })).toBeNull();
    expect(screen.getByText('Nouveau post')).toBeTruthy();

    await act(async () => {
      saved.resolve(thread(900, { title: 'Mon sujet', content: 'Mon contenu' }));
      await saved.promise;
    });
    expect(screen.queryByText('Nouveau post')).toBeNull();
    expect(screen.getByText('Mon sujet')).toBeTruthy();
  });

  it('titre vide : Publier désactivé', async () => {
    await renderLoaded([thread(101)]);
    fireEvent.click(screen.getByText('Nouveau sujet'));
    fireEvent.change(screen.getByPlaceholderText('Rédige ton sujet…'), { target: { value: 'x' } });
    expect((screen.getByRole('button', { name: 'Publier' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('échec : le formulaire reste ouvert avec la saisie et une erreur s’affiche', async () => {
    const onCreatePost = vi.fn(async () => {
      throw new Error('net');
    });
    await renderLoaded([thread(101)], { onCreatePost });
    fireEvent.click(screen.getByText('Nouveau sujet'));
    fireEvent.change(screen.getByLabelText('Titre du sujet'), { target: { value: 'T' } });
    fireEvent.change(screen.getByPlaceholderText('Rédige ton sujet…'), { target: { value: 'C' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publier' }));
    await waitFor(() =>
      expect(screen.getByText("Le sujet n'a pas pu être publié. Réessayez.")).toBeTruthy()
    );
    expect(screen.getByText('Nouveau post')).toBeTruthy();
    expect((screen.getByLabelText('Titre du sujet') as HTMLInputElement).value).toBe('T');
    expect((screen.getByRole('button', { name: 'Publier' }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it('Annuler ferme le formulaire ; ré-ouvrir repart d’un brouillon vide', async () => {
    await renderLoaded([thread(101)]);
    fireEvent.click(screen.getByText('Nouveau sujet'));
    fireEvent.change(screen.getByLabelText('Titre du sujet'), { target: { value: 'Brouillon' } });
    // Re-cliquer « Nouveau sujet » pendant la rédaction ne vide pas le brouillon.
    fireEvent.click(screen.getByText('Nouveau sujet'));
    expect((screen.getByLabelText('Titre du sujet') as HTMLInputElement).value).toBe('Brouillon');
    fireEvent.click(within(openEditor()).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByText('Nouveau post')).toBeNull();
    fireEvent.click(screen.getByText('Nouveau sujet'));
    expect((screen.getByLabelText('Titre du sujet') as HTMLInputElement).value).toBe('');
  });

  it('forum vide : le message « vide » est masqué pendant la rédaction', async () => {
    renderForum([]);
    await waitFor(() =>
      expect(screen.getByText("Aucun sujet dans ce forum pour l'instant.")).toBeTruthy()
    );
    fireEvent.click(screen.getByText('Nouveau sujet'));
    expect(screen.queryByText("Aucun sujet dans ce forum pour l'instant.")).toBeNull();
  });
});

describe('ForumView — tri, votes et affichage', () => {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('épinglés d’abord, puis par score (Populaires) ou par date (Récents)', async () => {
    const threads = [
      thread(1, { title: 'Ancien populaire', createdAt: ago(3e8), othersVoteTotal: 9 }),
      thread(2, { title: 'Récent impopulaire', createdAt: ago(1e3), othersVoteTotal: -2 }),
      thread(3, { title: 'Épinglé', createdAt: ago(9e9), isPinned: true }),
    ];
    await renderLoaded(threads, {}, 'Ancien populaire');
    expect(threadTitles()).toEqual(['Épinglé', 'Ancien populaire', 'Récent impopulaire']);
    fireEvent.click(screen.getByRole('button', { name: 'Récents' }));
    expect(threadTitles()).toEqual(['Épinglé', 'Récent impopulaire', 'Ancien populaire']);
    fireEvent.click(screen.getByRole('button', { name: 'Populaires' }));
    expect(threadTitles()).toEqual(['Épinglé', 'Ancien populaire', 'Récent impopulaire']);
    // L'épinglé porte l'indicateur.
    expect(screen.getAllByText('Épinglé').some((el) => el.getAttribute('role') === 'pin-indicator')).toBe(
      true
    );
  });

  it('Populaires : un vote met le score à jour sans déplacer le sujet ; changer de tri reclasse', async () => {
    const onVotePost = vi.fn(async () => undefined);
    await renderLoaded(
      [
        thread(1, { title: 'Premier', author: other, othersVoteTotal: 1 }),
        thread(2, { title: 'Second', author: other, othersVoteTotal: 1 }),
      ],
      { onVotePost },
      'Premier'
    );
    expect(threadTitles()).toEqual(['Premier', 'Second']);

    // « Second » passe à 2 et dépasse « Premier » : il reste pourtant à sa place (pas de saut
    // sous le pointeur), seul son score change.
    const second = screen.getByText('Second').closest('li') as HTMLElement;
    fireEvent.click(within(second).getAllByLabelText('Voter pour')[0]);
    expect(threadTitles()).toEqual(['Premier', 'Second']);
    expect(second.querySelector('[role="up-voted"]')?.textContent).toBe('2');

    // Action explicite (changement de tri) : la liste est reclassée.
    fireEvent.click(screen.getByRole('button', { name: 'Récents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Populaires' }));
    expect(threadTitles()).toEqual(['Second', 'Premier']);
  });

  it('score = votes des autres + vote propre ; voter met à jour le score et aria-pressed', async () => {
    const onVotePost = vi.fn(async () => undefined);
    await renderLoaded([thread(101, { author: other, othersVoteTotal: 4 })], { onVotePost });
    const card = screen.getByText('Sujet 101').closest('li') as HTMLElement;
    const rail = card.querySelector('[role="vertical-vote-actions"]') as HTMLElement;
    expect(rail.querySelector('span')?.textContent).toBe('4');

    fireEvent.click(within(rail).getByLabelText('Voter contre'));
    expect(rail.querySelector('span')?.textContent).toBe('3');
    expect(rail.querySelector('[role="down-voted"]')).not.toBeNull();
    expect(within(rail).getByLabelText('Voter contre').getAttribute('aria-pressed')).toBe('true');
    expect(onVotePost).toHaveBeenCalledWith(101, -1);

    // Re-cliquer la même direction retire le vote.
    fireEvent.click(within(rail).getByLabelText('Voter contre'));
    expect(rail.querySelector('span')?.textContent).toBe('4');
    expect(rail.querySelector('[role="down-voted"]')).toBeNull();

    fireEvent.click(within(rail).getByLabelText('Voter pour'));
    expect(rail.querySelector('[role="up-voted"]')?.textContent).toBe('5');
  });

  it('un vote refusé par le serveur est annulé et affiche une erreur', async () => {
    const onVotePost = vi.fn(async () => {
      throw new Error('net');
    });
    await renderLoaded([thread(101, { author: other })], { onVotePost });
    fireEvent.click(screen.getAllByLabelText('Voter pour')[0]);
    await waitFor(() =>
      expect(screen.getByText("Votre vote n'a pas pu être enregistré. Réessayez.")).toBeTruthy()
    );
    expect(document.querySelector('[role="up-voted"]')).toBeNull();
  });

  it('compacte les grands scores (1234 → « 1,2 k »)', async () => {
    await renderLoaded([thread(101, { othersVoteTotal: 1234 })]);
    expect(screen.getAllByText('1,2 k').length).toBeGreaterThan(0);
  });

  it('cliquer un vote ne bascule pas le panneau d’actions du sujet ; cliquer la carte, si', async () => {
    await renderLoaded([thread(101, { author: other })]);
    const card = screen.getByText('Sujet 101').closest('li') as HTMLElement;
    fireEvent.click(screen.getAllByLabelText('Voter pour')[0]);
    expect(card.getAttribute('data-actions')).toBeNull();
    fireEvent.click(card);
    expect(card.getAttribute('data-actions')).toBe('open');
    fireEvent.click(card);
    expect(card.getAttribute('data-actions')).toBeNull();
  });

  it('cliquer un commentaire ouvre SES actions sans toucher au sujet', async () => {
    await renderLoaded([thread(101, { replies: [reply(201)], replyCount: 1 })]);
    fireEvent.click(repliesToggle());
    const card = screen.getByText('Sujet 101').closest('li') as HTMLElement;
    const comment = screen.getByText('Réponse 201').closest('[role="comment"]') as HTMLElement;
    fireEvent.click(comment);
    expect(comment.getAttribute('data-actions')).toBe('open');
    expect(card.getAttribute('data-actions')).toBeNull();
  });

  it('byline : initiales, nom complet et temps relatif', async () => {
    const threads = [
      thread(1, { title: 'T1', createdAt: ago(10_000) }),
      thread(2, { title: 'T2', createdAt: ago(5 * 60_000) }),
      thread(3, { title: 'T3', createdAt: ago(3 * 3_600_000) }),
      thread(4, { title: 'T4', createdAt: ago(2 * 86_400_000) }),
      thread(5, { title: 'T5', createdAt: '2026-01-15T12:00:00' }),
      thread(6, { title: 'T6', createdAt: 'pas une date' }),
    ];
    await renderLoaded(threads, {}, 'T1');
    const timeOf = (title: string) =>
      (screen.getByText(title).closest('li') as HTMLElement).querySelector('[role="time"]')
        ?.textContent;
    expect(timeOf('T1')).toBe("à l'instant");
    expect(timeOf('T2')).toBe('il y a 5 min');
    expect(timeOf('T3')).toBe('il y a 3 h');
    expect(timeOf('T4')).toBe('il y a 2 j');
    expect(timeOf('T5')).toBe(
      new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short' }).format(
        new Date('2026-01-15T12:00:00')
      )
    );
    expect(timeOf('T6')).toBe('');
    const card = screen.getByText('T1').closest('li') as HTMLElement;
    expect(card.querySelector('[role="avatar"]')?.textContent).toBe('JD');
    expect(card.querySelector('[role="author"]')?.textContent).toBe('Jean D.');
  });

  it('auteur sans prénom ni nom : nom = username, initiale = 1re lettre du username', async () => {
    const anon: ForumAuthor = { id: 7, username: 'zed', firstName: '', lastName: '' };
    await renderLoaded([thread(101, { author: anon })]);
    const card = screen.getByText('Sujet 101').closest('li') as HTMLElement;
    expect(card.querySelector('[role="author"]')?.textContent).toBe('zed');
    expect(card.querySelector('[role="avatar"]')?.textContent).toBe('Z');
    // Couleur d'avatar par défaut.
    expect((card.querySelector('[role="avatar"]') as HTMLElement).style.background).toBe(
      'rgb(10, 92, 192)'
    );
  });

  it("affiche le libellé du cours dans l'en-tête", async () => {
    await renderLoaded([thread(101)]);
    expect(screen.getByText('Génie logiciel')).toBeTruthy();
  });

  it('la prop labels surcharge les textes', async () => {
    await renderLoaded([thread(101)], { labels: { newThread: 'Créer', sortTop: 'Top' } });
    expect(screen.getByText('Créer')).toBeTruthy();
    // Le tri actif porte role="active-sort" (pas « button ») : on le cible par son texte.
    expect(screen.getByText('Top').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Récents' })).toBeTruthy();
  });
});

describe('ForumView — chargement et pagination', () => {
  it('pendant le chargement : spinner, pas de barre d’outils', async () => {
    const pending = deferred<ForumPost[]>();
    render(
      <ForumView
        course={course}
        channel={channel}
        currentUser={me as ChannelMessageAuthor}
        onFetchThreads={() => pending.promise}
      />
    );
    expect(screen.getByText('Chargement en cours…')).toBeTruthy();
    expect(screen.queryByText('Nouveau sujet')).toBeNull();
    await act(async () => {
      pending.resolve([thread(101)]);
      await pending.promise;
    });
    expect(screen.queryByText('Chargement en cours…')).toBeNull();
    expect(screen.getByText('Nouveau sujet')).toBeTruthy();
  });

  it('« Réessayer » après un échec relance le chargement et affiche les sujets', async () => {
    const onFetchThreads = vi
      .fn()
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce([thread(101)]);
    render(
      <ForumView
        course={course}
        channel={channel}
        currentUser={me as ChannelMessageAuthor}
        onFetchThreads={onFetchThreads}
      />
    );
    await waitFor(() =>
      expect(screen.getByText('Impossible de charger les sujets. Réessayez.')).toBeTruthy()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(screen.getByText('Sujet 101')).toBeTruthy());
    expect(onFetchThreads).toHaveBeenCalledTimes(2);
  });

  it('défiler près du bas charge les sujets plus anciens (spinner pendant le chargement)', async () => {
    const first = Array.from({ length: 20 }, (_, i) => thread(200 - i, { title: `S${200 - i}` }));
    const older = deferred<ForumPost[]>();
    const { onFetchThreads } = await renderLoaded(first, {}, 'S200');
    onFetchThreads.mockReturnValueOnce(older.promise);
    const body = document.querySelector('[role="body"]') as HTMLElement;
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 500 });

    // Loin du bas : rien.
    body.scrollTop = 0;
    fireEvent.scroll(body);
    expect(onFetchThreads).toHaveBeenCalledTimes(1);

    // À moins de 120 px du bas : page suivante, curseur = plus petit id.
    body.scrollTop = 400;
    fireEvent.scroll(body);
    expect(onFetchThreads).toHaveBeenLastCalledWith(3, 181, 20);
    expect(body.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    // Pendant le chargement, un nouveau défilement ne relance rien.
    fireEvent.scroll(body);
    expect(onFetchThreads).toHaveBeenCalledTimes(2);

    await act(async () => {
      older.resolve([thread(150, { title: 'S150' })]);
      await older.promise;
    });
    expect(screen.getByText('S150')).toBeTruthy();
    // Dernière page incomplète : plus de chargement au défilement.
    fireEvent.scroll(body);
    expect(onFetchThreads).toHaveBeenCalledTimes(2);
  });

  it('un post poussé par le socket apparaît dans la liste', async () => {
    let push: ((post: ForumPost, parentId: number | null) => void) | null = null;
    const socket = {
      subscribe: vi.fn((_id: number, h: { onPost: typeof push }) => {
        push = h.onPost;
        return () => {};
      }),
    };
    await renderLoaded([thread(101)], { socket: socket as never });
    expect(socket.subscribe).toHaveBeenCalledWith(3, expect.any(Object));
    act(() => push!(thread(102, { title: 'En direct' }), null));
    expect(screen.getByText('En direct')).toBeTruthy();
  });
});
