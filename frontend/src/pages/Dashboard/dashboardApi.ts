// Couche « API » du Dashboard, regroupée ici pour un seul point de bascule vers le
// vrai backend. La plupart des fonctions appellent le vrai backend (apiFetch) ; le
// Dashboard se contente d'orchestrer l'état autour.
//
// Restent en MOCK (à brancher) : fetchLanguages (liste côté CODE) et evaluateCode
// (service d'exécution). Elles utilisent encore les helpers simulate* ci-dessous.

import type { NewCourse } from '../../components/AddCoursePopup/types.ts';
import type { JoinSelection, NewProgram } from '../../components/AddSubscriptionPopup/types.ts';
import type { CourseUpdate } from '../../components/UpdateCoursePopup/types.ts';
import type { ProgramUpdate } from '../../components/UpdateProgramPopup/types.ts';
import type { RoleChange, User } from '../../components/RoleEditorPopup/types.ts';
import type { ItemChange } from '../../components/SectionEditorPopup/types.ts';
import type {
  AnswerResponse,
  ChannelMessage,
  DragItemResponse,
  ForumPost,
  ForumResponse,
  PostVoteUserDTO,
  QuestionResponse,
} from '../../types/domain.ts';
//import { normalizeCourseChannelsFromSources } from '../../components/CourseChannelList/courseChannelSources.ts';
import type {
  Course,
  CourseForumsResponse,
  ManagedEstablishment,
  McpResponse,
  McpResponseSummary,
  QuizDetailResponse,
  QuizResponse,
} from '../../types/domain.ts';
//import { getEstablishmentPrograms } from '../../mocks/subscriptionData.ts';
//import { getProgramRoles, getProgramUsers } from '../../mocks/roleData.ts';
//import { getDashboardPrograms } from './dashboardDataSource.ts';
import type { DemoProgram } from '../../mocks/dashboardData.ts';
import { type Language, type QuestionTypeOption, type Quiz } from '../../types/domain.ts';
import {
  type AttemptSummary,
  type CodeEvaluationInput,
  type CodingTestResult,
  type QuizResult,
  type QuizSubmission,
} from '../../components/MainPanel/QuizView/quizAttempt.ts';
import { DEFAULT_LANGUAGES } from '../../components/QuizEditor/editorTypes.ts';
import { apiFetch } from '../../helpers/api.ts';
import type { JoinableCourse } from '../../components/JoinCoursesPopup/types.ts';
// Ré-exporté pour que le Dashboard n'ait pas à dépendre du dossier mock.
export type { DemoProgram };

// ── Simulation réseau (à retirer au branchement réel) ──────────────────────────
const SIMULATE_DELAY = 1000;
const SIMULATE_SEND_FAILURE: boolean = false;
const SIMULATE_FETCH_FAILURE: boolean = false;

const wait = () => new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));

/** Latence + échec simulés d'une LECTURE (GET). */
async function simulateFetch(errorMessage: string): Promise<void> {
  await wait();
  if (SIMULATE_FETCH_FAILURE) throw new Error(errorMessage);
}

/** Latence + échec simulés d'une ÉCRITURE (POST/PATCH/DELETE). */
async function simulateWrite(errorMessage: string): Promise<void> {
  await wait();
  if (SIMULATE_SEND_FAILURE) throw new Error(errorMessage);
}

// ── Programmes / cours (chargement) ────────────────────────────────────────────

/**
 * Récupérer la liste des programmes auxquels l'utilisateur est abonné. Les cours sont
 * chargés séparément (fetchCourses) à l'entrée dans un programme : on renvoie donc ici
 * les programmes SANS leurs cours.
 */
export async function fetchPrograms(): Promise<DemoProgram[]> {
  console.log('fetchPrograms');
  const userId = localStorage.getItem('moodit_user_id');
  const res = await apiFetch(`/api/users/${userId}/programs`);
  if (!res.ok) throw new Error('Échec chargement des programmes');
  const data = await res.json();
  return data.map((p: DemoProgram) => ({ ...p, courses: [] }));
}

/** Récupérer les cours d'un programme (avec leurs canaux/quiz/forums). */
export async function fetchCourses(programId: number): Promise<Course[]> {
  const userId = localStorage.getItem('moodit_user_id');

  const res = await apiFetch(`/api/users/${userId}/programs/${programId}/enrollments`);

  if (!res.ok) {
    throw new Error('Échec chargement des cours');
  }

  // L'endpoint renvoie chaque cours avec ses forums embarqués (un seul appel). Canaux
  // de discussion ('Discussion') et forums ('Thread') sont tous des Forum, distingués
  // par `fTypeName` → `fType` ; normalizeCourseChannelsFromSources les répartit ensuite
  // pour l'affichage ('Discussion' → canal texte, 'Thread' → forum).
  const courses: CourseForumsResponse[] = await res.json();

  return courses.map((course) => ({
    id: course.id,
    title: course.title,
    code: course.code,
    forums: (course.forums ?? []).map((f: ForumResponse) => ({
      id: f.id,
      title: f.title,
      position: f.position,
      fType: f.fTypeName,
    })),
    quizzes: (course.quizzes ?? []).map((q: QuizResponse) => ({
      id: q.id,
      title: q.title,
      position: q.position,
      isPublished: q.isPublished,
      isDaily: q.isDaily,
      createdAt: q.createdAt,
    })),
  }));
}

