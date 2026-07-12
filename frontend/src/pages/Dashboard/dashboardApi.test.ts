import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests de la couche « API » du Dashboard (dashboardApi.ts).
 *
 * Stratégie : on mocke le helper apiFetch (déjà testé à part) pour renvoyer des Response
 * factices ({ ok, status, json }). On vérifie :
 *   - l’URL / la méthode / le corps appelés,
 *   - le MAPPING des réponses (toQuiz / toQuizMeta, forums, votes…),
 *   - les chemins d’erreur (res.ok=false → throw),
 *   - le cas 202 (submitQuiz → { attemptId }) et 409 (établissement → DUPLICATE_DOMAIN).
 */

// Mock du helper réseau : chaque test contrôle la Response renvoyée.
vi.mock('../../helpers/api.ts', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../helpers/api.ts';
import {
  fetchPrograms,
  fetchCourses,
  fetchQuiz,
  fetchQuizForEdit,
  fetchPublishedQuizzes,
  fetchQuizzes,
  fetchQuestionTypes,
  fetchLanguages,
  submitQuiz,
  fetchQuizAttempts,
  fetchAttemptResult,
  evaluateCode,
  runCode,
  createQuiz,
  updateQuiz,
  deleteQuiz,
  reorderQuizzes,
  createEstablishment,
  updateEstablishment,
  DUPLICATE_DOMAIN,
  fetchThreads,
  fetchReplies,
  votePost,
  sendMessage,
} from './dashboardApi.ts';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

/** Fabrique une Response factice. */
function res(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

/** Réponse d’erreur (ok=false). */
function errRes(status = 500): Response {
  return res({}, { ok: false, status });
}

/** Renvoie l’URL/l’init du n-ième appel à apiFetch. */
function callArgs(n = 0): [string, RequestInit | undefined] {
  return mockedApiFetch.mock.calls[n] as [string, RequestInit | undefined];
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  localStorage.clear();
  localStorage.setItem('moodit_user_id', '7');
});

// ── Programmes / cours ─────────────────────────────────────────────────────────

describe('fetchPrograms', () => {
  it('appelle l’endpoint utilisateur et vide les cours de chaque programme', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 1, name: 'P1' }, { id: 2, name: 'P2' }]));
    const out = await fetchPrograms();
    expect(callArgs()[0]).toBe('/api/users/7/programs');
    expect(out).toEqual([
      { id: 1, name: 'P1', courses: [] },
      { id: 2, name: 'P2', courses: [] },
    ]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchPrograms()).rejects.toThrow('Échec chargement des programmes');
  });
});

describe('fetchCourses', () => {
  it('mappe cours + forums (fTypeName→fType) + quizzes', async () => {
    mockedApiFetch.mockResolvedValueOnce(
      res([
        {
          id: 10,
          title: 'Cours A',
          code: 'CA',
          forums: [{ id: 100, title: 'Général', position: 0, fTypeName: 'Discussion' }],
          quizzes: [
            {
              id: 200,
              title: 'Q1',
              position: 1,
              isPublished: true,
              isDaily: false,
              createdAt: '2026-01-01',
            },
          ],
        },
      ])
    );
    const out = await fetchCourses(3);
    expect(callArgs()[0]).toBe('/api/users/7/programs/3/enrollments');
    expect(out).toEqual([
      {
        id: 10,
        title: 'Cours A',
        code: 'CA',
        forums: [{ id: 100, title: 'Général', position: 0, fType: 'Discussion' }],
        quizzes: [
          {
            id: 200,
            title: 'Q1',
            position: 1,
            isPublished: true,
            isDaily: false,
            createdAt: '2026-01-01',
          },
        ],
      },
    ]);
  });

  it('tolère forums/quizzes absents (défaut []) ', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 11, title: 'B', code: 'CB' }]));
    const out = await fetchCourses(3);
    expect(out[0].forums).toEqual([]);
    expect(out[0].quizzes).toEqual([]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchCourses(3)).rejects.toThrow('Échec chargement des cours');
  });
});

