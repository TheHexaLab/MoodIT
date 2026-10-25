import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MAX_POST_CONTENT_LENGTH } from '../../../helpers/forumLimits';
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

  it('modérateur : la corbeille apparaît AUSSI sur les messages d\'autrui', () => {
    renderChannel([msg(1, me, 'Le mien'), msg(2, other, 'Le sien')], { canModerate: true });
    // Un modérateur peut supprimer les deux messages (le sien + celui d'autrui).
    expect(screen.getAllByLabelText('Supprimer le message').length).toBe(2);
    // Mais l'ÉDITION reste réservée à l'auteur → un seul stylo (son propre message).
    expect(screen.getAllByLabelText('Modifier le message').length).toBe(1);
  });

  it('modérateur : supprimer le message d\'autrui appelle onDeleteMessage', async () => {
    const onDeleteMessage = vi.fn().mockResolvedValue(undefined);
    renderChannel([msg(2, other, "Message d'autrui")], { canModerate: true, onDeleteMessage });
    fireEvent.click(screen.getByLabelText('Supprimer le message'));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(onDeleteMessage).toHaveBeenCalledWith(2));
  });

  it('dépasser la limite : erreur inline dans le bandeau + envoi bloqué (pas de troncature)', () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    renderChannel([msg(1, me, 'Hi')], { onSendMessage });
    const input = screen.getByLabelText('Envoyer un message dans general') as HTMLInputElement;
    const tooLong = 'a'.repeat(MAX_POST_CONTENT_LENGTH + 1);
    fireEvent.change(input, { target: { value: tooLong } });
    // Pas de troncature.
    expect(input.value.length).toBe(MAX_POST_CONTENT_LENGTH + 1);
    // Erreur affichée EN DIRECT (bandeau style « répondre à… ») + bouton d'envoi désactivé.
    expect(screen.getByText(/limite de .* dépassée/i)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Envoyer le message' }) as HTMLButtonElement).disabled
    ).toBe(true);
    // La touche Entrée n'envoie rien.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSendMessage).not.toHaveBeenCalled();
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

describe('ChannelView — réponses et références au message parent', () => {
  it('une réponse affiche un aperçu tronqué du parent et y fait défiler au clic', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const longParent = `Ligne un\n   ${'x'.repeat(80)}`;
    renderChannel([msg(1, other, longParent), { ...msg(2, me, 'Ma réponse'), postParentId: 1 }]);

    // Aperçu sur une ligne (espaces normalisés) coupé à 64 caractères + ellipse.
    const expected = `${`Ligne un ${'x'.repeat(80)}`.slice(0, 64)}…`;
    const ref = screen.getByText(expected).closest('button') as HTMLButtonElement;
    expect(ref.disabled).toBe(false);
    // Initiales de l'auteur du parent dans la référence.
    expect(ref.textContent).toContain('RH');

    fireEvent.click(ref);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    // L'élément défilé est bien le <li> du message parent.
    expect((scrollIntoView.mock.contexts[0] as HTMLElement).textContent).toContain('Ligne un');
  });

  it('un aperçu court n’est pas tronqué', () => {
    renderChannel([msg(1, other, 'Court'), { ...msg(2, me, 'Rép'), postParentId: 1 }]);
    const ref = screen.getAllByText('Court').find((el) => el.closest('button'));
    expect(ref?.textContent).toBe('Court');
  });

  it('parent introuvable : référence désactivée « Message original supprimé »', () => {
    renderChannel([{ ...msg(2, me, 'Orpheline'), postParentId: 999 }]);
    const ref = screen.getByText('Message original supprimé').closest('button') as HTMLButtonElement;
    expect(ref.disabled).toBe(true);
  });

  it('répondre puis envoyer transmet l’id du parent et ferme la barre de réponse', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    renderChannel([msg(7, other, 'Question ?')], { onSendMessage });
    fireEvent.click(screen.getByLabelText('Répondre au message'));
    const input = screen.getByLabelText('Envoyer un message dans general') as HTMLInputElement;
    // Le composer reçoit le focus à l'ouverture de la réponse.
    expect(document.activeElement).toBe(input);
    expect(screen.getByText('Rosie HG', { selector: 'strong' })).toBeTruthy();

    fireEvent.change(input, { target: { value: 'Voici' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(onSendMessage).toHaveBeenCalledWith(5, 'Voici', 7, expect.any(String))
    );
    expect(screen.queryByLabelText('Annuler la réponse')).toBeNull();
  });

  it('le ✕ de la barre annule la réponse (envoi suivant sans parent)', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    renderChannel([msg(7, other, 'Question ?')], { onSendMessage });
    fireEvent.click(screen.getByLabelText('Répondre au message'));
    fireEvent.click(screen.getByLabelText('Annuler la réponse'));
    expect(screen.queryByText(/Répondre à/)).toBeNull();

    const input = screen.getByLabelText('Envoyer un message dans general');
    fireEvent.change(input, { target: { value: 'Racine' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(onSendMessage).toHaveBeenCalledWith(5, 'Racine', null, expect.any(String))
    );
  });

  it('Maj+Entrée n’envoie pas le message', () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    renderChannel([msg(1, me, 'Hi')], { onSendMessage });
    const input = screen.getByLabelText('Envoyer un message dans general');
    fireEvent.change(input, { target: { value: 'Pas encore' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSendMessage).not.toHaveBeenCalled();
  });
});

describe('ChannelView — échec d’envoi', () => {
  it('restaure le brouillon et la réponse, puis affiche une erreur en popup refermable', async () => {
    const onSendMessage = vi.fn().mockRejectedValue(new Error('500'));
    renderChannel([msg(7, other, 'Question ?')], { onSendMessage });
    fireEvent.click(screen.getByLabelText('Répondre au message'));
    const input = screen.getByLabelText('Envoyer un message dans general') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Raté' } });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer le message' }));

    await waitFor(() =>
      expect(screen.getByText("Le message n'a pas pu être envoyé. Réessayez.")).toBeTruthy()
    );
    expect(input.value).toBe('Raté');
    expect(screen.getByLabelText('Annuler la réponse')).toBeTruthy();
    // Le message optimiste a été retiré de la liste (le brouillon restauré dans le champ
    // multiligne, un <textarea>, ne compte pas).
    expect(screen.queryAllByText('Raté', { ignore: 'textarea, script, style' }).length).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    await waitFor(() =>
      expect(screen.queryByText("Le message n'a pas pu être envoyé. Réessayez.")).toBeNull()
    );
  });
});