// ── Quiz (passation étudiant + éditeur enseignant) ─────────────────────────────

/** Normalise un détail de quiz renvoyé par le backend (QuizDetailDTO) vers le modèle. */
function toQuiz(data: QuizDetailResponse): Quiz {
  return {
    id: data.id,
    title: data.title,
    position: data.position,
    isPublished: data.isPublished,
    isDaily: data.isDaily,
    allowRetry: data.allowRetry,
    questions: (data.questions ?? []).map((q: QuestionResponse) => ({
      id: q.id,
      prompt: q.prompt,
      qType: q.qType,
      qTypeId: q.qTypeId,
      totalScore: q.totalScore,
      orderIndex: q.orderIndex,
      startCode: q.startCode,
      answers: q.answers?.map((a: AnswerResponse) => ({
        id: a.id,
        content: a.content,
        isCorrect: a.isCorrect,
      })),
      dragItems: q.dragItems?.map((d: DragItemResponse) => ({
        id: d.id,
        content: d.content,
        correctOrder: d.correctOrder,
        groupName: d.groupName,
      })),
    })),
  };
}

/** Normalise un quiz « méta seule » (QuizDTO) vers le modèle. */
function toQuizMeta(q: QuizResponse): Quiz {
  return {
    id: q.id,
    title: q.title,
    position: q.position,
    isPublished: q.isPublished,
    isDaily: q.isDaily,
    allowRetry: q.allowRetry,
    questionCount: q.questionCount,
  };
}

/**
 * Charger le détail d'un quiz (questions embarquées) pour la PASSATION côté étudiant.
 * Le backend n'inclut PAS la correction (isCorrect/correctOrder/groupName) sur cet
 * endpoint : impossible de tricher via l'onglet réseau.
 */
export async function fetchQuiz(quizId: number): Promise<Quiz> {
  const res = await apiFetch(`/api/quizzes/${quizId}`);
  if (!res.ok) throw new Error('Échec chargement du quiz');
  return toQuiz(await res.json());
}

/**
 * Charger le détail COMPLET d'un quiz pour l'ÉDITEUR enseignant : inclut la correction
 * (isCorrect/correctOrder/groupName). Réservé aux admins côté backend (403 sinon).
 */
export async function fetchQuizForEdit(quizId: number): Promise<Quiz> {
  const res = await apiFetch(`/api/quizzes/${quizId}/edit`);
  if (!res.ok) throw new Error('Échec chargement du quiz');
  return toQuiz(await res.json());
}

/**
 * Quiz d'un cours VISIBLES par l'étudiant : uniquement les PUBLIÉS (méta seules).
 * Sert à la sidebar / vue étudiant. Tri par `position` (backend).
 */
export async function fetchPublishedQuizzes(courseId: number): Promise<Quiz[]> {
  const res = await apiFetch(`/api/courses/${courseId}/quizzes?published=true`);
  if (!res.ok) throw new Error('Échec chargement des quiz publiés');
  const data: QuizResponse[] = await res.json();
  return data.map(toQuizMeta);
}

/**
 * TOUS les quiz d'un cours, BROUILLONS COMPRIS (méta seules). Réservé à
 * l'enseignant/admin (éditeur « Modifier les quiz »). Tri par `position` (backend).
 */
export async function fetchQuizzes(courseId: number): Promise<Quiz[]> {
  const res = await apiFetch(`/api/courses/${courseId}/quizzes`);
  if (!res.ok) throw new Error('Échec chargement des quiz');
  const data: QuizResponse[] = await res.json();
  return data.map(toQuizMeta);
}

/**
 * Types de question disponibles (table Q_Type : id + name FR). Alimente le sélecteur
 * de type de l'éditeur de question.
 */
export async function fetchQuestionTypes(): Promise<QuestionTypeOption[]> {
  const res = await apiFetch('/api/question-types');
  if (!res.ok) throw new Error('Échec chargement des types de question');
  return await res.json();
}

/**
 * TODO — Langages d'exécution disponibles (table Language). Alimente le sélecteur de
 * langage de l'éditeur de quiz. MOCK : liste par défaut (côté CODE, non branché ici).
 */
export async function fetchLanguages(): Promise<Language[]> {
  await simulateFetch('Échec simulé (chargement des langages)');
  console.log(DEFAULT_LANGUAGES);
  return DEFAULT_LANGUAGES;
}