// ── Quiz (lecture + mapping toQuiz / toQuizMeta) ────────────────────────────────

const quizDetailResponse = {
  id: 5,
  title: 'Détail',
  position: 2,
  isPublished: true,
  isDaily: false,
  allowRetry: true,
  questions: [
    {
      id: 50,
      prompt: 'P?',
      qType: 'single_choice',
      qTypeId: 2,
      totalScore: 1,
      orderIndex: 0,
      language: null,
      startCode: null,
      answers: [{ id: 500, content: 'A', isCorrect: true }],
      dragItems: [{ id: 600, content: 'D', correctOrder: 1, groupName: 'G' }],
      groups: ['G'],
      testCases: [{ name: 't', harnessCode: 'x', weight: 1 }],
    },
  ],
};

describe('fetchQuiz', () => {
  it('appelle /api/quizzes/:id et mappe via toQuiz', async () => {
    mockedApiFetch.mockResolvedValueOnce(res(quizDetailResponse));
    const out = await fetchQuiz(5);
    expect(callArgs()[0]).toBe('/api/quizzes/5');
    expect(out).toEqual({
      id: 5,
      title: 'Détail',
      position: 2,
      isPublished: true,
      isDaily: false,
      allowRetry: true,
      questions: [
        {
          id: 50,
          prompt: 'P?',
          qType: 'single_choice',
          qTypeId: 2,
          totalScore: 1,
          orderIndex: 0,
          language: null,
          startCode: null,
          answers: [{ id: 500, content: 'A', isCorrect: true }],
          dragItems: [{ id: 600, content: 'D', correctOrder: 1, groupName: 'G' }],
          groups: ['G'],
          testCases: [{ name: 't', harnessCode: 'x', weight: 1 }],
        },
      ],
    });
  });

  it('tolère questions absentes (défaut [])', async () => {
    mockedApiFetch.mockResolvedValueOnce(
      res({ id: 6, title: 'T', position: 0, isPublished: false, isDaily: false, allowRetry: false })
    );
    const out = await fetchQuiz(6);
    expect(out.questions).toEqual([]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchQuiz(5)).rejects.toThrow('Échec chargement du quiz');
  });
});

describe('fetchQuizForEdit', () => {
  it('appelle /api/quizzes/:id/edit', async () => {
    mockedApiFetch.mockResolvedValueOnce(res(quizDetailResponse));
    const out = await fetchQuizForEdit(5);
    expect(callArgs()[0]).toBe('/api/quizzes/5/edit');
    expect(out.id).toBe(5);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchQuizForEdit(5)).rejects.toThrow('Échec chargement du quiz');
  });
});

describe('fetchPublishedQuizzes', () => {
  it('appelle /api/courses/:id/quizzes et mappe via toQuizMeta', async () => {
    mockedApiFetch.mockResolvedValueOnce(
      res([
        {
          id: 1,
          title: 'M',
          position: 0,
          isPublished: true,
          isDaily: false,
          allowRetry: false,
          questionCount: 3,
        },
      ])
    );
    const out = await fetchPublishedQuizzes(9);
    expect(callArgs()[0]).toBe('/api/courses/9/quizzes');
    expect(out).toEqual([
      {
        id: 1,
        title: 'M',
        position: 0,
        isPublished: true,
        isDaily: false,
        allowRetry: false,
        questionCount: 3,
      },
    ]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchPublishedQuizzes(9)).rejects.toThrow('Échec chargement des quiz publiés');
  });
});

describe('fetchQuizzes', () => {
  it('appelle la route /manage', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([]));
    await fetchQuizzes(9);
    expect(callArgs()[0]).toBe('/api/courses/9/quizzes/manage');
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchQuizzes(9)).rejects.toThrow('Échec chargement des quiz');
  });
});

