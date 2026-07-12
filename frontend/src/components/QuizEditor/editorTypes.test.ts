import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LANGUAGES,
  FALLBACK_LANGUAGES,
  defaultStartCode,
  defaultHarness,
  emptyQuestionDraft,
  questionToDraft,
  draftToQuestion,
} from './editorTypes';
import { type Language, type Question, type QuestionTypeOption } from '../../types/domain';

/**
 * Tests unitaires directs des helpers PURS de l'éditeur : construction de drafts par
 * type, aller-retour Question ↔ draft, résolution des gabarits code/harnais.
 */

describe('FALLBACK_LANGUAGES', () => {
  it('se réduit à Python et C', () => {
    expect(FALLBACK_LANGUAGES.map((l) => l.name).sort()).toEqual(['C', 'Python']);
  });
});

describe('defaultStartCode', () => {
  it('renvoie une chaîne vide sans langage', () => {
    expect(defaultStartCode(undefined)).toBe('');
  });

  it('privilégie le gabarit backend (start_code_template)', () => {
    const lang: Language = { id: 99, name: 'Python', startCodeTemplate: 'BACKEND' };
    expect(defaultStartCode(lang)).toBe('BACKEND');
  });

  it('replie sur le squelette local par nom (insensible à la casse)', () => {
    const code = defaultStartCode({ id: 1, name: 'PYTHON' });
    expect(code).toContain('def solution()');
  });

  it('renvoie une chaîne vide pour un langage inconnu sans gabarit', () => {
    expect(defaultStartCode({ id: 42, name: 'Brainfuck' })).toBe('');
  });
});

describe('defaultHarness', () => {
  it('privilégie le gabarit du langage de la question (harnessTemplate)', () => {
    const questionLang: Language = { id: 1, name: 'HTML', harnessTemplate: 'HARNESS_BACKEND' };
    expect(defaultHarness(questionLang, undefined)).toBe('HARNESS_BACKEND');
  });

  it('replie sur le squelette du langage de HARNAIS quand fourni', () => {
    const questionLang: Language = { id: 10, name: 'HTML' };
    const harnessLang: Language = { id: 2, name: 'JavaScript' };
    const out = defaultHarness(questionLang, harnessLang);
    // squelette JS générique
    expect(out).toContain('false');
    expect(out.startsWith('//')).toBe(true);
  });

  it('replie sur le langage de la question si aucun langage de harnais', () => {
    const questionLang: Language = { id: 6, name: 'C' };
    const out = defaultHarness(questionLang, undefined);
    // squelette C : renvoie 0 si correct
    expect(out).toContain('0');
  });

  it('renvoie une chaîne vide si rien de connu', () => {
    expect(defaultHarness(undefined, undefined)).toBe('');
    expect(defaultHarness({ id: 1, name: 'Inconnu' }, undefined)).toBe('');
  });
});

describe('emptyQuestionDraft', () => {
  it('true_false : 2 options figées Vrai/Faux avec Vrai correct', () => {
    const d = emptyQuestionDraft('true_false');
    expect(d.qType).toBe('true_false');
    expect(d.prompt).toBe('');
    expect(d.totalScore).toBe(1);
    expect(d.answers).toEqual([
      { content: 'Vrai', isCorrect: true },
      { content: 'Faux', isCorrect: false },
    ]);
  });

  it('single_choice / multiple_choice : 2 options vides, première correcte', () => {
    for (const type of ['single_choice', 'multiple_choice'] as const) {
      const d = emptyQuestionDraft(type);
      expect(d.answers).toHaveLength(2);
      expect(d.answers?.[0]).toEqual({ content: '', isCorrect: true });
      expect(d.answers?.[1]).toEqual({ content: '', isCorrect: false });
    }
  });

  it('ordering : 2 éléments avec correctOrder 0 et 1', () => {
    const d = emptyQuestionDraft('ordering');
    expect(d.dragItems).toEqual([
      { content: '', correctOrder: 0 },
      { content: '', correctOrder: 1 },
    ]);
  });

  it('matching : 2 éléments avec groupName vide', () => {
    const d = emptyQuestionDraft('matching');
    expect(d.dragItems).toHaveLength(2);
    expect(d.dragItems?.[0]).toEqual({ content: '', correctOrder: 0, groupName: '' });
  });

  it('coding : langage par défaut + code de départ + harnais vides', () => {
    const d = emptyQuestionDraft('coding');
    expect(d.languageId).toBe(DEFAULT_LANGUAGES[0].id);
    expect(d.startCode).toBe(defaultStartCode(DEFAULT_LANGUAGES[0]));
    expect(d.testCases).toEqual([]);
  });
});