/**
 * Soumettre une tentative ; le backend corrige (types « à réponses ») et renvoie le
 * QuizResult. Le CODE n'est pas exécuté côté serveur (tests = null).
 */
export async function submitQuiz(submission: QuizSubmission): Promise<QuizResult> {
  const res = await apiFetch(`/api/quizzes/${submission.quizId}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submission),
  });
  if (!res.ok) throw new Error('Échec de la soumission du quiz');
  return await res.json();
}

/**
 * Historique des tentatives de l'utilisateur sur un quiz (réhydratation + reprise).
 * Liste vide = pas encore tenté.
 */
export async function fetchQuizAttempts(quizId: number): Promise<AttemptSummary[]> {
  const res = await apiFetch(`/api/quizzes/${quizId}/attempts`);
  if (!res.ok) throw new Error('Échec chargement des tentatives');
  return await res.json();
}

/** Détail corrigé d'une tentative donnée (révision d'une tentative passée). */
export async function fetchAttemptResult(quizId: number, attemptId: number): Promise<QuizResult> {
  const res = await apiFetch(`/api/quizzes/${quizId}/attempts/${attemptId}`);
  if (!res.ok) throw new Error('Échec chargement de la tentative');
  return await res.json();
}

/**
 * TODO — Évaluer une question Code : EXÉCUTE chaque harnais contre le `code` soumis
 * (côté serveur, dans le langage `languageId`) et renvoie le verdict par test. MOCK :
 * le code ne tourne pas au navigateur → verdict illustratif (1 test sur 2 passe si le
 * code a été modifié). À remplacer par un apiFetch vers le service d'exécution.
 */
export async function evaluateCode(input: CodeEvaluationInput): Promise<CodingTestResult[]> {
  await simulateWrite('Échec simulé (évaluation du code)');
  console.log('[api] Évaluation du code (langage', input.languageId, ') :', input);
  const attempted = input.code.trim().length > 0;
  return input.testCases.map((t, i) => ({
    name: t.name,
    passed: attempted && i % 2 === 0,
    weight: t.weight,
  }));
}

// ── Quiz (édition enseignant — écriture) ───────────────────────────────────────
// Les questions sont éditées EN MÉMOIRE dans l'éditeur et persistées en un seul appel
// (create/update du quiz), pas une requête par question. Le backend assigne les ids
// (il ignore les ids temporaires négatifs de l'éditeur, ainsi que les harnais de code).

/**
 * Créer un quiz COMPLET (méta + questions) dans un cours ; renvoie le quiz persisté
 * (ids serveur, questions comprises).
 */
export async function createQuiz(courseId: number, quiz: Quiz): Promise<Quiz> {
  const res = await apiFetch(`/api/courses/${courseId}/quizzes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(quiz),
  });
  if (!res.ok) throw new Error('Échec création du quiz');
  return toQuiz(await res.json());
}

/**
 * Mettre à jour un quiz COMPLET (méta + questions) en un appel ; renvoie le quiz
 * persisté (ids des nouvelles questions réconciliés).
 */
