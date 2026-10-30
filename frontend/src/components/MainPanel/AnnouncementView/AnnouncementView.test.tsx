import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import AnnouncementView from './AnnouncementView';
import { defaultAnnouncementLabels as t } from './labels';
import { announcementHex } from './announcementColors';
import type { ForumPost, User } from '../../../types/domain';
import type { Course } from '../../CourseMenu/CourseMenu';
import type { ForumSocket, IncomingForumHandlers } from '../ForumView/useForumThreads';

// jsdom ne fournit pas ResizeObserver (utilisé par le MarkdownEditor du formulaire).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// Fermeture immédiate des popups (pas d'animationend sous jsdom), comme les autres tests de popup.
function stubReducedMotion() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

const PROF: User = { id: 2, username: 'prof', firstName: 'Ada', lastName: 'Tremblay' } as User;
const COURSE = { id: 1, code: 'MAT115', title: 'Algèbre' } as Course;
const CHANNEL = { id: 11, name: 'Annonces', type: 'announcement' };

function post(id: number, overrides: Partial<ForumPost> = {}): ForumPost {
  return {
    id,
    title: `Annonce ${id}`,
    content: '',
    createdAt: '2026-10-20T14:00:00Z',
    author: PROF,
    votes: [],
    color: 'blue',
    expiresAt: undefined,
    ...overrides,
  };
}

const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString();
const NEXT_WEEK = new Date(Date.now() + 7 * 86_400_000).toISOString();

