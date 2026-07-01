// Couche « API » du Dashboard, regroupée ici pour un seul point de bascule vers le
// vrai backend. POUR L'INSTANT chaque fonction simule l'appel réseau (latence +
// échec optionnel) et renvoie des données mock — mais la signature est déjà celle
// attendue. Le Dashboard se contente d'orchestrer l'état autour.
//
// TODO (global) : remplacer le corps de chaque fonction `simulate*` ci-dessous
// par un vrai apiFetch(...) (cf. src/helpers/api.ts), sans toucher au Dashboard.

import type { NewCourse } from '../../components/AddCoursePopup/types.ts';
import type { JoinSelection, NewProgram } from '../../components/AddSubscriptionPopup/types.ts';
import type { CourseUpdate } from '../../components/UpdateCoursePopup/types.ts';
import type { ProgramUpdate } from '../../components/UpdateProgramPopup/types.ts';
import type { RoleChange } from '../../components/RoleEditorPopup/types.ts';
import type { ItemChange } from '../../components/SectionEditorPopup/types.ts';
import type {
  AnswerResponse,
  ChannelMessage,
  DragItemResponse,
  ForumResponse,
  QuestionResponse,
} from '../../types/domain.ts';
import {
  getMockForumReplies,
  getMockForumThreads,
} from '../../components/MainPanel/ForumView/forumThreads.ts';
//import { normalizeCourseChannelsFromSources } from '../../components/CourseChannelList/courseChannelSources.ts';
import type {
  Course,
  CourseForumsResponse,
  McpResponse,
  McpResponseSummary,
  QuizDetailResponse,
  QuizResponse,
} from '../../types/domain.ts';
import {
  clearAnalysisPending,
  generateMcpResponse,
  getMcpResponse,
  getMcpResponseSummaries,
  isAnalysisPending,
  markAnalysisPending,
} from '../../mocks/mcpData.ts';
//import { getEstablishmentPrograms } from '../../mocks/subscriptionData.ts';
import { getProgramRoles, getProgramUsers } from '../../mocks/roleData.ts';
//import { getDashboardPrograms } from './dashboardDataSource.ts';
import type { DemoProgram } from '../../mocks/dashboardData.ts';
import {
  type Language,
  type QuestionTypeOption,
  type Quiz,
} from '../../types/domain.ts';
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
// Durée simulée d'un job MCP (génération) avant le push de complétion.
const MOCK_MCP_JOB_MS = 2500;

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

/**
 * Id de l'utilisateur courant. MOCK : lu dans localStorage (comme fetchPrograms).
 * RÉEL : le backend le dérive du JWT — la signature des fonctions n'a donc pas besoin
 * de le porter (il n'apparaît pas dans le contrat public).
 */
function currentUserId(): number {
  return Number(localStorage.getItem('moodit_user_id')) || 0;
}

// ── Programmes / cours (chargement) ────────────────────────────────────────────

/**
 * TODO — Récupérer la liste des programmes auxquels l'utilisateur est abonné. Les
 * cours sont chargés séparément (fetchCourses) à l'entrée dans un programme : on
 * renvoie donc ici les programmes SANS leurs cours.
 * DONE
 */
export async function fetchPrograms(): Promise<DemoProgram[]> {
  console.log('fetchPrograms');
  const userId = localStorage.getItem('moodit_user_id');
  const res = await apiFetch(`/api/users/${userId}/programs`);
  if (!res.ok) throw new Error('Échec chargement des programmes');
  const data = await res.json();
  return data.map((p: DemoProgram) => ({ ...p, courses: [] }));
}

/** TODO — Récupérer les cours d'un programme (avec leurs canaux/quiz/forums). */
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