export async function updateQuiz(quizId: number, quiz: Quiz): Promise<Quiz> {
  const res = await apiFetch(`/api/quizzes/${quizId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(quiz),
  });
  if (!res.ok) throw new Error('Échec modification du quiz');
  return toQuiz(await res.json());
}

/** Supprimer un quiz et tout son contenu (questions/réponses) en cascade. */
export async function deleteQuiz(quizId: number): Promise<void> {
  const res = await apiFetch(`/api/quizzes/${quizId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Échec suppression du quiz');
}

/** Réordonner les quiz d'un cours (ids dans le nouvel ordre). */
export async function reorderQuizzes(courseId: number, quizIds: number[]): Promise<void> {
  const res = await apiFetch(`/api/courses/${courseId}/quizzes/reorder`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(quizIds),
  });
  if (!res.ok) throw new Error('Échec réordre des quiz');
}

/**
 * Charger les données du gestionnaire de rôles d'un programme : la liste des rôles
 * attribuables ET la liste des membres avec le rôle de chacun. Alimente le RoleEditorPopup.
 */
export async function fetchProgramRoles(programId: number) {
  const [rolesRes, usersRes] = await Promise.all([
    // scope=program → seuls les rôles attribuables dans un programme (pas Gardien).
    apiFetch('/api/roles?scope=program'),
    apiFetch(`/api/programs/${programId}/users`),
  ]);

  if (!rolesRes.ok || !usersRes.ok) {
    throw new Error('fetch roles failed');
  }

  const users = (await usersRes.json()).map((u: User) => ({
    ...u,
    role_ids: u.roles ?? [],
  }));

  return {
    roles: await rolesRes.json(),
    users: users,
  };
}

/**
 * Charger les données du gestionnaire des ADMINISTRATEURS (rôles globaux, plateforme) : les
 * rôles attribuables globalement (Administrateur, Gardien) ET tous les utilisateurs
 * avec leurs rôles globaux (User_Role). Alimente le popup accessible depuis le profil.
 */
export async function fetchGlobalRoles() {
  const [rolesRes, usersRes] = await Promise.all([
    apiFetch('/api/roles?scope=global'),
    apiFetch('/api/roles/global/users'),
  ]);

  if (!rolesRes.ok || !usersRes.ok) {
    throw new Error('fetch global roles failed');
  }

  const users = (await usersRes.json()).map((u: User) => ({
    ...u,
    role_ids: u.roles ?? [],
  }));

  return {
    roles: await rolesRes.json(),
    users: users,
  };
}

/**
 * Candidats paginés à l'attribution d'un rôle GLOBAL (utilisateurs n'ayant pas `roleId`),
 * filtrés côté serveur par `search`. Alimente le sélecteur d'ajout du popup admins (infinite
 * scroll + recherche BD). Renvoie une page de `size` utilisateurs au plus.
 */
export async function fetchGlobalRoleCandidates(
  roleId: number,
  search: string,
  page: number,
  size: number
): Promise<User[]> {
  const params = new URLSearchParams({
    roleId: String(roleId),
    search,
    page: String(page),
    size: String(size),
  });
  const res = await apiFetch(`/api/roles/global/candidates?${params.toString()}`);
  if (!res.ok) throw new Error('Échec chargement des candidats');
  return (await res.json()).map((u: User) => ({ ...u, role_ids: u.roles ?? [] }));
}

/**
 * Candidats paginés à l'attribution d'un rôle DANS un programme : MEMBRES du programme
 * (User_Program) n'ayant pas `roleId`, filtrés côté serveur par `search`. Alimente le sélecteur
 * d'ajout du popup « Gérer les rôles » (infinite scroll + recherche BD).
 */
export async function fetchProgramRoleCandidates(
  programId: number,
  roleId: number,
  search: string,
  page: number,
  size: number
): Promise<User[]> {
  const params = new URLSearchParams({
    roleId: String(roleId),
    search,
    page: String(page),
    size: String(size),
  });
  const res = await apiFetch(
    `/api/programs/${programId}/role-candidates?${params.toString()}`
  );
  if (!res.ok) throw new Error('Échec chargement des candidats');
  return (await res.json()).map((u: User) => ({ ...u, role_ids: u.roles ?? [] }));
}

/**
 * Assigner ou retirer un rôle GLOBAL (plateforme) à un utilisateur (User_Role). Le popup gère
 * l'optimisme + rollback ; on ne fait que persister. Enforcement front (le backend n'y re-vérifie
 * pas les droits de l'appelant).
 */
export async function changeGlobalRole(change: RoleChange): Promise<void> {
  const res = await apiFetch(`/api/roles/global/change`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(change),
  });

  if (!res.ok) {
    throw new Error('Échec assignation de rôle global');
  }
}

// ── Établissements / catalogue (AddSubscriptionPopup) ──────────────────────────

/**
 * Lister les établissements dans lesquels l'utilisateur peut CRÉER un programme
 * (1re étape du AddSubscriptionPopup en mode création).
 */
export async function fetchEstablishmentsForCreate() {
  const res = await apiFetch('/api/establishments');
  if (!res.ok) throw new Error('Échec chargement des établissements');
  return res.json();
}

/**
 * Lister les établissements dont l'utilisateur peut REJOINDRE des programmes existants
 * (1re étape du AddSubscriptionPopup en mode adhésion).
 */
export async function fetchEstablishmentsForJoin() {
  console.log('fetchEstablishmentsForJoin');
  const res = await apiFetch('/api/establishments');

  if (!res.ok) {
    throw new Error('Échec chargement des établissements (adhésion)');
  }

  return await res.json();
}

/**
 * Lister TOUS les établissements pour le gestionnaire des établissements (gardien) : id, nom,
 * domaine courriel, nombre de programmes. Réutilise GET /api/establishments.
 */
export async function fetchEstablishments(): Promise<ManagedEstablishment[]> {
  const res = await apiFetch('/api/establishments');
  if (!res.ok) throw new Error('Échec chargement des établissements');
  return res.json();
}

/**
 * Sentinelle levée quand le domaine courriel est déjà pris (409 : contrainte UNIQUE côté BD).
 * Le popup l'intercepte pour afficher un message inline plutôt qu'une erreur générique.
 */
export const DUPLICATE_DOMAIN = 'duplicate-domain';

/** Créer un établissement (gardien). Renvoie l'établissement persisté. */
export async function createEstablishment(
  name: string,
  domainEmail: string
): Promise<ManagedEstablishment> {
  const res = await apiFetch('/api/establishments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, domainEmail }),
  });
  if (res.status === 409) throw new Error(DUPLICATE_DOMAIN);
  if (!res.ok) throw new Error("Échec de la création de l'établissement");
  return res.json();
}