describe('questionToDraft', () => {
  it('copie les champs et dérive languageId depuis language', () => {
    const q: Question = {
      id: 7,
      qType: 'coding',
      prompt: 'énoncé',
      totalScore: 3,
      language: { id: 5, name: 'Java' },
      startCode: 'code',
      testCases: [{ id: 1, name: 'cas', harnessCode: 'h', weight: 2 }],
    };
    const d = questionToDraft(q);
    expect(d.id).toBe(7);
    expect(d.languageId).toBe(5);
    expect(d.startCode).toBe('code');
    expect(d.testCases).toEqual([{ id: 1, name: 'cas', harnessCode: 'h', weight: 2 }]);
  });

  it('clone les tableaux enfants (pas de partage de référence)', () => {
    const q: Question = {
      id: 1,
      qType: 'single_choice',
      prompt: 'p',
      totalScore: 1,
      answers: [{ id: 3, content: 'a', isCorrect: true }],
    };
    const d = questionToDraft(q);
    expect(d.answers).not.toBe(q.answers);
    expect(d.answers?.[0]).not.toBe(q.answers?.[0]);
    expect(d.answers?.[0]).toEqual({ id: 3, content: 'a', isCorrect: true });
  });

  it('languageId indéfini quand la question n\'a pas de langage', () => {
    const q: Question = { id: 1, qType: 'true_false', prompt: 'p', totalScore: 1 };
    expect(questionToDraft(q).languageId).toBeUndefined();
  });
});

describe('draftToQuestion', () => {
  it('attribue des ids négatifs aux enfants sans id', () => {
    const q = draftToQuestion(
      {
        qType: 'single_choice',
        prompt: 'p',
        totalScore: 2,
        answers: [
          { content: 'a', isCorrect: true },
          { id: 42, content: 'b', isCorrect: false },
        ],
      },
      -1
    );
    expect(q.id).toBe(-1);
    expect(q.answers?.[0].id).toBe(-1); // sans id → -(0+1)
    expect(q.answers?.[1].id).toBe(42); // id existant conservé
  });

  it('résout qTypeId via la liste des types', () => {
    const types: QuestionTypeOption[] = [
      { id: 100, slug: 'coding', label: 'Code' },
      { id: 200, slug: 'single_choice', label: 'Choix unique' },
    ];
    const q = draftToQuestion(
      { qType: 'coding', prompt: 'p', totalScore: 1, languageId: 1, testCases: [] },
      -1,
      DEFAULT_LANGUAGES,
      types
    );
    expect(q.qTypeId).toBe(100);
  });

  it('qTypeId indéfini si la liste des types est absente', () => {
    const q = draftToQuestion({ qType: 'true_false', prompt: 'p', totalScore: 1 }, -1);
    expect(q.qTypeId).toBeUndefined();
  });

  it('code : résout language depuis la liste par languageId', () => {
    const q = draftToQuestion(
      { qType: 'coding', prompt: 'p', totalScore: 1, languageId: 6, testCases: [] },
      -1,
      DEFAULT_LANGUAGES
    );
    expect(q.language).toEqual({ id: 6, name: 'C' });
  });

  it('code : repli Python si languageId introuvable dans la liste', () => {
    const q = draftToQuestion(
      { qType: 'coding', prompt: 'p', totalScore: 1, languageId: 999, testCases: [] },
      -1,
      DEFAULT_LANGUAGES
    );
    expect(q.language).toEqual({ id: 999, name: 'Python' });
  });

  it('non-code : language reste indéfini', () => {
    const q = draftToQuestion(
      { qType: 'ordering', prompt: 'p', totalScore: 1, dragItems: [{ content: 'x', correctOrder: 0 }] },
      -1,
      DEFAULT_LANGUAGES
    );
    expect(q.language).toBeUndefined();
  });

  it('dragItems : correctOrder par défaut 0 et groupName null', () => {
    const q = draftToQuestion(
      { qType: 'matching', prompt: 'p', totalScore: 1, dragItems: [{ content: 'x', correctOrder: 0 }] },
      -1
    );
    expect(q.dragItems?.[0]).toMatchObject({ content: 'x', correctOrder: 0, groupName: null });
  });

  it('testCases : ids négatifs pour les nouveaux harnais', () => {
    const q = draftToQuestion(
      {
        qType: 'coding',
        prompt: 'p',
        totalScore: 1,
        languageId: 1,
        testCases: [
          { name: 'c1', harnessCode: 'h1', weight: 1 },
          { name: 'c2', harnessCode: 'h2', weight: 2 },
        ],
      },
      -5,
      DEFAULT_LANGUAGES
    );
    expect(q.testCases?.map((t) => t.id)).toEqual([-1, -2]);
  });
});
