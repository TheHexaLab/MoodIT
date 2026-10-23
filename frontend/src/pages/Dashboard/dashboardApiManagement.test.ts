import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests complémentaires de dashboardApi.ts : wrappers non couverts par dashboardApi.test.ts
 * (rôles, journal d'audit, établissements, programmes/cours en écriture, analyses MCP,
 * messages de canal, posts de forum).
 *
 * Même stratégie : apiFetch est mocké et renvoie des Response factices ; on vérifie l'URL,
 * la méthode, le corps envoyé, le mapping de la réponse et le message d'erreur levé.
 */

vi.mock('../../helpers/api.ts', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../helpers/api.ts';
import {
  fetchProgramRoles,
  fetchGlobalRoles,
  fetchAuditLogs,
  fetchGlobalRoleCandidates,
  fetchProgramRoleCandidates,
  changeGlobalRole,
  changeRole,
  fetchEstablishmentsForCreate,
  fetchEstablishmentsForJoin,
  fetchEstablishments,
  deleteEstablishment,
  fetchEstablishmentPrograms,
  fetchManageableProgramsInEstablishment,
  fetchProgramCourses,
  fetchCourseProgramIds,
  fetchJoinedCourseIds,
  fetchCourseAnalyses,
  fetchCourseAnalysis,
  fetchPendingAnalysis,
  requestCourseAnalysis,
  createCourse,
  createProgram,
  joinPrograms,
  updateCourse,
  updateProgram,
  leaveProgram,
  deleteProgram,
  leaveCourse,
  deleteCourse,
  joinCourses,
  changeSection,
  fetchMessages,
  editMessage,
  deleteMessage,
  createPost,
  editPost,
  deletePost,
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

/** Réponse d'erreur (ok=false). */
function errRes(status = 500): Response {
  return res({}, { ok: false, status });
}

/** URL + init du n-ième appel à apiFetch. */
function callArgs(n = 0): [string, RequestInit | undefined] {
  return mockedApiFetch.mock.calls[n] as [string, RequestInit | undefined];
}

/** Corps JSON parsé du n-ième appel. */
function bodyOf(n = 0): unknown {
  return JSON.parse(callArgs(n)[1]?.body as string);
}

/** Réponses routées par URL (pour les appels parallèles via Promise.all). */
function routeByUrl(routes: Record<string, Response>) {
  mockedApiFetch.mockImplementation(async (url: string) => {
    const r = routes[url];
    if (!r) throw new Error(`URL inattendue : ${url}`);
    return r;
  });
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  localStorage.clear();
  localStorage.setItem('moodit_user_id', '7');
});

// ── Rôles ──────────────────────────────────────────────────────────────────────

describe('fetchProgramRoles', () => {
  it('charge rôles (scope=program) + membres et expose role_ids', async () => {
    routeByUrl({
      '/api/roles?scope=program': res([{ id: 1, name: 'Enseignant' }]),
      '/api/programs/3/users': res([
        { id: 10, username: 'a', roles: [1, 2] },
        { id: 11, username: 'b' },
      ]),
    });
    const out = await fetchProgramRoles(3);
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(out.roles).toEqual([{ id: 1, name: 'Enseignant' }]);
    expect(out.users).toEqual([
      { id: 10, username: 'a', roles: [1, 2], role_ids: [1, 2] },
      { id: 11, username: 'b', role_ids: [] },
    ]);
  });

  it('throw si la liste des rôles échoue', async () => {
    routeByUrl({
      '/api/roles?scope=program': errRes(),
      '/api/programs/3/users': res([]),
    });
    await expect(fetchProgramRoles(3)).rejects.toThrow('fetch roles failed');
  });

  it('throw si la liste des membres échoue', async () => {
    routeByUrl({
      '/api/roles?scope=program': res([]),
      '/api/programs/3/users': errRes(403),
    });
    await expect(fetchProgramRoles(3)).rejects.toThrow('fetch roles failed');
  });
});

describe('fetchGlobalRoles', () => {
  it('charge rôles globaux + utilisateurs et expose role_ids', async () => {
    routeByUrl({
      '/api/roles?scope=global': res([{ id: 5, name: 'Gardien' }]),
      '/api/roles/global/users': res([{ id: 1, roles: [5] }, { id: 2 }]),
    });
    const out = await fetchGlobalRoles();
    expect(out.roles).toEqual([{ id: 5, name: 'Gardien' }]);
    expect(out.users).toEqual([
      { id: 1, roles: [5], role_ids: [5] },
      { id: 2, role_ids: [] },
    ]);
  });

  it('throw si l’un des deux appels échoue', async () => {
    routeByUrl({
      '/api/roles?scope=global': res([]),
      '/api/roles/global/users': errRes(403),
    });
    await expect(fetchGlobalRoles()).rejects.toThrow('fetch global roles failed');
  });
});

describe('fetchGlobalRoleCandidates', () => {
  it('passe roleId/search/page/size en query et mappe role_ids', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 4, roles: [2] }, { id: 5 }]));
    const out = await fetchGlobalRoleCandidates(2, 'kar ine', 1, 20);
    const url = new URL(callArgs()[0], 'http://x');
    expect(url.pathname).toBe('/api/roles/global/candidates');
    expect(url.searchParams.get('roleId')).toBe('2');
    expect(url.searchParams.get('search')).toBe('kar ine');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('size')).toBe('20');
    expect(out).toEqual([
      { id: 4, roles: [2], role_ids: [2] },
      { id: 5, role_ids: [] },
    ]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchGlobalRoleCandidates(2, '', 0, 20)).rejects.toThrow(
      'Échec chargement des candidats'
    );
  });
});