describe('ChannelView — édition inline', () => {
  function openEditor() {
    const onEditMessage = vi.fn().mockResolvedValue(undefined);
    renderChannel([msg(1, me, 'Original')], { onEditMessage });
    fireEvent.click(screen.getByRole('button', { name: 'Modifier le message' }));
    const input = screen.getByLabelText('Modifier le message') as HTMLInputElement;
    return { onEditMessage, input };
  }

  it('pré-remplit l’éditeur avec le contenu et masque les actions du message', () => {
    const { input } = openEditor();
    expect(input.value).toBe('Original');
    expect(screen.queryByLabelText('Répondre au message')).toBeNull();
  });

  it('Entrée valide la modification (contenu nettoyé)', async () => {
    const { onEditMessage, input } = openEditor();
    fireEvent.change(input, { target: { value: '  Corrigé  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onEditMessage).toHaveBeenCalledWith(1, 'Corrigé'));
    expect(screen.queryByRole('editor')).toBeNull();
  });

  it('Échap annule sans appeler onEditMessage', () => {
    const { onEditMessage, input } = openEditor();
    fireEvent.change(input, { target: { value: 'Brouillon' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('editor')).toBeNull();
    expect(screen.getByText('Original')).toBeTruthy();
    expect(onEditMessage).not.toHaveBeenCalled();
  });

  it('Maj+Entrée ne valide pas', () => {
    const { onEditMessage, input } = openEditor();
    fireEvent.change(input, { target: { value: 'Autre' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.getByRole('editor')).toBeTruthy();
    expect(onEditMessage).not.toHaveBeenCalled();
  });

  it('le bouton Annuler ferme l’éditeur', () => {
    const { onEditMessage } = openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('editor')).toBeNull();
    expect(onEditMessage).not.toHaveBeenCalled();
  });

  it('contenu inchangé ou vide : ferme l’éditeur sans appel réseau', () => {
    const { onEditMessage, input } = openEditor();
    fireEvent.keyDown(input, { key: 'Enter' }); // inchangé
    expect(screen.queryByRole('editor')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Modifier le message' }));
    const again = screen.getByLabelText('Modifier le message');
    fireEvent.change(again, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(screen.queryByRole('editor')).toBeNull();
    expect(onEditMessage).not.toHaveBeenCalled();
  });

  it('dépassement de limite : erreur sous le champ, Enregistrer désactivé et Entrée sans effet', () => {
    const { onEditMessage, input } = openEditor();
    fireEvent.change(input, { target: { value: 'b'.repeat(MAX_POST_CONTENT_LENGTH + 1) } });
    expect(screen.getByText(/limite de .* dépassée/i)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Enregistrer' }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    // L'éditeur reste ouvert, rien n'est envoyé.
    expect(screen.getByRole('editor')).toBeTruthy();
    expect(onEditMessage).not.toHaveBeenCalled();
  });
});

describe('ChannelView — suppression', () => {
  it('Annuler dans la confirmation ferme le popup sans supprimer', async () => {
    const onDeleteMessage = vi.fn().mockResolvedValue(undefined);
    renderChannel([msg(1, me, 'Gardé')], { onDeleteMessage });
    fireEvent.click(screen.getByLabelText('Supprimer le message'));
    expect(screen.getByText('Ce message sera définitivement supprimé. Continuer ?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() =>
      expect(screen.queryByText('Ce message sera définitivement supprimé. Continuer ?')).toBeNull()
    );
    expect(onDeleteMessage).not.toHaveBeenCalled();
    expect(screen.getByText('Gardé')).toBeTruthy();
  });
});

describe('ChannelView — dates et actions tactiles', () => {
  it('un horodatage invalide n’empêche pas le rendu (heure et séparateur vides)', () => {
    renderChannel([{ ...msg(1, me, 'Sans date'), createdAt: 'pas-une-date' }]);
    expect(screen.getByText('Sans date')).toBeTruthy();
    expect(screen.queryByText(/Invalid/)).toBeNull();
    expect(screen.getByRole('separator').textContent).toBe('');
  });

  it('un séparateur de date par jour distinct', () => {
    renderChannel([
      { ...msg(1, me, 'Lundi'), createdAt: '2026-06-01T10:00:00' },
      { ...msg(2, me, 'Lundi bis'), createdAt: '2026-06-01T11:00:00' },
      { ...msg(3, me, 'Mardi'), createdAt: '2026-06-02T10:00:00' },
    ]);
    const separators = screen.getAllByRole('separator').map((el) => el.textContent);
    expect(separators).toEqual(['1 juin 2026', '2 juin 2026']);
  });

  it('un tap sur un message ouvre puis referme ses actions', () => {
    renderChannel([msg(1, other, 'Tap')]);
    const item = screen.getByText('Tap').closest('li') as HTMLLIElement;
    fireEvent.click(item);
    expect(item.getAttribute('data-actions')).toBe('open');
    fireEvent.click(item);
    expect(item.getAttribute('data-actions')).toBeNull();
  });
});

describe('ChannelView — chargement et pagination', () => {
  /** Page de `count` messages d'ids consécutifs à partir de `firstId`. */
  function page(firstId: number, count: number): ChannelMessage[] {
    return Array.from({ length: count }, (_, i) => ({
      ...msg(firstId + i, other, `m${firstId + i}`),
      createdAt: `2026-06-07T10:${String(i).padStart(2, '0')}:00`,
    }));
  }

  /** Installe des métriques de scroll pilotables sur la liste (jsdom n'a pas de layout). */
  function mockScrollMetrics(list: HTMLElement, metrics: { height: number; client: number }) {
    let top = 0;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => metrics.height });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => metrics.client });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
  }

  it('affiche le chargement puis l’erreur, et Réessayer relance le chargement', async () => {
    const onFetchMessages = vi
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce([msg(1, other, 'Revenu')]);
    renderChannel([], { onFetchMessages });
    expect(screen.getByText('Chargement en cours…')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText('Impossible de charger les messages. Réessayez.')).toBeTruthy()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(screen.getByText('Revenu')).toBeTruthy());
    expect(onFetchMessages).toHaveBeenNthCalledWith(2, 5, undefined, 30);
  });

  it('défiler près du haut charge la page plus ancienne et conserve la position de lecture', async () => {
    let resolveOlder: (m: ChannelMessage[]) => void = () => {};
    const onFetchMessages = vi
      .fn()
      .mockResolvedValueOnce(page(100, 30))
      .mockReturnValueOnce(new Promise((r) => (resolveOlder = r)));
    renderChannel([], { onFetchMessages });
    await waitFor(() => expect(screen.getByText('m100')).toBeTruthy());

    const list = screen.getByText('m100').closest('ul') as HTMLUListElement;
    const metrics = { height: 1000, client: 300 };
    mockScrollMetrics(list, metrics);

    // Loin du haut : rien n'est chargé.
    list.scrollTop = 500;
    fireEvent.scroll(list);
    expect(onFetchMessages).toHaveBeenCalledTimes(1);

    // Près du haut : chargement de la page précédente (curseur = plus petit id).
    list.scrollTop = 20;
    fireEvent.scroll(list);
    expect(onFetchMessages).toHaveBeenLastCalledWith(5, 100, 30);
    // Indicateur de chargement en haut de liste.
    await waitFor(() => expect(list.querySelector('li[aria-live="polite"]')).not.toBeNull());

    // Un second scroll pendant le chargement ne relance pas de requête.
    fireEvent.scroll(list);
    expect(onFetchMessages).toHaveBeenCalledTimes(2);

    // Le prepend ajoute 400 px en haut : la position est décalée d'autant.
    metrics.height = 1400;
    await act(async () => resolveOlder(page(70, 5)));
    expect(screen.getByText('m70')).toBeTruthy();
    expect(list.scrollTop).toBe(1400 - 1000 + 20);
    expect(list.querySelector('li[aria-live="polite"]')).toBeNull();

    // Page incomplète (5 < 30) : plus rien à charger.
    list.scrollTop = 0;
    fireEvent.scroll(list);
    expect(onFetchMessages).toHaveBeenCalledTimes(2);
  });

  it('envoyer son message ramène en bas même si l’utilisateur avait remonté la liste', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    renderChannel([msg(1, other, 'Premier')], { onSendMessage });
    const list = screen.getByText('Premier').closest('ul') as HTMLUListElement;
    const metrics = { height: 1000, client: 300 };
    mockScrollMetrics(list, metrics);

    // Remonté loin du bas (1000 - 200 - 300 = 500 ≥ 80) : l'auto-scroll est suspendu.
    list.scrollTop = 200;
    fireEvent.scroll(list);
    const input = screen.getByLabelText('Envoyer un message dans general');
    fireEvent.change(input, { target: { value: 'Le mien' } });
    metrics.height = 1100;
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Le mien')).toBeTruthy());
    expect(list.scrollTop).toBe(1100);
  });
});

// Champ d'édition multiligne : hauteur ajustée au contenu (barre de défilement seulement sur un
// vrai débordement) et zone d'édition gardée visible dans le fil pendant la frappe.
describe('ChannelView — hauteur et suivi du champ d’édition', () => {
  const realGetComputedStyle = window.getComputedStyle;

  function stubTextareaLayout(scrollHeight: number, maxHeight: string) {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
      el instanceof HTMLTextAreaElement
        ? ({ maxHeight } as CSSStyleDeclaration)
        : realGetComputedStyle(el, pseudo)
    );
  }

  function openEditor() {
    renderChannel([msg(1, me, 'Original')], { onEditMessage: vi.fn().mockResolvedValue(undefined) });
    fireEvent.click(screen.getByRole('button', { name: 'Modifier le message' }));
    return screen.getByLabelText('Modifier le message') as HTMLTextAreaElement;
  }

  afterEach(() => {
    delete (HTMLTextAreaElement.prototype as unknown as { scrollHeight?: number }).scrollHeight;
    vi.restoreAllMocks();
  });

  it('le contenu tient sous la hauteur max : hauteur = contenu, pas de barre de défilement', () => {
    stubTextareaLayout(60, '160px');
    const input = openEditor();
    expect(input.style.height).toBe('60px');
    expect(input.style.overflowY).toBe('hidden');
  });

  it('le contenu déborde : hauteur plafonnée et défilement activé', () => {
    stubTextareaLayout(300, '160px');
    const input = openEditor();
    expect(input.style.height).toBe('160px');
    expect(input.style.overflowY).toBe('auto');
  });

  it('pendant la frappe, le fil défile pour garder le bas du champ visible', () => {
    stubTextareaLayout(60, '160px');
    const input = openEditor();
    const list = input.closest('ul') as HTMLUListElement;
    list.scrollTop = 100;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      return (this === input ? { top: 380, bottom: 450 } : { top: 0, bottom: 400 }) as DOMRect;
    });
    input.focus();
    fireEvent.change(input, { target: { value: 'Original\nplus long' } });
    expect(list.scrollTop).toBe(100 + 50 + 8); // dépassement + marge de 8 px
  });

  it('champ au-dessus du fil visible : le fil remonte jusqu’à lui', () => {
    stubTextareaLayout(60, '160px');
    const input = openEditor();
    const list = input.closest('ul') as HTMLUListElement;
    list.scrollTop = 100;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      return (this === input ? { top: 20, bottom: 80 } : { top: 50, bottom: 400 }) as DOMRect;
    });
    input.focus();
    fireEvent.change(input, { target: { value: 'Original !' } });
    expect(list.scrollTop).toBe(100 - 30 - 8);
  });
});

