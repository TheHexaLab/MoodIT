import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MatchingQuestion } from './MatchingQuestion';
import { type Question } from '../../../../types/domain';
import { type QuestionAnswer, type QuestionResult } from '../quizAttempt';

afterEach(() => {
  cleanup();
  setElementFromPoint(null);
});

// jsdom n'implémente pas elementFromPoint : on l'installe pour cibler une zone de dépôt.
function setElementFromPoint(el: Element | null) {
  (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
    .elementFromPoint = () => el;
}

/** Puce (étiquette glissable) d'un item par son texte. */
function chip(text: string): HTMLElement {
  return screen.getByText(text).closest('[class*="chip"]') as HTMLElement;
}

/** Déplacement / relâchement du pointeur (écoutés sur window pendant le glissement). */
function firePointer(type: 'pointermove' | 'pointerup' | 'pointercancel', x = 0, y = 0) {
  const ev = new Event(type) as PointerEvent;
  Object.assign(ev, { clientX: x, clientY: y });
  act(() => {
    window.dispatchEvent(ev);
  });
}

/** Fantôme qui suit le pointeur pendant le glissement. */
function ghost(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[class*="dragGhost"]');
}

function matchingQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 1,
    prompt: 'Prompt',
    qType: 'matching',
    totalScore: 4,
    dragItems: [
      { id: 200, content: 'Chien', groupName: 'Animaux' },
      { id: 201, content: 'Rose', groupName: 'Plantes' },
      { id: 202, content: 'Chat', groupName: 'Animaux' },
    ],
    groups: ['Animaux', 'Plantes'],
    ...overrides,
  };
}

const noop = () => {};

/** Zone (pool ou groupe) par son attribut data-zone. */
function zone(container: HTMLElement, name: string): HTMLElement | null {
  return container.querySelector(`[data-zone="${name}"]`);
}

describe('MatchingQuestion — rendu (mode answer)', () => {
  it('affiche le texte d’aide', () => {
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(screen.getByText('Glisse chaque étiquette dans la catégorie qui convient.')).toBeTruthy();
  });

  it('rend une zone par catégorie (question.groups) + la réserve (pool)', () => {
    const { container } = render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(zone(container, '__pool__')).toBeTruthy();
    expect(zone(container, 'Animaux')).toBeTruthy();
    expect(zone(container, 'Plantes')).toBeTruthy();
  });

  it('affiche le libellé de chaque catégorie', () => {
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(screen.getByText('Animaux')).toBeTruthy();
    expect(screen.getByText('Plantes')).toBeTruthy();
  });

  it('sans placement : tous les items sont dans le pool', () => {
    const { container } = render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    const pool = zone(container, '__pool__')!;
    expect(pool.textContent).toContain('Chien');
    expect(pool.textContent).toContain('Rose');
    expect(pool.textContent).toContain('Chat');
  });

  it('placement partiel : items classés dans leur zone, le reste au pool', () => {
    const answer: QuestionAnswer = {
      kind: 'matching',
      placement: { 200: 'Animaux', 201: null, 202: null },
    };
    const { container } = render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={answer}
        onChange={noop}
      />
    );
    const animaux = zone(container, 'Animaux')!;
    const pool = zone(container, '__pool__')!;
    expect(animaux.textContent).toContain('Chien');
    expect(animaux.textContent).not.toContain('Rose');
    expect(pool.textContent).toContain('Rose');
    expect(pool.textContent).toContain('Chat');
    expect(pool.textContent).not.toContain('Chien');
  });

  it('deux items placés dans la même zone y apparaissent tous les deux', () => {
    const answer: QuestionAnswer = {
      kind: 'matching',
      placement: { 200: 'Animaux', 202: 'Animaux', 201: 'Plantes' },
    };
    const { container } = render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={answer}
        onChange={noop}
      />
    );
    const animaux = zone(container, 'Animaux')!;
    expect(animaux.textContent).toContain('Chien');
    expect(animaux.textContent).toContain('Chat');
    expect(zone(container, 'Plantes')!.textContent).toContain('Rose');
    expect(zone(container, '__pool__')!.textContent).toBe('');
  });

  it('sans question.groups : catégories dérivées des groupName des items (triées)', () => {
    const q = matchingQuestion({ groups: undefined });
    const { container } = render(
      <MatchingQuestion question={q} mode="answer" answer={undefined} onChange={noop} />
    );
    expect(zone(container, 'Animaux')).toBeTruthy();
    expect(zone(container, 'Plantes')).toBeTruthy();
  });
});