describe('fetchProgramRoleCandidates', () => {
  it('cible le programme et passe les paramètres en query', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 8 }]));
    const out = await fetchProgramRoleCandidates(3, 1, 'bob', 2, 10);
    const url = new URL(callArgs()[0], 'http://x');
    expect(url.pathname).toBe('/api/programs/3/role-candidates');
    expect(url.searchParams.get('roleId')).toBe('1');
    expect(url.searchParams.get('search')).toBe('bob');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('size')).toBe('10');
    expect(out).toEqual([{ id: 8, role_ids: [] }]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchProgramRoleCandidates(3, 1, '', 0, 10)).rejects.toThrow(
      'Échec chargement des candidats'
    );
  });
});

describe('changeGlobalRole', () => {
  it('POST /api/roles/global/change avec le changement tel quel', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({}, { status: 204 }));
    const change = { userId: 4, roleId: 2, action: 'add' } as never;
    await changeGlobalRole(change);
    const [url, init] = callArgs();
    expect(url).toBe('/api/roles/global/change');
    expect(init?.method).toBe('POST');
    expect(bodyOf()).toEqual({ userId: 4, roleId: 2, action: 'add' });
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes(403));
    await expect(changeGlobalRole({} as never)).rejects.toThrow(
      'Échec assignation de rôle global'
    );
  });
});

describe('changeRole', () => {
  it('POST /api/roles/change en ajoutant le programId au changement', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({}, { status: 204 }));
    await changeRole(3, { userId: 4, roleId: 1, action: 'remove' } as never);
    const [url, init] = callArgs();
    expect(url).toBe('/api/roles/change');
    expect(init?.method).toBe('POST');
    expect(bodyOf()).toEqual({ userId: 4, roleId: 1, action: 'remove', programId: 3 });
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(changeRole(3, {} as never)).rejects.toThrow('Échec assignation de rôle');
  });
});

// ── Journal d'audit ────────────────────────────────────────────────────────────