describe('fetchQuestionTypes', () => {
  it('renvoie la liste brute', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 1, name: 'Vrai/Faux' }]));
    const out = await fetchQuestionTypes();
    expect(callArgs()[0]).toBe('/api/question-types');
    expect(out).toEqual([{ id: 1, name: 'Vrai/Faux' }]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchQuestionTypes()).rejects.toThrow('Échec chargement des types de question');
  });
});

describe('fetchLanguages', () => {
  it('renvoie la liste brute', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 1, name: 'Python' }]));
    const out = await fetchLanguages();
    expect(callArgs()[0]).toBe('/api/languages');
    expect(out).toEqual([{ id: 1, name: 'Python' }]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchLanguages()).rejects.toThrow('Échec chargement des langages');
  });
});

// ── Soumission asynchrone (202) ────────────────────────────────────────────────

describe('submitQuiz', () => {
  it('POST vers /api/quizzes/:id/submissions et renvoie { attemptId } (202)', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({ attemptId: 42 }, { ok: true, status: 202 }));
    const submission = { quizId: 5, answers: [{ questionId: 50, answerIds: [500] }] };
    const out = await submitQuiz(submission);
    const [url, init] = callArgs();
    expect(url).toBe('/api/quizzes/5/submissions');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(submission);
    expect(out).toEqual({ attemptId: 42 });
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes(409));
    await expect(
      submitQuiz({ quizId: 5, answers: [] })
    ).rejects.toThrow('Échec de la soumission du quiz');
  });
});

describe('fetchQuizAttempts', () => {
  it('renvoie la liste des tentatives', async () => {
    mockedApiFetch.mockResolvedValueOnce(
      res([{ id: 1, attemptNo: 1, earned: 2, max: 3, submittedAt: '2026-01-01' }])
    );
    const out = await fetchQuizAttempts(5);
    expect(callArgs()[0]).toBe('/api/quizzes/5/attempts');
    expect(out).toEqual([{ id: 1, attemptNo: 1, earned: 2, max: 3, submittedAt: '2026-01-01' }]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchQuizAttempts(5)).rejects.toThrow('Échec chargement des tentatives');
  });
});

describe('fetchAttemptResult', () => {
  it('appelle /api/quizzes/:id/attempts/:attemptId', async () => {
    const result = { quizId: 5, attemptId: 1, earned: 2, max: 3, questions: [] };
    mockedApiFetch.mockResolvedValueOnce(res(result));
    const out = await fetchAttemptResult(5, 1);
    expect(callArgs()[0]).toBe('/api/quizzes/5/attempts/1');
    expect(out).toEqual(result);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchAttemptResult(5, 1)).rejects.toThrow('Échec chargement de la tentative');
  });
});

// ── Exécution de code ──────────────────────────────────────────────────────────

describe('evaluateCode', () => {
  it('POST /exec/evaluate avec language, code et harnais projetés', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ name: 't', passed: true, weight: 1 }]));
    const out = await evaluateCode({
      language: 'Python',
      code: 'print(1)',
      testCases: [
        { name: 't', harnessCode: 'assert', weight: 1, extra: 'ignoré' } as never,
      ],
    });
    const [url, init] = callArgs();
    expect(url).toBe('/exec/evaluate');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      language: 'Python',
      code: 'print(1)',
      testCases: [{ name: 't', harnessCode: 'assert', weight: 1 }],
    });
    expect(out).toEqual([{ name: 't', passed: true, weight: 1 }]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(
      evaluateCode({ language: 'Python', code: '', testCases: [] })
    ).rejects.toThrow("Échec de l'évaluation du code");
  });
});