beforeEach(stubReducedMotion);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AnnouncementView', () => {
  it('affiche les annonces dans l’ordre reçu (la plus récente en tête), teintées de leur couleur', async () => {
    const fetch = vi.fn().mockResolvedValue([
      post(2, { title: 'Examen déplacé', content: 'Même local.', color: 'red', expiresAt: NEXT_WEEK }),
      post(1, { title: 'Bienvenue' }),
    ]);
    render(
      <AnnouncementView course={COURSE} channel={CHANNEL} canPost onFetchAnnouncements={fetch} />
    );

    const cards = await screen.findAllByRole('listitem');
    expect(cards.map((c) => c.querySelector('h2')?.textContent)).toEqual(['Examen déplacé', 'Bienvenue']);
    expect(cards[0].style.getPropertyValue('--ann-color')).toBe(announcementHex('red'));
    expect(cards[0].textContent).toContain('Même local.');
    expect(cards[0].textContent).toContain(t.expires);
    expect(cards[1].textContent).toContain(t.noExpiry);
  });

  it('étudiant : ne demande pas les expirées, ne voit ni l’expiration ni les boutons', async () => {
    const fetch = vi.fn().mockResolvedValue([post(1, { expiresAt: NEXT_WEEK }), post(2)]);
    render(
      <AnnouncementView course={COURSE} channel={CHANNEL} onFetchAnnouncements={fetch} />
    );

    await screen.findByText('Annonce 1');
    expect(fetch).toHaveBeenCalledWith(11, false);
    expect(screen.queryByText(t.newAnnouncement)).toBeNull();
    expect(screen.queryByLabelText(t.delete)).toBeNull();
    expect(screen.queryByLabelText(t.edit)).toBeNull();
    expect(screen.queryByText(new RegExp(t.expires))).toBeNull();
    expect(screen.queryByText(t.noExpiry)).toBeNull();
  });

  it('personnel : peut supprimer toute annonce du cours, même publiée par un autre', async () => {
    const other = { ...PROF, id: 99, firstName: 'Autre' } as User;
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
        canPost
        onFetchAnnouncements={vi.fn().mockResolvedValue([post(1, { author: other })])}
      />
    );

    expect(await screen.findByLabelText(t.delete)).toBeTruthy();
  });

  it('étudiant : une annonce expirée reçue n’est pas affichée', async () => {
    const fetch = vi.fn().mockResolvedValue([post(1, { expiresAt: YESTERDAY })]);
    render(
      <AnnouncementView course={COURSE} channel={CHANNEL} onFetchAnnouncements={fetch} />
    );

    expect(await screen.findByText(t.emptyTitle)).toBeTruthy();
    expect(screen.getByText(t.emptyStudent)).toBeTruthy();
  });

  it('personnel : demande les expirées et les affiche grisées avec le badge « Expirée »', async () => {
    const fetch = vi.fn().mockResolvedValue([post(1, { expiresAt: YESTERDAY })]);
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
       
        canPost
        onFetchAnnouncements={fetch}
      />
    );

    const card = (await screen.findByText('Annonce 1')).closest('li')!;
    expect(fetch).toHaveBeenCalledWith(11, true);
    expect(card.className).toMatch(/expired/);
    expect(card.textContent).toContain(t.expired);
  });

  it('personnel : publie une annonce, ajoutée en tête de liste', async () => {
    const fetch = vi.fn().mockResolvedValue([post(1, { title: 'Ancienne' })]);
    const create = vi.fn().mockResolvedValue(post(5, { title: 'Nouvelle', color: 'green' }));
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
       
        canPost
        onFetchAnnouncements={fetch}
        onCreateAnnouncement={create}
      />
    );
    await screen.findByText('Ancienne');

    fireEvent.click(screen.getByText(t.newAnnouncement));
    fireEvent.change(screen.getByPlaceholderText(t.titlePlaceholder), { target: { value: ' Nouvelle ' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Vert' }));
    fireEvent.click(screen.getByText(t.publish));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(11, {
        title: 'Nouvelle',
        content: '',
        color: 'green',
        expiresAt: null,
      })
    );
    await waitFor(() => expect(screen.queryByText(t.formSubtitle)).toBeNull());
    const titles = screen.getAllByRole('listitem').map((c) => c.querySelector('h2')?.textContent);
    expect(titles).toEqual(['Nouvelle', 'Ancienne']);
  });

  it('formulaire : le texte s’écrit en Markdown (barre gras / italique), envoyé tel quel', async () => {
    const create = vi.fn().mockResolvedValue(post(7));
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
        canPost
        onFetchAnnouncements={vi.fn().mockResolvedValue([])}
        onCreateAnnouncement={create}
      />
    );
    await screen.findByText(t.emptyStaff);
    fireEvent.click(screen.getByText(t.newAnnouncement));

    expect(screen.getByRole('button', { name: 'Gras' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Italique' })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(t.titlePlaceholder), { target: { value: 'Labo' } });
    fireEvent.change(screen.getByPlaceholderText(t.contentPlaceholder), {
      target: { value: 'Le TP est **mercredi**, *pas* jeudi.' },
    });
    fireEvent.click(screen.getByText(t.publish));

    await waitFor(() =>
      expect(create.mock.calls[0][1].content).toBe('Le TP est **mercredi**, *pas* jeudi.')
    );
  });

  it('carte : le texte Markdown est rendu (gras, italique)', async () => {
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
        onFetchAnnouncements={vi.fn().mockResolvedValue([post(1, { content: 'TP **mercredi**, *pas* jeudi' })])}
      />
    );
    const card = (await screen.findByText('Annonce 1')).closest('li')!;
    expect(card.querySelector('strong')?.textContent).toBe('mercredi');
    expect(card.querySelector('em')?.textContent).toBe('pas');
  });

  it('formulaire : titre obligatoire, date obligatoire si « Jamais » est décoché', async () => {
    const create = vi.fn();
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
       
        canPost
        onFetchAnnouncements={vi.fn().mockResolvedValue([])}
        onCreateAnnouncement={create}
      />
    );
    await screen.findByText(t.emptyStaff);
    fireEvent.click(screen.getByText(t.newAnnouncement));

    fireEvent.click(screen.getByText(t.publish));
    expect(screen.getByRole('alert').textContent).toBe(t.titleRequired);

    fireEvent.change(screen.getByPlaceholderText(t.titlePlaceholder), { target: { value: 'Labo' } });
    fireEvent.click(screen.getByLabelText(t.never));
    fireEvent.click(screen.getByText(t.publish));
    expect(screen.getByRole('alert').textContent).toBe(t.dateRequired);
    expect(create).not.toHaveBeenCalled();
  });

  it('formulaire : une date choisie expire à la fin de cette journée', async () => {
    const create = vi.fn().mockResolvedValue(post(9));
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
       
        canPost
        onFetchAnnouncements={vi.fn().mockResolvedValue([])}
        onCreateAnnouncement={create}
      />
    );
    await screen.findByText(t.emptyStaff);
    fireEvent.click(screen.getByText(t.newAnnouncement));
    fireEvent.change(screen.getByPlaceholderText(t.titlePlaceholder), { target: { value: 'Labo' } });
    fireEvent.click(screen.getByLabelText(t.never));
    fireEvent.change(screen.getByLabelText(t.expiryLabel, { selector: 'input' }), {
      target: { value: '2099-01-15' },
    });
    fireEvent.click(screen.getByText(t.publish));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][1].expiresAt).toBe(new Date('2099-01-15T23:59:59').toISOString());
  });

  it('formulaire : un échec de publication garde le popup ouvert avec une erreur', async () => {
    const create = vi.fn().mockRejectedValue(new Error('500'));
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
       
        canPost
        onFetchAnnouncements={vi.fn().mockResolvedValue([])}
        onCreateAnnouncement={create}
      />
    );
    await screen.findByText(t.emptyStaff);
    fireEvent.click(screen.getByText(t.newAnnouncement));
    fireEvent.change(screen.getByPlaceholderText(t.titlePlaceholder), { target: { value: 'Labo' } });
    fireEvent.click(screen.getByText(t.publish));

    expect((await screen.findByRole('alert')).textContent).toBe(t.publishError);
    expect(screen.getByText(t.formSubtitle)).toBeTruthy();
  });

  it('auteur : supprime son annonce après confirmation', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
       
        canPost
        onFetchAnnouncements={vi.fn().mockResolvedValue([post(1)])}
        onDeleteAnnouncement={remove}
      />
    );
    fireEvent.click(await screen.findByLabelText(t.delete));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(11, 1));
    await waitFor(() => expect(screen.queryByText('Annonce 1')).toBeNull());
  });

  it('personnel : modifie une annonce via le popup pré-rempli', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
        canPost
        onFetchAnnouncements={vi
          .fn()
          .mockResolvedValue([post(1, { title: 'Avant', content: 'texte', color: 'red', expiresAt: NEXT_WEEK })])}
        onUpdateAnnouncement={update}
      />
    );
    fireEvent.click(await screen.findByLabelText(t.edit));

    // Pré-rempli : titre, texte, couleur, et la date (« Jamais » décoché).
    const titleInput = screen.getByPlaceholderText(t.titlePlaceholder) as HTMLInputElement;
    expect(titleInput.value).toBe('Avant');
    expect(screen.getByRole('radio', { name: 'Rouge' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText(t.never) as HTMLInputElement).checked).toBe(false);

    fireEvent.change(titleInput, { target: { value: 'Après' } });
    fireEvent.click(screen.getByLabelText(t.never));
    fireEvent.click(screen.getByText(t.save));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(11, 1, {
        title: 'Après',
        content: 'texte',
        color: 'red',
        expiresAt: null,
      })
    );
    const card = (await screen.findByText('Après')).closest('li')!;
    expect(card.textContent).toContain(t.noExpiry);
  });

  it('modification : une date déjà passée et inchangée reste acceptée', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
        canPost
        onFetchAnnouncements={vi.fn().mockResolvedValue([post(1, { expiresAt: YESTERDAY })])}
        onUpdateAnnouncement={update}
      />
    );
    fireEvent.click(await screen.findByLabelText(t.edit));
    fireEvent.click(screen.getByText(t.save));

    await waitFor(() => expect(update).toHaveBeenCalled());
  });

  it('temps réel : une annonce modifiée par un autre change de couleur et d’expiration', async () => {
    let handlers: IncomingForumHandlers | undefined;
    const socket: ForumSocket = {
      subscribe: vi.fn((_id, h) => {
        handlers = h;
        return () => {};
      }),
    };
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
        canPost
        onFetchAnnouncements={vi.fn().mockResolvedValue([post(1)])}
        socket={socket}
      />
    );
    await screen.findByText('Annonce 1');

    handlers!.onEdit(1, '', 'Renommée', { color: 'pink', expiresAt: NEXT_WEEK });

    const card = (await screen.findByText('Renommée')).closest('li')!;
    expect(card.style.getPropertyValue('--ann-color')).toBe(announcementHex('pink'));
    expect(card.textContent).toContain(t.expires);
  });

  it('étudiant : une annonce disparaît à son heure d’expiration, sans recharger', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const inOneMinute = new Date(Date.now() + 60_000).toISOString();
      render(
        <AnnouncementView
          course={COURSE}
          channel={CHANNEL}
          onFetchAnnouncements={vi.fn().mockResolvedValue([post(1, { title: 'Bientôt finie', expiresAt: inOneMinute })])}
        />
      );
      expect(await screen.findByText('Bientôt finie')).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(61_000);
      });

      expect(screen.queryByText('Bientôt finie')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('« Charger plus » : page suivante demandée avec la dernière annonce comme curseur', async () => {
    const firstPage = Array.from({ length: 20 }, (_, i) => post(100 - i));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([post(50, { title: 'Ancienne' })]);
    render(<AnnouncementView course={COURSE} channel={CHANNEL} onFetchAnnouncements={fetch} />);

    fireEvent.click(await screen.findByText(t.loadMore));

    expect(await screen.findByText('Ancienne')).toBeTruthy();
    expect(fetch).toHaveBeenLastCalledWith(11, false, 81);
    expect(screen.getAllByRole('listitem')).toHaveLength(21);
    // Page incomplète : plus rien à charger.
    expect(screen.queryByText(t.loadMore)).toBeNull();
  });

  it('pas de « Charger plus » quand la première page est incomplète', async () => {
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
        onFetchAnnouncements={vi.fn().mockResolvedValue([post(1)])}
      />
    );
    await screen.findByText('Annonce 1');
    expect(screen.queryByText(t.loadMore)).toBeNull();
  });

  it('chargement en échec : bouton « Réessayer » qui relance le chargement', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce([post(1)]);
    render(
      <AnnouncementView course={COURSE} channel={CHANNEL} onFetchAnnouncements={fetch} />
    );

    fireEvent.click(await screen.findByText(t.retry));
    expect(await screen.findByText('Annonce 1')).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('temps réel : une annonce publiée ou supprimée par un autre apparaît / disparaît', async () => {
    let handlers: IncomingForumHandlers | undefined;
    const socket: ForumSocket = {
      subscribe: vi.fn((_id, h) => {
        handlers = h;
        return () => {};
      }),
    };
    render(
      <AnnouncementView
        course={COURSE}
        channel={CHANNEL}
       
        onFetchAnnouncements={vi.fn().mockResolvedValue([post(1)])}
        socket={socket}
      />
    );
    await screen.findByText('Annonce 1');

    handlers!.onPost(post(2, { title: 'En direct' }), null);
    expect(await screen.findByText('En direct')).toBeTruthy();
    handlers!.onDelete(1);
    await waitFor(() => expect(screen.queryByText('Annonce 1')).toBeNull());
  });
});