describe('fetchAuditLogs', () => {
  it('sans critère : limit=30 seulement', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 1 }]));
    const out = await fetchAuditLogs();
    expect(callArgs()[0]).toBe('/api/audit-logs?limit=30');
    expect(out).toEqual([{ id: 1 }]);
  });

  it('ajoute beforeId, q (rogné) et type quand fournis', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([]));
    await fetchAuditLogs({ beforeId: 50, q: '  cours  ', type: 'COURSE', limit: 10 });
    const url = new URL(callArgs()[0], 'http://x');
    expect(url.pathname).toBe('/api/audit-logs');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('beforeId')).toBe('50');
    expect(url.searchParams.get('q')).toBe('cours');
    expect(url.searchParams.get('type')).toBe('COURSE');
  });

  it('omet q s’il ne contient que des espaces, et beforeId/type nuls', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([]));
    await fetchAuditLogs({ beforeId: null, q: '   ', type: null });
    expect(callArgs()[0]).toBe('/api/audit-logs?limit=30');
  });

  it('conserve beforeId=0 (curseur valide, pas « absent »)', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([]));
    await fetchAuditLogs({ beforeId: 0 });
    expect(new URL(callArgs()[0], 'http://x').searchParams.get('beforeId')).toBe('0');
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes(403));
    await expect(fetchAuditLogs()).rejects.toThrow('fetch audit logs failed');
  });
});

// ── Établissements ─────────────────────────────────────────────────────────────

describe('fetchEstablishmentsForCreate / ForJoin / fetchEstablishments', () => {
  it('fetchEstablishmentsForCreate : GET /api/establishments et renvoie le corps', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 1, name: 'UdeS' }]));
    expect(await fetchEstablishmentsForCreate()).toEqual([{ id: 1, name: 'UdeS' }]);
    expect(callArgs()[0]).toBe('/api/establishments');
  });

  it('fetchEstablishmentsForCreate : throw en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchEstablishmentsForCreate()).rejects.toThrow(
      'Échec chargement des établissements'
    );
  });

  it('fetchEstablishmentsForJoin : GET /api/establishments et renvoie le corps', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 2 }]));
    expect(await fetchEstablishmentsForJoin()).toEqual([{ id: 2 }]);
    expect(callArgs()[0]).toBe('/api/establishments');
  });

  it('fetchEstablishmentsForJoin : throw avec le message « adhésion »', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchEstablishmentsForJoin()).rejects.toThrow(
      'Échec chargement des établissements (adhésion)'
    );
  });

  it('fetchEstablishments : renvoie la liste du gestionnaire', async () => {
    const list = [{ id: 1, name: 'UdeS', domainEmail: 'usherbrooke.ca', programCount: 3 }];
    mockedApiFetch.mockResolvedValueOnce(res(list));
    expect(await fetchEstablishments()).toEqual(list);
    expect(callArgs()[0]).toBe('/api/establishments');
  });

  it('fetchEstablishments : throw en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchEstablishments()).rejects.toThrow('Échec chargement des établissements');
  });
});

describe('deleteEstablishment', () => {
  it('DELETE /api/establishments/:id', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({}, { status: 204 }));
    await deleteEstablishment(4);
    const [url, init] = callArgs();
    expect(url).toBe('/api/establishments/4');
    expect(init?.method).toBe('DELETE');
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(deleteEstablishment(4)).rejects.toThrow(
      "Échec de la suppression de l'établissement"
    );
  });
});

describe('fetchEstablishmentPrograms', () => {
  it('GET /api/establishments/:id/programs', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 9, name: 'Génie info' }]));
    expect(await fetchEstablishmentPrograms(1)).toEqual([{ id: 9, name: 'Génie info' }]);
    expect(callArgs()[0]).toBe('/api/establishments/1/programs');
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchEstablishmentPrograms(1)).rejects.toThrow(
      'Échec chargement des programmes de l’établissement'
    );
  });
});

describe('fetchManageableProgramsInEstablishment', () => {
  it('GET /api/establishments/:id/manageable-programs', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 9, name: 'P' }]));
    expect(await fetchManageableProgramsInEstablishment(1)).toEqual([{ id: 9, name: 'P' }]);
    expect(callArgs()[0]).toBe('/api/establishments/1/manageable-programs');
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchManageableProgramsInEstablishment(1)).rejects.toThrow(
      'Échec chargement des programmes gérables'
    );
  });
});

