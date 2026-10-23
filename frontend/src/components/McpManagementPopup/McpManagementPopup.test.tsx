import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { McpManagementPopup } from './McpManagementPopup';
import { defaultLabels } from './labels';
import type { McpResponse, McpResponseSummary } from './types';
import type { McpAnalysis } from '../../types/domain';

// Depuis la coquille Popup (#106), la popup est portée dans document.body : le voile n'est plus
// dans le `container` du rendu. Le panneau reste l'enfant direct du voile. Un clic sur le voile ne
// ferme que s'il commence sur le voile (mousedown puis click).
const popupOverlay = () => document.body.querySelector('[data-variant]') as HTMLElement;
const clickBackdrop = (el: HTMLElement = popupOverlay()) => {
  fireEvent.mouseDown(el);
  fireEvent.click(el);
};

// Fermeture immédiate (pas d'attente d'animationend, non émis par jsdom) via reduced-motion.
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce') ? reduce : false,
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

// jsdom ne fournit pas ResizeObserver (utilisé pour animer la hauteur de la modale).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const t = defaultLabels;

type Handlers = Parameters<React.ComponentProps<typeof McpManagementPopup>['subscribeCompletion']>[0];

const SUMMARIES: McpResponseSummary[] = [
  { id: 2, createdAt: '2026-03-10T14:30:00Z', strengthsCount: 3, improvementsCount: 1 },
  { id: 1, createdAt: '2026-02-01T09:00:00Z', strengthsCount: 1, improvementsCount: 2 },
];

const ANALYSIS: McpAnalysis = {
  score: 82,
  summary: 'Cours solide, participation à relancer.',
  dimensions: { content: 90, engagement: 150, success: null, sentiment: -5 },
  strengths: ['Quiz variés', 'Forums actifs'],
  improvements: ['Peu de retours sur les devoirs'],
  recommendations: ['Ajouter un quiz de révision'],
  sources: { quizCount: 4, forumMessageCount: 37, studentCount: 25 },
};

function response(analysis: unknown, id = 2): McpResponse {
  return {
    id,
    createdAt: '2026-03-10T14:30:00Z',
    content: typeof analysis === 'string' ? analysis : JSON.stringify(analysis),
    userId: 7,
    courseId: 5,
  };
}

/** Mêmes conversions que le composant : la date affichée dépend du fuseau de la machine. */
function formatted(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })} · ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