describe('runCode', () => {
  it('POST /exec/run avec language et code', async () => {
    const runResult = {
      stdout: 'hi',
      stderr: '',
      exitCode: 0,
      signal: null,
      compileOutput: null,
      timedOut: false,
    };
    mockedApiFetch.mockResolvedValueOnce(res(runResult));
    const out = await runCode({ language: 'Python', code: 'print(1)' });
    const [url, init] = callArgs();
    expect(url).toBe('/exec/run');
    expect(JSON.parse(init?.body as string)).toEqual({ language: 'Python', code: 'print(1)' });
    expect(out).toEqual(runResult);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(runCode({ code: '' })).rejects.toThrow("Échec de l'exécution du code");
  });
});

// ── Quiz (écriture) ────────────────────────────────────────────────────────────

describe('createQuiz', () => {
  it('POST vers /api/courses/:id/quizzes et remappe via toQuiz', async () => {
    mockedApiFetch.mockResolvedValueOnce(res(quizDetailResponse));
    const out = await createQuiz(9, { id: -1, title: 'Nouveau' } as never);
    const [url, init] = callArgs();
    expect(url).toBe('/api/courses/9/quizzes');
    expect(init?.method).toBe('POST');
    expect(out.id).toBe(5);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(createQuiz(9, {} as never)).rejects.toThrow('Échec création du quiz');
  });
});

describe('updateQuiz', () => {
  it('PUT vers /api/quizzes/:id et remappe via toQuiz', async () => {
    mockedApiFetch.mockResolvedValueOnce(res(quizDetailResponse));
    const out = await updateQuiz(5, { id: 5, title: 'M' } as never);
    const [url, init] = callArgs();
    expect(url).toBe('/api/quizzes/5');
    expect(init?.method).toBe('PUT');
    expect(out.id).toBe(5);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(updateQuiz(5, {} as never)).rejects.toThrow('Échec modification du quiz');
  });
});

describe('deleteQuiz', () => {
  it('DELETE vers /api/quizzes/:id', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({}, { ok: true, status: 204 }));
    await deleteQuiz(5);
    const [url, init] = callArgs();
    expect(url).toBe('/api/quizzes/5');
    expect(init?.method).toBe('DELETE');
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(deleteQuiz(5)).rejects.toThrow('Échec suppression du quiz');
  });
});

describe('reorderQuizzes', () => {
  it('PATCH vers /reorder avec la liste d’ids', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({}, { ok: true, status: 204 }));
    await reorderQuizzes(9, [3, 1, 2]);
    const [url, init] = callArgs();
    expect(url).toBe('/api/courses/9/quizzes/reorder');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual([3, 1, 2]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(reorderQuizzes(9, [])).rejects.toThrow('Échec réordre des quiz');
  });
});

// ── Établissements (409 → DUPLICATE_DOMAIN) ────────────────────────────────────

describe('createEstablishment', () => {
  it('POST et renvoie l’établissement persisté', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({ id: 1, name: 'E', domainEmail: 'e.com' }));
    const out = await createEstablishment('E', 'e.com');
    const [url, init] = callArgs();
    expect(url).toBe('/api/establishments');
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'E', domainEmail: 'e.com' });
    expect(out).toEqual({ id: 1, name: 'E', domainEmail: 'e.com' });
  });

  it('throw DUPLICATE_DOMAIN sur 409', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes(409));
    await expect(createEstablishment('E', 'e.com')).rejects.toThrow(DUPLICATE_DOMAIN);
  });

  it('throw générique sur autre erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes(500));
    await expect(createEstablishment('E', 'e.com')).rejects.toThrow(
      "Échec de la création de l'établissement"
    );
  });
});

describe('updateEstablishment', () => {
  it('PATCH et renvoie l’établissement à jour', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({ id: 1, name: 'E2', domainEmail: 'e.com' }));
    const out = await updateEstablishment(1, { name: 'E2' });
    const [url, init] = callArgs();
    expect(url).toBe('/api/establishments/1');
    expect(init?.method).toBe('PATCH');
    expect(out.name).toBe('E2');
  });

  it('throw DUPLICATE_DOMAIN sur 409', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes(409));
    await expect(updateEstablishment(1, { domainEmail: 'x' })).rejects.toThrow(DUPLICATE_DOMAIN);
  });

  it('throw générique sur autre erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes(500));
    await expect(updateEstablishment(1, {})).rejects.toThrow(
      "Échec de la modification de l'établissement"
    );
  });
});