// ── Programmes / cours ─────────────────────────────────────────────────────────

describe('fetchCourseProgramIds', () => {
  it('renvoie les programmes du cours lus dans GET /api/courses/{id}', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({ id: 4, code: 'IFT1', title: 'Algo', programIds: [1, 3] }));
    expect(await fetchCourseProgramIds(4)).toEqual([1, 3]);
    expect(mockedApiFetch.mock.calls.map((c) => c[0])).toEqual(['/api/courses/4']);
  });

  it('liste vide si la réponse ne contient pas programIds', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({ id: 4, programIds: null }));
    expect(await fetchCourseProgramIds(4)).toEqual([]);
  });

  it('throw si le cours ne répond pas', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchCourseProgramIds(4)).rejects.toThrow();
  });
});

describe('fetchProgramCourses', () => {
  it('extrait data.courses et remplace code/titre absents par ""', async () => {
    mockedApiFetch.mockResolvedValueOnce(
      res({
        courses: [
          { id: 1, code: 'IFT1', title: 'Algo', extra: 'ignoré' },
          { id: 2, code: null, title: undefined },
        ],
      })
    );
    const out = await fetchProgramCourses(3);
    expect(callArgs()[0]).toBe('/api/programs/3/courses');
    expect(out).toEqual([
      { id: 1, code: 'IFT1', title: 'Algo' },
      { id: 2, code: '', title: '' },
    ]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchProgramCourses(3)).rejects.toThrow(
      'Échec chargement des cours du programme'
    );
  });
});

describe('fetchJoinedCourseIds', () => {
  it('lit les inscriptions de l’utilisateur courant et ne garde que les ids', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 4, title: 'A' }, { id: 6, title: 'B' }]));
    const out = await fetchJoinedCourseIds(3);
    expect(callArgs()[0]).toBe('/api/users/7/programs/3/enrollments');
    expect(out).toEqual([4, 6]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchJoinedCourseIds(3)).rejects.toThrow('Échec chargement des inscriptions');
  });
});

describe('createCourse', () => {
  it('POST /api/programs/courses et ajoute quizzes/forums vides', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({ id: 12, title: 'Algo', code: 'IFT1' }));
    const course = { title: 'Algo', code: 'IFT1', programIds: [3] } as never;
    const out = await createCourse(course);
    const [url, init] = callArgs();
    expect(url).toBe('/api/programs/courses');
    expect(init?.method).toBe('POST');
    expect(bodyOf()).toEqual({ title: 'Algo', code: 'IFT1', programIds: [3] });
    expect(out).toEqual({ id: 12, title: 'Algo', code: 'IFT1', quizzes: [], forums: [] });
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(createCourse({} as never)).rejects.toThrow('Échec création du cours');
  });
});