/** Modifier un établissement (gardien). Renvoie l'établissement à jour. */
export async function updateEstablishment(
  establishmentId: number,
  update: { name?: string; domainEmail?: string }
): Promise<ManagedEstablishment> {
  const res = await apiFetch(`/api/establishments/${establishmentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (res.status === 409) throw new Error(DUPLICATE_DOMAIN);
  if (!res.ok) throw new Error("Échec de la modification de l'établissement");
  return res.json();
}

/**
 * Supprimer un établissement (gardien). DESTRUCTIF : supprime en cascade ses programmes
 * (et leurs cours/membres) côté BD. À confirmer avant appel.
 */
export async function deleteEstablishment(establishmentId: number): Promise<void> {
  const res = await apiFetch(`/api/establishments/${establishmentId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error("Échec de la suppression de l'établissement");
}

/**
 * Lister le catalogue des programmes existants d'un établissement pour que l'utilisateur
 * choisisse ceux qu'il veut rejoindre.
 */
export async function fetchEstablishmentPrograms(establishmentId: number) {
  console.log('fetchEstablishmentPrograms');
  const res = await apiFetch(`/api/establishments/${establishmentId}/programs`);

  if (!res.ok) {
    throw new Error('Échec chargement des programmes de l’établissement');
  }

  return await res.json();
}

/**
 * Lister les cours rejoignables d'un programme.
 * Alimente le JoinCoursesPopup (menu contextuel d'un programme).
 */
export async function fetchProgramCourses(programId: number): Promise<JoinableCourse[]> {
  console.log('fetchProgramCourses');
  const res = await apiFetch(`/api/programs/${programId}/courses`);

  if (!res.ok) {
    throw new Error('Échec chargement des cours du programme');
  }

  const data = await res.json();

  return data.courses.map((course: JoinableCourse) => ({
    id: course.id,
    code: course.code ?? '',
    title: course.title ?? '',
  }));
}

/**
 * Lister les ids des cours d'un programme auxquels l'utilisateur est DÉJÀ inscrit. Sert à
 * pré-cocher le JoinCoursesPopup, indépendamment de l'état (lazy-loaded) du Dashboard.
 */
export async function fetchJoinedCourseIds(programId: number): Promise<number[]> {
  console.log('fetchJoinedCourseIds');

  const userId = localStorage.getItem('moodit_user_id');

  const res = await apiFetch(`/api/users/${userId}/programs/${programId}/enrollments`);

  if (!res.ok) throw new Error('Échec chargement des inscriptions');

  const data: Course[] = await res.json();

  return data.map((course) => course.id);
}

/**
 * Historique des analyses MCP d'un cours : RÉSUMÉS (sans contenu), tri récent → ancien.
 * Tout est renvoyé d'un coup. Le détail est chargé à la demande via fetchCourseAnalysis(id).
 */
export async function fetchCourseAnalyses(courseId: number): Promise<McpResponseSummary[]> {
  const res = await apiFetch(`/mcp/courses/${courseId}/analyses`);
  if (!res.ok) throw new Error('Échec chargement de l’historique des analyses');
  return res.json();
}

/**
 * Détail complet d'une analyse MCP (table MCP_Response, avec `content`), chargé au clic
 * sur une entrée de l'historique.
 */
export async function fetchCourseAnalysis(id: number): Promise<McpResponse> {
  const res = await apiFetch(`/mcp/analyses/${id}`);
  if (!res.ok) throw new Error('Échec chargement du détail de l’analyse');
  return res.json();
}

/**
 * L'utilisateur courant a-t-il une analyse MCP EN COURS pour ce cours ? Réhydrate l'état
 * « en cours » du popup (survit à un rechargement). Le lien (cours, utilisateur) est
 * résolu côté serveur à partir du JWT (header X-User-Email).
 */
export async function fetchPendingAnalysis(courseId: number): Promise<boolean> {
  const res = await apiFetch(`/mcp/courses/${courseId}/pending`);
  if (!res.ok) throw new Error('Échec chargement du statut de l’analyse');
  return res.json();
}

// ── Programmes / cours (écriture) ──────────────────────────────────────────────

/**
 * Créer un cours (titre, code) et le rattacher aux programmes choisis (`programIds`).
 * Renvoie le cours persisté (id attribué par le serveur) pour que le Dashboard l'insère.
 */
export async function createCourse(course: NewCourse): Promise<Course> {
  const res = await apiFetch('/api/programs/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(course),
  });
  if (!res.ok) throw new Error('Échec création du cours');
  const data = await res.json();
  return {
    ...data,
    quizzes: [],
    forums: [],
  };
}

/**
 * Créer un nouveau programme et y abonner l'utilisateur d'office. Renvoie le programme
 * persisté (id attribué par le serveur) pour l'ajouter à la liste.
 */
export async function createProgram(program: NewProgram): Promise<DemoProgram> {
  const res = await apiFetch('/api/establishments/programs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(program),
  });
  if (!res.ok) throw new Error('Échec création du programme');
  const data = await res.json();

  const userId = localStorage.getItem('moodit_user_id');
  await apiFetch('/api/programs/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: Number(userId), programIds: [data.id] }),
  });

  return { ...data, courses: [] };
}