// Clavier virtuel (iOS) : la portion du viewport masquée est exposée en `--keyboard-inset` pour
// remonter la zone de saisie au-dessus du clavier.
describe('ChannelView — décalage du clavier mobile', () => {
  function stubVisualViewport(height: number) {
    const listeners: Record<string, () => void> = {};
    const vv = {
      height,
      offsetTop: 0,
      addEventListener: vi.fn((type: string, cb: () => void) => {
        listeners[type] = cb;
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('visualViewport', vv);
    return { vv, listeners };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('expose la hauteur masquée par le clavier, la suit, puis la retire au démontage', () => {
    const { vv, listeners } = stubVisualViewport(window.innerHeight - 300);
    const { unmount } = renderChannel([msg(1, me, 'Hi')]);
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--keyboard-inset')).toBe('300px');

    // Le clavier se ferme : plus de décalage.
    vv.height = window.innerHeight;
    act(() => listeners.resize());
    expect(root.style.getPropertyValue('--keyboard-inset')).toBe('0px');

    unmount();
    expect(root.style.getPropertyValue('--keyboard-inset')).toBe('');
    expect(vv.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(vv.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('sans l’API visualViewport (desktop) : aucun décalage', () => {
    vi.stubGlobal('visualViewport', undefined);
    renderChannel([msg(1, me, 'Hi')]);
    expect(document.documentElement.style.getPropertyValue('--keyboard-inset')).toBe('');
  });
});