describe('createProgram', () => {
  it('crée le programme puis y abonne l’utilisateur courant', async () => {
    mockedApiFetch
      .mockResolvedValueOnce(res({ id: 30, name: 'Génie' }, { status: 201 }))
      .mockResolvedValueOnce(res({}, { status: 201 }));
    const out = await createProgram({ name: 'Génie' } as never);
    expect(callArgs(0)[0]).toBe('/api/establishments/programs');
    expect(callArgs(0)[1]?.method).toBe('POST');
    expect(bodyOf(0)).toEqual({ name: 'Génie' });
    expect(callArgs(1)[0]).toBe('/api/programs/users');
    expect(callArgs(1)[1]?.method).toBe('POST');
    expect(bodyOf(1)).toEqual({ id: 7, programIds: [30] });
    expect(out).toEqual({ id: 30, name: 'Génie', courses: [] });
  });

  it('throw et n’abonne personne si la création échoue', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(createProgram({} as never)).rejects.toThrow('Échec création du programme');
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  // Garde : si l'abonnement (POST /api/programs/users) échoue, createProgram doit lever une
  // erreur, sinon le programme s'affiche mais disparaît au rechargement.
  it('throw si l’abonnement au programme créé échoue', async () => {
    mockedApiFetch
      .mockResolvedValueOnce(res({ id: 30, name: 'Génie' }, { status: 201 }))
      .mockResolvedValueOnce(errRes(500));
    await expect(createProgram({ name: 'Génie' } as never)).rejects.toThrow();
  });
});

describe('joinPrograms', () => {
  it('POST la sélection puis recharge la liste complète des programmes', async () => {
    mockedApiFetch
      .mockResolvedValueOnce(res({}, { status: 201 }))
      .mockResolvedValueOnce(res([{ id: 1, name: 'P1' }]));
    const out = await joinPrograms({ programIds: [1, 2], establishmentId: 5 } as never);
    expect(callArgs(0)[0]).toBe('/api/programs/users');
    expect(callArgs(0)[1]?.method).toBe('POST');
    expect(bodyOf(0)).toEqual({ id: 7, programIds: [1, 2], establishmentId: 5 });
    expect(callArgs(1)[0]).toBe('/api/users/7/programs');
    expect(out).toEqual([{ id: 1, name: 'P1', courses: [] }]);
  });

  it('throw sans recharger si l’adhésion échoue', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(joinPrograms({ programIds: [], establishmentId: 1 } as never)).rejects.toThrow(
      'Échec adhésion aux programmes'
    );
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });
});

describe('updateCourse / updateProgram', () => {
  it('updateCourse : PATCH /api/courses/:id avec la mise à jour', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({}, { status: 204 }));
    await updateCourse(12, { title: 'Nouveau', code: 'IFT2' } as never);
    const [url, init] = callArgs();
    expect(url).toBe('/api/courses/12');
    expect(init?.method).toBe('PATCH');
    expect(bodyOf()).toEqual({ title: 'Nouveau', code: 'IFT2' });
  });

  it('updateCourse : throw en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(updateCourse(12, {} as never)).rejects.toThrow('Échec modification du cours');
  });

  it('updateProgram : PATCH /api/programs/:id avec la mise à jour', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({}, { status: 204 }));
    await updateProgram(3, { name: 'P', color: '#fff' } as never);
    const [url, init] = callArgs();
    expect(url).toBe('/api/programs/3');
    expect(init?.method).toBe('PATCH');
    expect(bodyOf()).toEqual({ name: 'P', color: '#fff' });
  });

  it('updateProgram : throw en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(updateProgram(3, {} as never)).rejects.toThrow('Échec modification du programme');
  });
});

// Suppressions / désabonnements : [nom, appel, URL, message d'erreur].
const deleteCases: [string, () => Promise<void>, string, string][] = [
  ['leaveProgram', () => leaveProgram(3), '/api/programs/3/users/7', 'Échec quitter le programme'],
  ['deleteProgram', () => deleteProgram(3), '/api/programs/3', 'Échec suppression du programme'],
  ['leaveCourse', () => leaveCourse(12), '/api/courses/12/users/7', 'Échec quitter le cours'],
  ['deleteCourse', () => deleteCourse(12), '/api/courses/12', 'Échec suppression du cours'],
  [
    'deleteMessage',
    () => deleteMessage(4, 77),
    '/api/forums/4/posts/77',
    'Échec de la suppression du message',
  ],
  [
    'deletePost',
    () => deletePost(4, 78),
    '/api/forums/4/posts/78',
    'Échec de la suppression du post',
  ],
];

describe.each(deleteCases)('%s', (_name, call, url, message) => {
  it(`DELETE ${url}`, async () => {
    mockedApiFetch.mockResolvedValueOnce(res({}, { status: 204 }));
    await call();
    const [calledUrl, init] = callArgs();
    expect(calledUrl).toBe(url);
    expect(init?.method).toBe('DELETE');
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes(403));
    await expect(call()).rejects.toThrow(message);
  });
});