/**
 * Abonner l'utilisateur aux programmes sélectionnés du catalogue. Renvoie les programmes
 * ajoutés ; le Dashboard les dédoublonne contre sa liste avant insertion.
 */
export async function joinPrograms(selection: JoinSelection): Promise<DemoProgram[]> {
  const userId = localStorage.getItem('moodit_user_id');

  const res = await apiFetch(`/api/programs/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: userId,
      programIds: selection.programIds,
      establishmentId: selection.establishmentId,
    }),
  });

  if (!res.ok) {
    throw new Error('Échec adhésion aux programmes');
  }

  // Le POST synchronise les adhésions (ajout + désabonnement) et renvoie 201 sans corps :
  // on recharge la liste COMPLÈTE à jour pour que le Dashboard la réconcilie (ajouts ET
  // retraits).
  return await fetchPrograms();
}

/**
 * Mettre à jour un cours (code, titre) et, le cas échéant, son rattachement aux
 * programmes (relation many-to-many program_course).
 */
export async function updateCourse(courseId: number, update: CourseUpdate): Promise<void> {
  const res = await apiFetch(`/api/courses/${courseId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error('Échec modification du cours');
}

/** Mettre à jour les champs d'un programme : nom, code, cohorte, couleur. */
export async function updateProgram(programId: number, update: ProgramUpdate): Promise<void> {
  const res = await apiFetch(`/api/programs/${programId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error('Échec modification du programme');
}

/** Désabonner l'utilisateur d'un programme (le retirer de sa liste). */
export async function leaveProgram(programId: number): Promise<void> {
  const userId = localStorage.getItem('moodit_user_id');
  const res = await apiFetch(`/api/programs/${programId}/users/${userId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Échec quitter le programme');
}

/**
 * Supprimer un programme (admin) — le retire pour TOUS ses abonnés (cascade BD :
 * abonnements, liens cours, rôles ; les cours partagés restent). Le backend diffuse
 * `program:deleted` sur la room de chaque abonné.
 */
export async function deleteProgram(programId: number): Promise<void> {
  const res = await apiFetch(`/api/programs/${programId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Échec suppression du programme');
}

/** Retirer l'utilisateur d'un cours (le retirer de sa liste de cours). */
export async function leaveCourse(courseId: number): Promise<void> {
  const userId = localStorage.getItem('moodit_user_id');
  const res = await apiFetch(`/api/courses/${courseId}/users/${userId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Échec quitter le cours');
}

/**
 * Supprimer un cours (admin) — le retire pour TOUS ses programmes (cascade BD : sections,
 * quiz, forums, inscriptions). Le backend diffuse `course:deleted` sur chaque programme.
 */
export async function deleteCourse(courseId: number): Promise<void> {
  const res = await apiFetch(`/api/courses/${courseId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Échec suppression du cours');
}

/**
 * Déclenche une analyse MCP d'un cours (« Analyser mon cours »). ASYNCHRONE : le serveur
 * ACCEPTE le job (202, sans corps) et marque (cours, user) « en cours » ; il ne renvoie
 * PAS le résultat. Celui-ci arrive plus tard par WebSocket (mcp:analysis-created /
 * mcp:analysis-failed, cf. subscribeCompletion dans Dashboard). 409 si déjà en cours.
 */
export async function requestCourseAnalysis(courseId: number): Promise<void> {
  const res = await apiFetch(`/mcp/courses/${courseId}/analyses`, { method: 'POST' });
  if (!res.ok) throw new Error('Échec du déclenchement de l’analyse');
  // 202 sans corps : rien à lire, le résultat viendra par WebSocket.
}

/**
 * Inscrire l'utilisateur aux cours choisis d'un programme. Renvoie les cours rejoints
 * (forme `Course`, sans canaux) pour que le Dashboard les fusionne dans le programme.
 * `courseIds` ⊆ des ids renvoyés par fetchProgramCourses(programId).
 */
export async function joinCourses(programId: number, courseIds: number[]): Promise<Course[]> {
  console.log('joinCourses', programId);
  const userId = localStorage.getItem('moodit_user_id');
  const response = await apiFetch('/api/courses/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: userId,
      courseIds,
      programId,
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to join courses');
  }

  const joinedCourses: Course[] = await response.json();

  return joinedCourses.map((course) => ({
    id: course.id,
    code: course.code,
    title: course.title,
    quizzes: [],
    forums: [],
  }));
}

/**
 * Persiste une modification de structure d'un cours (canal 'text' / forum) : ajout,
 * renommage, suppression ou réordonnancement. `change` décrit l'opération. Endpoint DÉDIÉ
 * `/sections` (distinct de PATCH /courses/{id} qui édite titre/code). Renvoie le changement
 * APPLIQUÉ — pour un `create`, avec l'id RÉEL du forum (réconciliation de l'optimiste). Le
 * backend diffuse `section:changed` en WS. (Les quiz passent par leurs propres handlers.)
 */
export async function changeSection(
  courseId: number,
  sectionType: string,
  change: ItemChange
): Promise<ItemChange> {
  const res = await apiFetch(`/api/courses/${courseId}/sections`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sectionType,
      change,
    }),
  });

  if (!res.ok) {
    throw new Error('Échec modification de section');
  }
  return (await res.json()) as ItemChange;
}

/**
 * Attribuer ou retirer un rôle à un membre DANS un programme (INSERT/DELETE User_Program_Role).
 * Le RoleEditorPopup gère l'optimisme + rollback ; on ne fait que persister. Le popup ignore
 * le programme : le Dashboard fournit le `programId` (les rôles sont scopés au programme).
 */
export async function changeRole(programId: number, change: RoleChange): Promise<void> {
  const res = await apiFetch(`/api/roles/change`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...change, programId }),
  });

  if (!res.ok) {
    throw new Error('Échec assignation de rôle');
  }
}

// ── Chat ('Discussion') ────────────────────────────────────────────────────────

/**
 * Charger une PAGE de messages d'un canal (infinite scroll « plus ancien »). `before` = id du
 * plus ancien message déjà chargé (absent = page la plus récente) ; `limit` = taille de page.
 * Le backend renvoie du plus récent au plus ancien ; le hook re-trie chronologiquement.
 */
export async function fetchMessages(
  channelId: number,
  before?: number,
  limit = 30
): Promise<ChannelMessage[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before != null) params.set('before', String(before));
  const res = await apiFetch(`/api/forums/${channelId}/messages?${params.toString()}`);

  if (!res.ok) {
    throw new Error('Échec chargement des messages');
  }

  return res.json();
}

/**
 * Publier un message dans le canal `channelId` (réponse à un autre si `parentId`). Renvoie
 * le message persisté (id réel) en conservant le `clientMessageId`, pour réconcilier
 * l'affichage optimiste et dédupliquer l'écho reçu par WebSocket.
 */
export async function sendMessage(
  channelId: number,
  content: string,
  parentId: number | null,
  clientMessageId: string
): Promise<ChannelMessage> {
  console.log('sendMessage');
  const res = await apiFetch('/api/forums/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      forumId: channelId,
      parentPostId: parentId,
      content,
      clientMessageId,
    }),
  });

  if (!res.ok) {
    throw new Error("Échec de l'envoi du message");
  }

  // 201 → message persisté : on le renvoie pour remplacer l'optimiste (id réel). On
  // reporte `clientMessageId` (absent du DTO serveur) pour la dédup de l'écho WS.
  const saved: PostVoteUserDTO = await res.json();
  return {
    id: saved.id,
    content: saved.content,
    createdAt: saved.createdAt,
    author: saved.author,
    postParentId: saved.postParentId,
    clientMsgId: clientMessageId,
  };
}

/** Modifier le contenu d'un message existant. */
export async function editMessage(
  forumID: number,
  messageId: number,
  content: string
): Promise<void> {
  const res = await apiFetch(`/api/forums/${forumID}/posts/${messageId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content,
    }),
  });

  if (!res.ok) {
    throw new Error('Échec de la modification du message');
  }

  console.log('[api] Modification du message', messageId, ':', content);
}

/** Supprimer un message. */
export async function deleteMessage(forumID: number, messageId: number): Promise<void> {
  const res = await apiFetch(`/api/forums/${forumID}/posts/${messageId}`, {
    method: 'DELETE',
  });

  if (!res.ok) {
    throw new Error('Échec de la suppression du message');
  }

  console.log('[api] Suppression du message', messageId);
}

// ── Forum ('Thread') ───────────────────────────────────────────────────────────

/** Id numérique de l'utilisateur courant (lu du localStorage, comme le reste du fichier). */
function currentUserId(): number {
  return Number(localStorage.getItem('moodit_user_id')) || 0;
}

/**
 * PostVoteUserDTO (backend) → ForumPost (modèle). Le vote PROPRE de l'utilisateur
 * (`userVoteValue`) va dans `votes` — attribué à SON id, pour que le front surligne le
 * bon bouton. Le reste du score va dans `othersVoteTotal` (le backend n'envoie qu'un
 * agrégat, pas la liste complète des votes). Score affiché = othersVoteTotal + vote propre.
 */
function toForumPost(p: PostVoteUserDTO): ForumPost {
  const myVote = p.userVoteValue ?? 0;
  return {
    id: p.id,
    content: p.content,
    createdAt: p.createdAt,
    title: p.title,
    isPinned: p.isPinned,
    author: p.author,
    votes: myVote ? [{ userId: currentUserId(), value: myVote as 1 | -1 }] : [],
    othersVoteTotal: (p.voteTotalValue ?? 0) - myVote,
    replyCount: p.childrenCount,
    replies: undefined,
  };
}

/**
 * Charger une PAGE de sujets RACINES d'un forum (infinite scroll « charger plus »), SANS leurs
 * réponses (chargement paresseux via fetchReplies). `before` = id du plus ancien sujet déjà
 * affiché (absent = page la plus récente) ; `limit` = taille de page. Renvoyés du plus récent
 * au plus ancien.
 */
export async function fetchThreads(
  forumId: number,
  before?: number,
  limit = 20
): Promise<ForumPost[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before != null) params.set('before', String(before));
  const res = await apiFetch(`/api/forums/${forumId}/posts?${params.toString()}`);
  if (!res.ok) throw new Error('Échec chargement des sujets');
  const data: PostVoteUserDTO[] = await res.json();
  return data.map(toForumPost);
}

/**
 * Charger les réponses DIRECTES (enfants immédiats) d'un post, au moment où l'utilisateur
 * déplie le fil.
 */
export async function fetchReplies(forumId: number, postId: number): Promise<ForumPost[]> {
  // Endpoint dédié : renvoie DIRECTEMENT la liste des réponses immédiates (enfants),
  // sans query param fragile. Robuste au passage gateway/proxy.
  const res = await apiFetch(`/api/forums/${forumId}/posts/${postId}/replies`);
  if (!res.ok) throw new Error('Échec chargement des réponses');
  const data: PostVoteUserDTO[] = await res.json();
  return data.map(toForumPost);
}

/**
 * Publier un sujet ou une réponse dans le forum `forumId` (réponse si `parentId`, avec un
 * `title` pour un sujet racine). Renvoie le post persisté (id réel) en conservant le
 * `clientPostId` pour la réconciliation optimiste ↔ écho WebSocket.
 */
export async function createPost(
  forumId: number,
  content: string,
  parentId: number | null,
  clientPostId: string,
  title?: string
): Promise<ForumPost> {
  console.log('createPost');
  const email = localStorage.getItem('moodit_user_email');

  const res = await apiFetch('/api/forums/posts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Email': email ?? '',
    },
    body: JSON.stringify({
      forumId,
      parentPostId: parentId,
      content,
      title: title ?? null,
      clientPostId,
    }),
  });

  if (!res.ok) {
    throw new Error('Échec de la publication du post');
  }

  // 201 → post persisté : on le renvoie pour remplacer l'optimiste (id réel), même
  // forme que fetchThreads. `clientPostId` reporté pour la dédup de l'écho WS.
  const saved: PostVoteUserDTO = await res.json();
  return { ...toForumPost(saved), clientPostId };
}

/** Modifier le contenu d'un post ; `title` (sujet racine 'Thread') envoyé s'il est fourni. */
export async function editPost(
  forumId: number,
  postId: number,
  content: string,
  title?: string
): Promise<void> {
  const res = await apiFetch(`/api/forums/${forumId}/posts/${postId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(title !== undefined ? { content, title } : { content }),
  });

  if (!res.ok) {
    throw new Error('Échec de la modification du post');
  }

  console.log('[api] Modification du post', postId, ':', content);
}

/** Supprimer un post ainsi que tout son sous-fil (cascade côté base). */
export async function deletePost(forumId: number, postId: number): Promise<void> {
  const res = await apiFetch(`/api/forums/${forumId}/posts/${postId}`, {
    method: 'DELETE',
  });

  if (!res.ok) {
    throw new Error('Échec de la suppression du post');
  }

  console.log('[api] Suppression du post', postId);
}

/**
 * Enregistrer le vote de l'utilisateur sur un post. `value` = DIRECTION cliquée
 * (+1 ou -1) — jamais 0. Le backend applique un modèle « toggle » (cf.
 * ForumService.addVoteToPost) : pas de vote → crée ; même valeur re-envoyée →
 * supprime (annulation) ; valeur opposée → bascule. La table Vote impose
 * CHECK(value_ IN (-1, 1)) : envoyer 0 déclencherait une erreur BD, d'où la
 * direction brute. `forumId` est requis (le DTO cible le post PAR son forum).
 * L'utilisateur vient du JWT (X-User-Email injecté par le gateway).
 */
export async function votePost(
  forumId: number,
  postId: number,
  value: 1 | -1
): Promise<void> {
  const res = await apiFetch('/api/forums/posts/votes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forumId, postId, voteValue: value }),
  });
  if (!res.ok) throw new Error('Échec du vote');
}