/** Charger le détail d'un quiz (questions embarquées) pour la passation côté étudiant. */
export async function fetchQuiz(quizId: number): Promise<Quiz> {
  const res = await apiFetch(`/api/quizzes/${quizId}`);
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
 * TODO — Langages d'exécution disponibles (table Language). Alimente le sélecteur de
 * langage de l'éditeur de quiz. MOCK : liste par défaut (côté CODE, non branché ici).
 */
/**
 * Types de question disponibles (table Q_Type : id + name FR). Alimente le sélecteur
 * de type de l'éditeur de question.
 */
export async function fetchQuestionTypes(): Promise<QuestionTypeOption[]> {
  const res = await apiFetch('/api/question-types');
  if (!res.ok) throw new Error('Échec chargement des types de question');
  return await res.json();
}

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
 * TODO — Charger les données du gestionnaire de rôles d'un programme :
 * la liste des rôles attribuables ET la liste des membres avec le rôle de chacun. Alimente le
 * RoleEditorPopup.
 */
export async function fetchProgramRoles(programId: number) {
  await simulateFetch('fetch roles failed');
  return { roles: getProgramRoles(), users: getProgramUsers(programId) };
}

// ── Établissements / catalogue (AddSubscriptionPopup) ──────────────────────────

/**
 * TODO — Lister les établissements dans lesquels l'utilisateur peut CRÉER un
 * programme (1re étape du AddSubscriptionPopup en mode création).
 */
export async function fetchEstablishmentsForCreate() {
  const res = await apiFetch('/api/establishments');
  if (!res.ok) throw new Error('Échec chargement des établissements');
  return res.json();
}

/**
 * TODO — Lister les établissements dont l'utilisateur peut REJOINDRE des programmes
 * existants (1re étape du AddSubscriptionPopup en mode adhésion).
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
 * TODO — Lister le catalogue des programmes existants d'un établissement
 * pour que l'utilisateur choisisse ceux qu'il veut rejoindre.
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
 * TODO — Lister les cours rejoignables d'un programme.
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
 * TODO — Lister les ids des cours d'un programme auxquels l'utilisateur est DÉJÀ rattaché (ses inscriptions).
 * Sert à pré-cocher le JoinCoursesPopup, indépendamment
 * de l'état (lazy-loaded) du Dashboard. Mock : tous les cours du programme.
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
 * TODO — Historique des analyses MCP d'un cours : RÉSUMÉS (sans contenu), tri récent →
 * ancien. Tout est renvoyé d'un coup. Le détail est chargé à la demande via
 * fetchCourseAnalysis(id).
 */
export async function fetchCourseAnalyses(courseId: number): Promise<McpResponseSummary[]> {
  await simulateFetch('Échec simulé (historique des analyses MCP)');
  return getMcpResponseSummaries(courseId);
}

/**
 * TODO — Détail complet d'une analyse MCP (table MCP_Response, avec `content`), chargé
 * au clic sur une entrée de l'historique.
 */
export async function fetchCourseAnalysis(id: number): Promise<McpResponse> {
  await simulateFetch('Échec simulé (détail de l’analyse MCP)');
  const response = getMcpResponse(id);
  if (!response) throw new Error('Analyse introuvable');
  return response;
}

/**
 * TODO — L'utilisateur courant a-t-il une analyse MCP EN COURS pour ce cours ? Permet
 * de réhydrater l'état « en cours » du popup (survit à un rechargement de page). Le
 * lien est (cours, utilisateur) : côté réel, l'utilisateur vient du JWT.
 */
export async function fetchPendingAnalysis(courseId: number): Promise<boolean> {
  await simulateFetch('Échec simulé (statut de l’analyse MCP)');
  return isAnalysisPending(courseId, currentUserId());
}

// ── Programmes / cours (écriture) ──────────────────────────────────────────────

/**
 * TODO — Créer un cours (titre, code) et le rattacher aux programmes choisis
 * (`programIds`). Renvoie le cours persisté (id attribué par le « serveur ») pour
 * que le Dashboard l'insère dans sa liste.
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
 * TODO — Créer un nouveau programme et y abonner l'utilisateur d'office. Renvoie le
 * programme persisté (id attribué par le « serveur ») pour l'ajouter à la liste.
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
 * TODO — Abonner l'utilisateur aux programmes sélectionnés du catalogue. Renvoie les
 * programmes ajoutés ; le Dashboard les dédoublonne contre sa liste avant insertion.
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
 * TODO — Mettre à jour un cours (code, titre) et, le cas échéant, son rattachement
 * aux programmes (relation many-to-many program_course).
 */
export async function updateCourse(courseId: number, update: CourseUpdate): Promise<void> {
  console.log('updateCourse');
  await simulateWrite('Échec simulé (modification de cours)');
  console.log(courseId, update);
}

/** TODO — Mettre à jour les champs d'un programme : nom, code, cohorte, couleur. */
export async function updateProgram(programId: number, update: ProgramUpdate): Promise<void> {
  await simulateWrite('Échec simulé (modification de programme)');
  console.log(programId, update);
}

/** TODO — Désabonner l'utilisateur d'un programme (le retirer de sa liste). */
export async function leaveProgram(programId: number): Promise<void> {
  await simulateWrite('Échec simulé (quitter le programme)');
  console.log(programId);
}

/** TODO — Retirer l'utilisateur d'un cours (le retirer de sa liste de cours). */
export async function leaveCourse(courseId: number): Promise<void> {
  console.log('leaveCourse');
  await simulateWrite('Échec simulé (quitter le cours)');
  console.log(courseId);
}

/**
 * TODO — Déclencher une analyse MCP d'un cours (« Analyser mon cours »). ASYNCHRONE : le
 * serveur ACCEPTE le job (202) et marque (cours, user) « en cours » ; il ne renvoie PAS
 * le résultat. Celui-ci arrive plus tard par WebSocket (cf. subscribeCourseAnalyses).
 */
export async function requestCourseAnalysis(courseId: number): Promise<void> {
  await simulateWrite('Échec simulé (analyse MCP)');
  const userId = currentUserId();
  markAnalysisPending(courseId, userId);
  // Simulation du job serveur : après un délai, il persiste la réponse et libère le verrou.
  // En prod, c'est le backend qui le fait PUIS pousse `mcp:analysis-created` par WebSocket
  // (ws.mcp, cf. Dashboard) — le push live n'est PAS simulé ici (nécessite core-service).
  setTimeout(() => {
    generateMcpResponse(courseId, userId);
    clearAnalysisPending(courseId, userId);
  }, MOCK_MCP_JOB_MS);
}

/**
 * TODO — Inscrire l'utilisateur aux cours choisis d'un programme. Renvoie les cours
 * rejoints (forme `Course`, sans canaux) pour que le Dashboard les fusionne dans le
 * programme. `courseIds` ⊆ des ids renvoyés par fetchProgramCourses(programId).
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
 * TODO — Persister une modification de la structure d'un cours : ajout, renommage,
 * suppression ou réordonnancement d'une section (canal, quiz ou forum). `change`
 * décrit l'opération exacte ; `sectionType` indique la famille de section visée.
 */
export async function changeSection(
  courseId: number,
  sectionType: string,
  change: ItemChange
): Promise<void> {
  const res = await apiFetch(`/api/courses/${courseId}`, {
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
}

/**
 * TODO — Attribuer ou retirer un rôle à un membre dans un programme (le RoleEditorPopup
 * gère l'optimisme + rollback : on ne fait que persister le changement).
 */
export async function changeRole(change: RoleChange): Promise<void> {
  const res = await apiFetch(`/api/roles/change`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(change),
  });

  if (!res.ok) {
    throw new Error('Échec assignation de rôle');
  }
}

// ── Chat ('Discussion') ────────────────────────────────────────────────────────

/**
 * TODO — Charger l'historique des messages d'un canal de chat. Le mock recherche le
 * canal dans les programmes mock (par id) et renvoie ses messages.
 */
export async function fetchMessages(channelId: number): Promise<ChannelMessage[]> {
  console.log('fetchMessages');
  const res = await apiFetch(`/api/forums/${channelId}/messages`);

  if (!res.ok) {
    throw new Error('Échec chargement des messages');
  }

  const messages = await res.json();

  console.log('Messages: ', messages);

  return messages;
}

/**
 * TODO — Publier un message dans le canal `channelId` (réponse à un autre si `parentId`).
 * Devra RENVOYER le message persisté (id réel) en conservant le `clientMessageId`, afin
 * de réconcilier l'affichage optimiste et de dédupliquer l'écho reçu par WebSocket.
 */
export async function sendMessage(
  channelId: number,
  content: string,
  parentId: number | null,
  clientMessageId: string
): Promise<void> {
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
}

/** TODO — Modifier le contenu d'un message existant. */
export async function editMessage(messageId: number, content: string): Promise<void> {
  await simulateWrite('Échec simulé (modification de message)');
  console.log('[api] Modification du message', messageId, ':', content);
}

/** TODO — Supprimer un message. */
export async function deleteMessage(messageId: number): Promise<void> {
  await simulateWrite('Échec simulé (suppression de message)');
  console.log('[api] Suppression du message', messageId);
}

// ── Forum ('Thread') ───────────────────────────────────────────────────────────

/**
 * TODO — Charger les sujets RACINES d'un forum, SANS leurs réponses (chargement
 * paresseux : les réponses sont récupérées à la demande via fetchReplies).
 */
export async function fetchThreads(forumId: number) {
  await simulateFetch('Échec simulé (chargement des sujets)');
  return getMockForumThreads(forumId);
}

/**
 * TODO — Charger les réponses DIRECTES (enfants immédiats) d'un post, au moment où
 * l'utilisateur déplie le fil.
 */
export async function fetchReplies(postId: number) {
  console.log('fetchReplies');
  await simulateFetch('Échec simulé (chargement des réponses)');
  return getMockForumReplies(postId);
}

/**
 * TODO — Publier un sujet ou une réponse dans le forum `forumId` (réponse si `parentId`,
 * avec un `title` pour un sujet racine). Devra RENVOYER le post persisté (id réel) en
 * conservant le `clientPostId` pour la réconciliation optimiste ↔ écho WebSocket.
 */
export async function createPost(
  forumId: number,
  content: string,
  parentId: number | null,
  clientPostId: string,
  title?: string
): Promise<void> {
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
}

/** TODO — Modifier le contenu d'un post. */
export async function editPost(postId: number, content: string): Promise<void> {
  await simulateWrite('Échec simulé (modification de post)');
  console.log('[api] Modification du post', postId, ':', content);
}

/** TODO — Supprimer un post ainsi que tout son sous-fil (cascade côté base). */
export async function deletePost(postId: number): Promise<void> {
  await simulateWrite('Échec simulé (suppression de post)');
  console.log('[api] Suppression du post', postId);
}

/**
 * TODO — Enregistrer le vote de l'utilisateur sur un post. `value` ∈ {-1, 0, 1} où
 * 0 = retrait du vote (un seul vote par utilisateur et par post).
 */
export async function votePost(postId: number, value: number): Promise<void> {
  await simulateWrite('Échec simulé (vote)');
  console.log('[api] Vote sur le post', postId, ':', value);
}