describe('joinCourses', () => {
  it('POST /api/courses/users et renvoie les cours rejoints sans canaux', async () => {
    mockedApiFetch.mockResolvedValueOnce(
      res([{ id: 4, code: 'IFT1', title: 'Algo', forums: [{ id: 1 }], quizzes: [{ id: 2 }] }])
    );
    const out = await joinCourses(3, [4]);
    const [url, init] = callArgs();
    expect(url).toBe('/api/courses/users');
    expect(init?.method).toBe('POST');
    expect(bodyOf()).toEqual({ id: 7, courseIds: [4], programId: 3 });
    expect(out).toEqual([{ id: 4, code: 'IFT1', title: 'Algo', quizzes: [], forums: [] }]);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(joinCourses(3, [4])).rejects.toThrow('Failed to join courses');
  });
});

describe('changeSection', () => {
  it('PATCH /api/courses/:id/sections et renvoie le changement appliqué', async () => {
    const applied = { kind: 'create', id: 99, title: 'Général' };
    mockedApiFetch.mockResolvedValueOnce(res(applied));
    const change = { kind: 'create', id: -1, title: 'Général' } as never;
    const out = await changeSection(12, 'text', change);
    const [url, init] = callArgs();
    expect(url).toBe('/api/courses/12/sections');
    expect(init?.method).toBe('PATCH');
    expect(bodyOf()).toEqual({
      sectionType: 'text',
      change: { kind: 'create', id: -1, title: 'Général' },
    });
    expect(out).toEqual(applied);
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(changeSection(12, 'text', {} as never)).rejects.toThrow(
      'Échec modification de section'
    );
  });
});

// ── Analyses MCP ───────────────────────────────────────────────────────────────

describe('analyses MCP', () => {
  it('fetchCourseAnalyses : GET /mcp/courses/:id/analyses', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 1, createdAt: '2026-01-01' }]));
    expect(await fetchCourseAnalyses(12)).toEqual([{ id: 1, createdAt: '2026-01-01' }]);
    expect(callArgs()[0]).toBe('/mcp/courses/12/analyses');
  });

  it('fetchCourseAnalyses : throw en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchCourseAnalyses(12)).rejects.toThrow(
      'Échec chargement de l’historique des analyses'
    );
  });

  it('fetchCourseAnalysis : GET /mcp/analyses/:id', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({ id: 5, content: 'rapport' }));
    expect(await fetchCourseAnalysis(5)).toEqual({ id: 5, content: 'rapport' });
    expect(callArgs()[0]).toBe('/mcp/analyses/5');
  });

  it('fetchCourseAnalysis : throw en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes(404));
    await expect(fetchCourseAnalysis(5)).rejects.toThrow(
      'Échec chargement du détail de l’analyse'
    );
  });

  it('fetchPendingAnalysis : renvoie le booléen du serveur', async () => {
    mockedApiFetch.mockResolvedValueOnce(res(true));
    expect(await fetchPendingAnalysis(12)).toBe(true);
    expect(callArgs()[0]).toBe('/mcp/courses/12/pending');
  });

  it('fetchPendingAnalysis : throw en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchPendingAnalysis(12)).rejects.toThrow(
      'Échec chargement du statut de l’analyse'
    );
  });

  it('requestCourseAnalysis : POST sans corps, accepte un 202 sans lire la réponse', async () => {
    const json = vi.fn();
    mockedApiFetch.mockResolvedValueOnce({ ok: true, status: 202, json } as unknown as Response);
    await requestCourseAnalysis(12);
    const [url, init] = callArgs();
    expect(url).toBe('/mcp/courses/12/analyses');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it('requestCourseAnalysis : throw sur 409 (déjà en cours)', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes(409));
    await expect(requestCourseAnalysis(12)).rejects.toThrow(
      'Échec du déclenchement de l’analyse'
    );
  });
});

// ── Messages de canal ──────────────────────────────────────────────────────────