beforeEach(() => {
  stubReducedMotion(true);
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPopup(overrides: Partial<React.ComponentProps<typeof McpManagementPopup>> = {}) {
  let handlers: Handlers | null = null;
  const unsubscribe = vi.fn();
  const props = {
    courseId: 5,
    courseLabel: 'GIF-101 — Programmation',
    loadAnalyses: vi.fn().mockResolvedValue(SUMMARIES),
    loadAnalysis: vi.fn().mockResolvedValue(response(ANALYSIS)),
    loadPending: vi.fn().mockResolvedValue(false),
    subscribeCompletion: vi.fn((h: Handlers) => {
      handlers = h;
      return unsubscribe;
    }),
    onAnalyze: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };
  const utils = render(<McpManagementPopup {...props} />);
  return { ...props, ...utils, unsubscribe, handlers: () => handlers as unknown as Handlers };
}

function analyzeButton() {
  return screen.getByText(t.analyzeTitle).closest('section')!.querySelector('button') as HTMLButtonElement;
}
/** Lignes de l'historique (boutons), dans l'ordre affiché. */
function historyRows() {
  return Array.from(document.querySelectorAll('ul li > button')) as HTMLButtonElement[];
}
async function openFirstDetail() {
  await waitFor(() => expect(historyRows().length).toBeGreaterThan(0));
  fireEvent.click(historyRows()[0]);
  await screen.findByText(t.scoreTitle);
}

describe('McpManagementPopup', () => {
  // ── Liste / historique ──

  it('affiche l’en-tête du cours, un état de chargement, puis l’historique résumé', async () => {
    const { loadAnalyses } = renderPopup();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t.title);
    expect(screen.getByText(t.subtitle('GIF-101 — Programmation'))).toBeTruthy();
    expect(screen.getByText(t.loadingHistory)).toBeTruthy();
    expect(await screen.findByText(t.rowSummary(3, 1))).toBeTruthy();
    expect(screen.getByText(t.rowSummary(1, 2))).toBeTruthy();
    expect(screen.getByText(formatted(SUMMARIES[0].createdAt))).toBeTruthy();
    expect(screen.queryByText(t.loadingHistory)).toBeNull();
    expect(loadAnalyses).toHaveBeenCalledTimes(1);
    expect(t.rowSummary(1, 2)).toBe('1 force · 2 points à améliorer'); // accord du pluriel
  });

  it('une date invalide est affichée telle quelle', async () => {
    renderPopup({
      loadAnalyses: vi.fn().mockResolvedValue([
        { id: 9, createdAt: 'pas-une-date', strengthsCount: 0, improvementsCount: 0 },
      ]),
    });
    expect(await screen.findByText('pas-une-date')).toBeTruthy();
  });

  it('historique vide : message dédié', async () => {
    renderPopup({ loadAnalyses: vi.fn().mockResolvedValue([]) });
    expect(await screen.findByText(t.noAnalyses)).toBeTruthy();
    expect(historyRows()).toHaveLength(0);
  });

  it('échec du chargement → alerte ; « réessayer » relance et affiche la liste', async () => {
    const loadAnalyses = vi
      .fn()
      .mockRejectedValueOnce(new Error('réseau'))
      .mockResolvedValueOnce(SUMMARIES);
    renderPopup({ loadAnalyses });
    expect((await screen.findByRole('alert')).textContent).toContain(t.loadError);
    fireEvent.click(screen.getByText(t.retry));
    expect(await screen.findByText(t.rowSummary(3, 1))).toBeTruthy();
    expect(loadAnalyses).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(t.loadError)).toBeNull();
  });

  it('un retour non-tableau est traité comme une erreur de chargement', async () => {
    renderPopup({ loadAnalyses: vi.fn().mockResolvedValue({ oups: true }) });
    expect(await screen.findByText(t.loadError)).toBeTruthy();
  });

  // ── Lancement d'une analyse ──

  it('« Analyser » appelle onAnalyze, verrouille le bouton et affiche la progression', async () => {
    const { onAnalyze, handlers } = renderPopup();
    await screen.findByText(t.rowSummary(3, 1));
    expect(screen.getByText(t.analyzeDescription)).toBeTruthy();
    fireEvent.click(analyzeButton());
    expect(onAnalyze).toHaveBeenCalledTimes(1);
    expect(analyzeButton().disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe(t.analyzeProgress(''));
    expect(screen.queryByText(t.analyzeDescription)).toBeNull();
    // Étape poussée par le serveur → libellé correspondant.
    act(() => handlers().onProgress('collecting'));
    expect(screen.getByRole('status').textContent).toBe('Collecte des données du cours…');
    // Second clic ignoré (bouton désactivé).
    fireEvent.click(analyzeButton());
    expect(onAnalyze).toHaveBeenCalledTimes(1);
  });

  it('fin de job (onCreated) : l’analyse est ajoutée en tête et le bouton rouvert ; doublon ignoré', async () => {
    const { handlers } = renderPopup();
    await screen.findByText(t.rowSummary(3, 1));
    fireEvent.click(analyzeButton());
    const created = { id: 3, createdAt: '2026-04-01T10:00:00Z', strengthsCount: 5, improvementsCount: 0 };
    act(() => handlers().onCreated(created));
    expect(historyRows()).toHaveLength(3);
    expect(historyRows()[0].textContent).toContain(t.rowSummary(5, 0));
    expect(analyzeButton().disabled).toBe(false);
    expect(screen.getByText(t.analyzeDescription)).toBeTruthy();
    // Même id poussé deux fois (écho WS) : pas de doublon.
    act(() => handlers().onCreated(created));
    expect(historyRows()).toHaveLength(3);
  });

  it('échec du déclenchement (onAnalyze rejette) : ErrorPopup et bouton rouvert', async () => {
    renderPopup({ onAnalyze: vi.fn().mockRejectedValue(new Error('500')) });
    await screen.findByText(t.rowSummary(3, 1));
    fireEvent.click(analyzeButton());
    expect(await screen.findByText(t.analyzeError)).toBeTruthy();
    expect(screen.getByText(t.errorTitle)).toBeTruthy();
    expect(analyzeButton().disabled).toBe(false);
    fireEvent.click(screen.getByText(t.errorClose));
    expect(screen.queryByText(t.analyzeError)).toBeNull();
  });

  it('échec du job (onFailed) : message générique affiché, raison technique seulement loggée', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handlers } = renderPopup();
    await screen.findByText(t.rowSummary(3, 1));
    fireEvent.click(analyzeButton());
    act(() => handlers().onFailed('Service MCP indisponible'));
    expect(screen.getByText(t.analyzeError)).toBeTruthy();
    expect(screen.queryByText('Service MCP indisponible')).toBeNull();
    expect(warn).toHaveBeenCalledWith('Analyse MCP échouée :', 'Service MCP indisponible');
    expect(analyzeButton().disabled).toBe(false);
  });

  it('loadPending = true au montage : l’analyse en cours est réhydratée (bouton verrouillé)', async () => {
    const { loadPending } = renderPopup({ loadPending: vi.fn().mockResolvedValue(true) });
    await waitFor(() => expect(analyzeButton().disabled).toBe(true));
    expect(screen.getByText(t.analyzeProgress(''))).toBeTruthy();
    expect(loadPending).toHaveBeenCalledTimes(1);
  });

  it('un échec de loadPending laisse l’action disponible', async () => {
    renderPopup({ loadPending: vi.fn().mockRejectedValue(new Error('x')) });
    await screen.findByText(t.rowSummary(3, 1));
    expect(analyzeButton().disabled).toBe(false);
  });

  it('onResync : la liste du serveur remplace l’historique et l’état « en cours » est réconcilié', async () => {
    const loadAnalyses = vi.fn().mockResolvedValueOnce(SUMMARIES).mockResolvedValueOnce([SUMMARIES[1]]);
    const loadPending = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { handlers } = renderPopup({ loadAnalyses, loadPending });
    await waitFor(() => expect(analyzeButton().disabled).toBe(true));
    expect(historyRows()).toHaveLength(2);
    act(() => handlers().onResync());
    await waitFor(() => expect(historyRows()).toHaveLength(1));
    expect(historyRows()[0].textContent).toContain(t.rowSummary(1, 2));
    expect(analyzeButton().disabled).toBe(false);
    // Pas de spinner de chargement pendant le resync (refetch silencieux).
    expect(screen.queryByText(t.loadingHistory)).toBeNull();
  });

  it('onResync en échec réseau : l’état courant est conservé', async () => {
    const loadAnalyses = vi.fn().mockResolvedValueOnce(SUMMARIES).mockRejectedValueOnce(new Error('x'));
    const { handlers } = renderPopup({ loadAnalyses });
    await screen.findByText(t.rowSummary(3, 1));
    await act(async () => {
      handlers().onResync();
    });
    expect(historyRows()).toHaveLength(2);
    expect(screen.queryByText(t.loadError)).toBeNull();
  });

  it('s’abonne une fois au montage et se désabonne au démontage', async () => {
    const { subscribeCompletion, unsubscribe, unmount } = renderPopup();
    await screen.findByText(t.rowSummary(3, 1));
    expect(subscribeCompletion).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  // ── Détail d'une analyse ──

  it('cliquer une entrée charge son détail : score, synthèse, dimensions, points forts, sources', async () => {
    let resolve: (r: McpResponse) => void = () => {};
    const loadAnalysis = vi.fn(() => new Promise<McpResponse>((r) => (resolve = r)));
    renderPopup({ loadAnalysis });
    await waitFor(() => expect(historyRows().length).toBe(2));
    fireEvent.click(historyRows()[0]);
    expect(loadAnalysis).toHaveBeenCalledWith(2);
    expect(screen.getByText(t.loadingDetail)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t.detailTitle(''));
    expect(screen.getByText('GIF-101 — Programmation')).toBeTruthy();
    await act(async () => resolve(response(ANALYSIS)));

    expect(screen.getByText('82 %')).toBeTruthy();
    expect(screen.getByText(ANALYSIS.summary!)).toBeTruthy();
    expect(screen.getByText(t.dimensionsLabel)).toBeTruthy();
    // Valeurs bornées à 0–100 ; null → N/D.
    const dimValue = (label: string) =>
      screen.getByText(label).parentElement!.lastElementChild!.textContent;
    expect(dimValue(t.dimContent)).toBe('90');
    expect(dimValue(t.dimEngagement)).toBe('100');
    expect(dimValue(t.dimSuccess)).toBe(t.dimNa);
    expect(dimValue(t.dimSentiment)).toBe('0');
    // Onglet par défaut : points forts.
    expect(screen.getByRole('tab', { name: t.tabStrengths }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Quiz variés')).toBeTruthy();
    expect(screen.getByText('Forums actifs')).toBeTruthy();
    expect(screen.queryByText('Peu de retours sur les devoirs')).toBeNull();
    expect(screen.getByText(t.scopeNote(4, 37, 25))).toBeTruthy();
  });

  it('les onglets basculent entre points forts, à améliorer et recommandations', async () => {
    renderPopup();
    await openFirstDetail();
    fireEvent.click(screen.getByRole('tab', { name: t.tabImprovements }));
    expect(screen.getByText('Peu de retours sur les devoirs')).toBeTruthy();
    expect(screen.queryByText('Quiz variés')).toBeNull();
    expect(screen.getByRole('tab', { name: t.tabImprovements }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: t.tabRecommendations }));
    expect(screen.getByText('Ajouter un quiz de révision')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: t.tabStrengths }));
    expect(screen.getByText('Quiz variés')).toBeTruthy();
  });

  it('sans recommandations, synthèse ni dimensions : onglet et sections absents, onglets vides signalés', async () => {
    renderPopup({
      loadAnalysis: vi.fn().mockResolvedValue(
        response({ score: 60, strengths: [], improvements: [], sources: { quizCount: 0, forumMessageCount: 0, studentCount: 0 } })
      ),
    });
    await openFirstDetail();
    expect(screen.queryByRole('tab', { name: t.tabRecommendations })).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.queryByText(t.summaryLabel)).toBeNull();
    expect(screen.queryByText(t.dimensionsLabel)).toBeNull();
    expect(screen.getByText(t.emptyStrengths)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: t.tabImprovements }));
    expect(screen.getByText(t.emptyImprovements)).toBeTruthy();
  });

  it('recommandations vides mais présentes : l’onglet reste masqué', async () => {
    renderPopup({
      loadAnalysis: vi.fn().mockResolvedValue(response({ ...ANALYSIS, recommendations: [] })),
    });
    await openFirstDetail();
    expect(screen.queryByRole('tab', { name: t.tabRecommendations })).toBeNull();
  });

  it.each([
    [49, /scoreBadgeBad/, /scoreBad/],
    [50, /scoreBadgeWarn/, /scoreWarn/],
    [69, /scoreBadgeWarn/, /scoreWarn/],
  ])('palier du score %i : badge et score colorés en conséquence', async (score, badge, value) => {
    renderPopup({ loadAnalysis: vi.fn().mockResolvedValue(response({ ...ANALYSIS, score })) });
    await openFirstDetail();
    const scoreEl = screen.getByText(`${score} %`);
    expect(scoreEl.className).toMatch(value);
    expect((scoreEl.parentElement!.firstElementChild as HTMLElement).className).toMatch(badge);
  });

  it('palier du score ≥ 70 : aucune classe d’alerte', async () => {
    renderPopup({ loadAnalysis: vi.fn().mockResolvedValue(response({ ...ANALYSIS, score: 70 })) });
    await openFirstDetail();
    const scoreEl = screen.getByText('70 %');
    expect(scoreEl.className).not.toMatch(/scoreBad|scoreWarn/);
    expect((scoreEl.parentElement!.firstElementChild as HTMLElement).className).not.toMatch(/scoreBadgeBad|scoreBadgeWarn/);
  });

  it('échec du détail → alerte ; « réessayer » relance loadAnalysis avec le même id', async () => {
    const loadAnalysis = vi
      .fn()
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce(response(ANALYSIS));
    renderPopup({ loadAnalysis });
    await waitFor(() => expect(historyRows().length).toBe(2));
    fireEvent.click(historyRows()[1]);
    expect((await screen.findByRole('alert')).textContent).toContain(t.detailLoadError);
    fireEvent.click(screen.getByText(t.retry));
    expect(await screen.findByText('82 %')).toBeTruthy();
    expect(loadAnalysis.mock.calls).toEqual([[1], [1]]);
  });

  it.each([
    ['JSON invalide', '{pas du json'],
    ['structure incomplète', JSON.stringify({ score: 10, strengths: 'non' })],
  ])('contenu illisible (%s) → erreur de détail', async (_name, content) => {
    renderPopup({ loadAnalysis: vi.fn().mockResolvedValue(response(content)) });
    await waitFor(() => expect(historyRows().length).toBe(2));
    fireEvent.click(historyRows()[0]);
    expect(await screen.findByText(t.detailLoadError)).toBeTruthy();
    expect(screen.queryByText(t.scoreTitle)).toBeNull();
  });

  it('« Retour » revient à la liste ; rouvrir une analyse repart sur l’onglet points forts', async () => {
    renderPopup();
    await openFirstDetail();
    fireEvent.click(screen.getByRole('tab', { name: t.tabImprovements }));
    fireEvent.click(screen.getByRole('button', { name: t.back }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t.title);
    expect(historyRows()).toHaveLength(2);
    fireEvent.click(historyRows()[0]);
    await screen.findByText(t.scoreTitle);
    expect(screen.getByRole('tab', { name: t.tabStrengths }).getAttribute('aria-selected')).toBe('true');
  });

  it('une réponse de détail périmée (autre analyse ouverte entre-temps) est ignorée', async () => {
    const resolvers: Record<number, (r: McpResponse) => void> = {};
    const loadAnalysis = vi.fn((id: number) => new Promise<McpResponse>((r) => (resolvers[id] = r)));
    renderPopup({ loadAnalysis });
    await waitFor(() => expect(historyRows().length).toBe(2));
    fireEvent.click(historyRows()[0]); // id 2
    fireEvent.click(screen.getByRole('button', { name: t.back }));
    fireEvent.click(historyRows()[1]); // id 1
    await act(async () => resolvers[1](response({ ...ANALYSIS, score: 11 }, 1)));
    await act(async () => resolvers[2](response({ ...ANALYSIS, score: 99 }, 2)));
    expect(screen.getByText('11 %')).toBeTruthy();
    expect(screen.queryByText('99 %')).toBeNull();
  });

  // ── Fermeture / libellés ──

  it('« ✕ » (liste et détail) et le voile appellent onClose', async () => {
    const { onClose } = renderPopup();
    await screen.findByText(t.rowSummary(3, 1));
    fireEvent.click(screen.getByText('✕'));
    clickBackdrop();
    // Un clic DANS la boîte ne ferme pas.
    fireEvent.click(screen.getByText(t.historyLabel));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(historyRows()[0]);
    await screen.findByText(t.scoreTitle);
    fireEvent.click(screen.getByText('✕'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('sans reduced-motion, la fermeture attend la fin de l’animation de sortie', async () => {
    stubReducedMotion(false);
    const { onClose } = renderPopup();
    await screen.findByText(t.rowSummary(3, 1));
    fireEvent.click(screen.getByText('✕'));
    expect(onClose).not.toHaveBeenCalled();
    const scrim = popupOverlay();
    expect(scrim.className).toMatch(/closing/);
    // jsdom n'a pas AnimationEvent : React écoute alors la variante préfixée webkit.
    fireEvent(scrim.firstElementChild as HTMLElement, new Event('webkitAnimationEnd', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surcharge des libellés via labels', async () => {
    renderPopup({ labels: { title: 'Feedback IA', analyzeButton: 'Lancer' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Feedback IA');
    expect(analyzeButton().textContent).toBe('Lancer');
    await screen.findByText(t.rowSummary(3, 1));
  });

  it('libellé de progression : clé connue → texte dédié, clé inconnue → libellé neutre', () => {
    expect(t.analyzeProgress('fallback')).toBe('IA indisponible : analyse de secours…');
    expect(t.analyzeProgress('inconnue')).toBe('Analyse en cours…');
  });
});