// ── Forum (mapping toForumPost) ────────────────────────────────────────────────

describe('fetchThreads', () => {
  it('mappe PostVoteUserDTO → ForumPost (vote propre + othersVoteTotal)', async () => {
    localStorage.setItem('moodit_user_id', '7');
    mockedApiFetch.mockResolvedValueOnce(
      res([
        {
          id: 1,
          content: 'c',
          createdAt: '2026-01-01',
          title: 'T',
          isPinned: false,
          author: { id: 9 },
          userVoteValue: 1,
          voteTotalValue: 5,
          childrenCount: 2,
        },
      ])
    );
    const out = await fetchThreads(4);
    expect(callArgs()[0]).toBe('/api/forums/4/posts?limit=20');
    expect(out[0]).toEqual({
      id: 1,
      content: 'c',
      createdAt: '2026-01-01',
      title: 'T',
      isPinned: false,
      author: { id: 9 },
      votes: [{ userId: 7, value: 1 }],
      othersVoteTotal: 4,
      replyCount: 2,
      replies: undefined,
    });
  });

  it('ajoute le paramètre before quand fourni', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([]));
    await fetchThreads(4, 99, 10);
    expect(callArgs()[0]).toBe('/api/forums/4/posts?limit=10&before=99');
  });

  it('vote propre nul → votes vide et othersVoteTotal = total', async () => {
    mockedApiFetch.mockResolvedValueOnce(
      res([
        {
          id: 2,
          content: 'c',
          createdAt: '2026-01-01',
          isPinned: false,
          author: { id: 9 },
          voteTotalValue: 3,
          childrenCount: 0,
        },
      ])
    );
    const out = await fetchThreads(4);
    expect(out[0].votes).toEqual([]);
    expect(out[0].othersVoteTotal).toBe(3);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchThreads(4)).rejects.toThrow('Échec chargement des sujets');
  });
});

describe('fetchReplies', () => {
  it('appelle l’endpoint dédié /replies', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([]));
    await fetchReplies(4, 1);
    expect(callArgs()[0]).toBe('/api/forums/4/posts/1/replies');
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchReplies(4, 1)).rejects.toThrow('Échec chargement des réponses');
  });
});

describe('votePost', () => {
  it('POST le vote avec la direction brute', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({}, { ok: true, status: 204 }));
    await votePost(4, 1, -1);
    const [url, init] = callArgs();
    expect(url).toBe('/api/forums/posts/votes');
    expect(JSON.parse(init?.body as string)).toEqual({ forumId: 4, postId: 1, voteValue: -1 });
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(votePost(4, 1, 1)).rejects.toThrow('Échec du vote');
  });
});

describe('sendMessage', () => {
  it('POST et reporte le clientMessageId dans le message renvoyé', async () => {
    mockedApiFetch.mockResolvedValueOnce(
      res({
        id: 77,
        content: 'salut',
        createdAt: '2026-01-01',
        author: { id: 7 },
        postParentId: null,
      })
    );
    const out = await sendMessage(4, 'salut', null, 'cid-1');
    const [url, init] = callArgs();
    expect(url).toBe('/api/forums/messages');
    expect(JSON.parse(init?.body as string)).toEqual({
      forumId: 4,
      parentPostId: null,
      content: 'salut',
      clientMessageId: 'cid-1',
    });
    expect(out).toEqual({
      id: 77,
      content: 'salut',
      createdAt: '2026-01-01',
      author: { id: 7 },
      postParentId: null,
      clientMsgId: 'cid-1',
    });
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(sendMessage(4, 'x', null, 'cid')).rejects.toThrow("Échec de l'envoi du message");
  });
});