describe('fetchMessages', () => {
  it('page la plus récente : limit=30 par défaut, sans before', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([{ id: 1, content: 'salut' }]));
    const out = await fetchMessages(4);
    expect(callArgs()[0]).toBe('/api/forums/4/messages?limit=30');
    expect(out).toEqual([{ id: 1, content: 'salut' }]);
  });

  it('ajoute before et la taille de page demandée', async () => {
    mockedApiFetch.mockResolvedValueOnce(res([]));
    await fetchMessages(4, 120, 15);
    expect(callArgs()[0]).toBe('/api/forums/4/messages?limit=15&before=120');
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(fetchMessages(4)).rejects.toThrow('Échec chargement des messages');
  });
});

describe('editMessage', () => {
  it('PATCH /api/forums/:forum/posts/:id avec le seul contenu', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({}, { status: 204 }));
    await editMessage(4, 77, 'corrigé');
    const [url, init] = callArgs();
    expect(url).toBe('/api/forums/4/posts/77');
    expect(init?.method).toBe('PATCH');
    expect(bodyOf()).toEqual({ content: 'corrigé' });
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(editMessage(4, 77, 'x')).rejects.toThrow('Échec de la modification du message');
  });
});

// ── Posts de forum ─────────────────────────────────────────────────────────────

describe('createPost', () => {
  const saved = {
    id: 80,
    content: 'Question ?',
    createdAt: '2026-01-01',
    title: 'Sujet',
    isPinned: false,
    author: { id: 7 },
    userVoteValue: 0,
    voteTotalValue: 0,
    childrenCount: 0,
  };

  it('sujet racine : envoie le titre et reporte clientPostId sur le post mappé', async () => {
    mockedApiFetch.mockResolvedValueOnce(res(saved, { status: 201 }));
    const out = await createPost(4, 'Question ?', null, 'cp-1', 'Sujet');
    const [url, init] = callArgs();
    expect(url).toBe('/api/forums/posts');
    expect(init?.method).toBe('POST');
    expect(bodyOf()).toEqual({
      forumId: 4,
      parentPostId: null,
      content: 'Question ?',
      title: 'Sujet',
      clientPostId: 'cp-1',
    });
    expect(out).toEqual({
      id: 80,
      content: 'Question ?',
      createdAt: '2026-01-01',
      title: 'Sujet',
      isPinned: false,
      author: { id: 7 },
      votes: [],
      othersVoteTotal: 0,
      replyCount: 0,
      replies: undefined,
      clientPostId: 'cp-1',
    });
  });

  it('réponse sans titre : title:null et parentPostId transmis', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({ ...saved, title: undefined }, { status: 201 }));
    await createPost(4, 'Réponse', 80, 'cp-2');
    expect(bodyOf()).toEqual({
      forumId: 4,
      parentPostId: 80,
      content: 'Réponse',
      title: null,
      clientPostId: 'cp-2',
    });
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(createPost(4, 'x', null, 'cp')).rejects.toThrow(
      'Échec de la publication du post'
    );
  });
});

describe('editPost', () => {
  it('avec titre : envoie content + title', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({}, { status: 204 }));
    await editPost(4, 80, 'nouveau', 'Titre');
    const [url, init] = callArgs();
    expect(url).toBe('/api/forums/4/posts/80');
    expect(init?.method).toBe('PATCH');
    expect(bodyOf()).toEqual({ content: 'nouveau', title: 'Titre' });
  });

  it('sans titre : n’envoie pas de clé title (ne pas effacer le titre)', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({}, { status: 204 }));
    await editPost(4, 81, 'réponse modifiée');
    expect(bodyOf()).toEqual({ content: 'réponse modifiée' });
  });

  it('titre vide explicite : envoyé tel quel', async () => {
    mockedApiFetch.mockResolvedValueOnce(res({}, { status: 204 }));
    await editPost(4, 80, 'c', '');
    expect(bodyOf()).toEqual({ content: 'c', title: '' });
  });

  it('throw quand la réponse est en erreur', async () => {
    mockedApiFetch.mockResolvedValueOnce(errRes());
    await expect(editPost(4, 80, 'x')).rejects.toThrow('Échec de la modification du post');
  });
});