describe('MatchingQuestion — mode review', () => {
  it('une ligne par item corrigé avec sa catégorie choisie', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 2,
      max: 4,
      matching: [
        { itemId: 200, chosenGroup: 'Animaux', correctGroup: 'Animaux', correct: true },
        { itemId: 201, chosenGroup: 'Animaux', correctGroup: 'Plantes', correct: false },
      ],
    };
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    expect(screen.getByText('Chien')).toBeTruthy();
    expect(screen.getByText('Rose')).toBeTruthy();
    // Deux occurrences de « Animaux » (choix des deux items).
    expect(screen.getAllByText('Animaux')).toHaveLength(2);
  });

  it('item correct → optionCorrect ; incorrect → optionWrong', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 2,
      max: 4,
      matching: [
        { itemId: 200, chosenGroup: 'Animaux', correctGroup: 'Animaux', correct: true },
        { itemId: 201, chosenGroup: 'Animaux', correctGroup: 'Plantes', correct: false },
      ],
    };
    const { container } = render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    // Les lignes externes portent optionCorrect / optionWrong (une par item corrigé).
    const correctRows = container.querySelectorAll('[class*="optionCorrect"]');
    const wrongRows = container.querySelectorAll('[class*="optionWrong"]');
    expect(correctRows).toHaveLength(1);
    expect(wrongRows).toHaveLength(1);
    // La ligne « Chien » (correcte) contient le libellé de sa catégorie.
    expect(correctRows[0].textContent).toContain('Chien');
    expect(wrongRows[0].textContent).toContain('Rose');
  });

  it('chosenGroup null → affiche le libellé « non classé » (unplacedGroup)', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 0,
      max: 4,
      matching: [{ itemId: 200, chosenGroup: null, correctGroup: 'Animaux', correct: false }],
    };
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    // Défaut FR de unplacedGroup = '—'.
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('surcharge du libellé « non classé » via labels', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 0,
      max: 4,
      matching: [{ itemId: 200, chosenGroup: null, correctGroup: 'Animaux', correct: false }],
    };
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
        labels={{ unplacedGroup: 'NON CLASSÉ' }}
      />
    );
    expect(screen.getByText('NON CLASSÉ')).toBeTruthy();
  });

  it('review sans matching : aucune ligne, pas de crash', () => {
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="review"
        answer={undefined}
        result={{ questionId: 1, earned: 0, max: 4 }}
        onChange={noop}
      />
    );
    expect(screen.queryByText('Chien')).toBeNull();
  });

  it('onChange n’est pas appelé au rendu', () => {
    const onChange = vi.fn();
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={undefined}
        onChange={onChange}
      />
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('MatchingQuestion — glisser-déposer (Pointer Events)', () => {
  function renderAnswer(answer: QuestionAnswer | undefined = undefined) {
    const onChange = vi.fn();
    const utils = render(
      <MatchingQuestion question={matchingQuestion()} mode="answer" answer={answer} onChange={onChange} />
    );
    return { onChange, ...utils };
  }

  it('glisser une étiquette de la réserve vers une catégorie la place', () => {
    const { onChange, container } = renderAnswer();
    fireEvent.pointerDown(chip('Chien'), { pointerType: 'mouse', button: 0, clientX: 5, clientY: 6 });
    // Fantôme affiché à la position du pointeur, avec le contenu de l'étiquette.
    const g = ghost(container)!;
    expect(g).toBeTruthy();
    expect(g.textContent).toBe('Chien');
    expect(g.style.left).toBe('5px');
    expect(g.style.top).toBe('6px');
    // La puce d'origine est marquée « en cours de glissement ».
    const dragging = zone(container, '__pool__')!.querySelectorAll('[class*="chipDragging"]');
    expect(dragging).toHaveLength(1);
    expect(dragging[0].textContent).toBe('Chien');

    setElementFromPoint(zone(container, 'Animaux'));
    firePointer('pointerup', 50, 60);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ kind: 'matching', placement: { 200: 'Animaux' } });
    // Fin du geste : plus de fantôme.
    expect(ghost(container)).toBeNull();
  });

  it('le survol met en évidence la zone et le fantôme suit le pointeur', () => {
    const { container } = renderAnswer();
    fireEvent.pointerDown(chip('Rose'), { pointerType: 'mouse', button: 0, clientX: 0, clientY: 0 });
    // Un élément enfant de la zone suffit (closest('[data-zone]')).
    setElementFromPoint(zone(container, 'Plantes')!.querySelector('[class*="groupLabel"]'));
    firePointer('pointermove', 120, 80);
    expect(zone(container, 'Plantes')!.className).toContain('groupOver');
    expect(zone(container, 'Animaux')!.className).not.toContain('groupOver');
    expect(ghost(container)!.style.left).toBe('120px');
    expect(ghost(container)!.style.top).toBe('80px');

    setElementFromPoint(zone(container, '__pool__'));
    firePointer('pointermove', 10, 10);
    expect(zone(container, '__pool__')!.className).toContain('poolOver');
    expect(zone(container, 'Plantes')!.className).not.toContain('groupOver');
  });

  it('conserve les autres placements lors d’un nouveau dépôt', () => {
    const { onChange, container } = renderAnswer({ kind: 'matching', placement: { 201: 'Plantes' } });
    fireEvent.pointerDown(chip('Chat'), { pointerType: 'mouse', button: 0 });
    setElementFromPoint(zone(container, 'Animaux'));
    firePointer('pointerup');
    expect(onChange).toHaveBeenCalledWith({
      kind: 'matching',
      placement: { 201: 'Plantes', 202: 'Animaux' },
    });
  });

  it('déposer une étiquette classée dans la réserve la retire de sa catégorie (null)', () => {
    const { onChange, container } = renderAnswer({
      kind: 'matching',
      placement: { 200: 'Animaux', 201: 'Plantes' },
    });
    fireEvent.pointerDown(chip('Chien'), { pointerType: 'mouse', button: 0 });
    setElementFromPoint(zone(container, '__pool__'));
    firePointer('pointerup');
    expect(onChange).toHaveBeenCalledWith({
      kind: 'matching',
      placement: { 200: null, 201: 'Plantes' },
    });
  });

  it('relâcher dans la zone actuelle ne réécrit pas la réponse (tap)', () => {
    const { onChange, container } = renderAnswer({ kind: 'matching', placement: { 200: 'Animaux' } });
    fireEvent.pointerDown(chip('Chien'), { pointerType: 'mouse', button: 0 });
    setElementFromPoint(zone(container, 'Animaux'));
    firePointer('pointerup');
    expect(onChange).not.toHaveBeenCalled();
    // Idem pour un item non classé relâché dans la réserve.
    fireEvent.pointerDown(chip('Rose'), { pointerType: 'mouse', button: 0 });
    setElementFromPoint(zone(container, '__pool__'));
    firePointer('pointerup');
    expect(onChange).not.toHaveBeenCalled();
    expect(ghost(container)).toBeNull();
  });

  it('relâcher hors de toute zone annule le glissement', () => {
    const { onChange, container } = renderAnswer();
    fireEvent.pointerDown(chip('Chien'), { pointerType: 'mouse', button: 0 });
    setElementFromPoint(null);
    firePointer('pointerup');
    expect(onChange).not.toHaveBeenCalled();
    expect(ghost(container)).toBeNull();
  });

  it('pointercancel termine aussi le glissement', () => {
    const { onChange, container } = renderAnswer();
    fireEvent.pointerDown(chip('Chien'), { pointerType: 'touch' });
    expect(ghost(container)).toBeTruthy();
    setElementFromPoint(null);
    firePointer('pointercancel');
    expect(ghost(container)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('au toucher (tactile), le glissement fonctionne quel que soit le bouton', () => {
    const { onChange, container } = renderAnswer();
    fireEvent.pointerDown(chip('Rose'), { pointerType: 'touch', button: 2 });
    setElementFromPoint(zone(container, 'Plantes'));
    firePointer('pointerup');
    expect(onChange).toHaveBeenCalledWith({ kind: 'matching', placement: { 201: 'Plantes' } });
  });

  it('ignore le clic droit de la souris', () => {
    const { onChange, container } = renderAnswer();
    fireEvent.pointerDown(chip('Chien'), { pointerType: 'mouse', button: 2 });
    expect(ghost(container)).toBeNull();
    setElementFromPoint(zone(container, 'Animaux'));
    firePointer('pointerup');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('après le relâchement, les écouteurs globaux sont retirés', () => {
    const { onChange, container } = renderAnswer();
    fireEvent.pointerDown(chip('Chien'), { pointerType: 'mouse', button: 0 });
    setElementFromPoint(zone(container, 'Animaux'));
    firePointer('pointerup');
    expect(onChange).toHaveBeenCalledTimes(1);
    // Mouvements / relâchements ultérieurs : plus aucun effet.
    firePointer('pointermove', 30, 30);
    expect(ghost(container)).toBeNull();
    expect(zone(container, 'Animaux')!.className).not.toContain('groupOver');
    firePointer('pointerup');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
