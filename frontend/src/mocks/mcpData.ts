import type { McpAnalysis, McpResponse, McpResponseSummary, User } from '../types/domain.ts';

/** Enseignant mock ayant déclenché les analyses (résout user_id → User_). */
const MOCK_AUTHOR: User = {
  id: 1,
  username: 'martin',
  firstName: 'Prof.',
  lastName: 'Martin',
  avatarColor: '#1f4799',
};

/**
 * Mock « API-ready » des réponses du service MCP (table MCP_Response). Chaque réponse
 * porte son analyse structurée sérialisée dans `content` (JSON), comme le ferait le
 * vrai service. La LISTE ne renvoie que des résumés (sans contenu) ; le DÉTAIL (content)
 * est récupéré par id à la demande. À remplacer par de vrais GET/POST au branchement.
 */

/** Construit une MCP_Response : l'analyse structurée est sérialisée dans `content`. */
function makeResponse(
  id: number,
  createdAt: string,
  courseId: number,
  analysis: McpAnalysis,
): McpResponse {
  return {
    id,
    createdAt,
    content: JSON.stringify(analysis),
    userId: MOCK_AUTHOR.id,
    courseId,
    author: MOCK_AUTHOR,
  };
}

/** Historique mock par défaut (calqué sur le Figma) ; stampé sur le cours demandé. */
const DEFAULT_ANALYSES: { createdAt: string; analysis: McpAnalysis }[] = [
  {
    createdAt: '2026-06-18T14:32:00',
    analysis: {
      score: 82,
      strengths: [
        'Forte entraide sur les forums — taux de participation de 78 %.',
        'Excellents résultats au quiz « Matrices » — score moyen de 86 %.',
        'Bonne dynamique de groupe et échanges actifs dans #général.',
      ],
      improvements: [
        'Notion de « valeurs propres » mal maîtrisée — 54 % d\'échec au quiz.',
        'Peu d\'activité sur le forum « projet-final ».',
      ],
      sources: { quizCount: 3, forumMessageCount: 14, studentCount: 26 },
    },
  },
  {
    createdAt: '2026-06-11T09:10:00',
    analysis: {
      score: 71,
      strengths: [
        'Progression nette sur les exercices de déterminants.',
        'Participation régulière aux quiz hebdomadaires.',
      ],
      improvements: [
        'Beaucoup de questions sans réponse sur le forum « entraide-algèbre ».',
        'Taux de remise des devoirs en baisse (68 %).',
        'Concepts de diagonalisation peu abordés dans les échanges.',
      ],
      sources: { quizCount: 2, forumMessageCount: 21, studentCount: 26 },
    },
  },
  {
    createdAt: '2026-06-04T16:45:00',
    analysis: {
      score: 88,
      strengths: [
        'Excellente assiduité aux quiz (94 % de participation).',
        'Climat d\'entraide marqué dans #général et #entraide.',
        'Très bons résultats sur les systèmes linéaires (91 %).',
        'Réponses rapides des pairs sur les forums (< 2 h en moyenne).',
      ],
      improvements: ['Quelques difficultés résiduelles sur les espaces vectoriels.'],
      sources: { quizCount: 4, forumMessageCount: 9, studentCount: 25 },
    },
  },
];

/** Variantes d'analyse « générées » à la demande (POST « Analyser mon cours »). */
const GENERATED_ANALYSES: McpAnalysis[] = [
  {
    score: 79,
    strengths: [
      'Hausse de la participation aux quiz cette semaine (+12 %).',
      'Bonne couverture des matrices dans les discussions.',
    ],
    improvements: [
      'Le forum « projet-final » reste peu actif.',
      'Notions de valeurs propres encore fragiles (48 % de réussite).',
    ],
    sources: { quizCount: 3, forumMessageCount: 17, studentCount: 26 },
  },
  {
    score: 84,
    strengths: [
      'Excellente dynamique d\'entraide entre pairs.',
      'Score moyen en hausse sur les déterminants (88 %).',
      'Forte assiduité aux quiz (90 %).',
    ],
    improvements: ['Participation inégale selon les sous-groupes.'],
    sources: { quizCount: 4, forumMessageCount: 12, studentCount: 26 },
  },
];

/** Toutes les réponses connues, par id (seedées par cours + générées à la demande). */
const responsesById = new Map<number, McpResponse>();
const seededCourses = new Set<number>();
let generatedSeq = 0;

/** Seed (une fois par cours) des analyses par défaut dans le registre. */
function seedCourse(courseId: number): void {
  if (seededCourses.has(courseId)) return;
  seededCourses.add(courseId);
  DEFAULT_ANALYSES.forEach((entry, index) => {
    const id = courseId * 1000 + index + 1;
    responsesById.set(id, makeResponse(id, entry.createdAt, courseId, entry.analysis));
  });
}

/** Projection résumé (compteurs dérivés du contenu). */
function toSummary(response: McpResponse): McpResponseSummary {
  const analysis = JSON.parse(response.content) as McpAnalysis;
  return {
    id: response.id,
    createdAt: response.createdAt,
    strengthsCount: analysis.strengths.length,
    improvementsCount: analysis.improvements.length,
  };
}

/** GET tous les résumés de l'historique d'un cours (sans contenu), tri récent → ancien. */
export function getMcpResponseSummaries(courseId: number): McpResponseSummary[] {
  seedCourse(courseId);
  return [...responsesById.values()]
    .filter((response) => response.courseId === courseId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toSummary);
}

/** GET le détail complet d'une analyse (avec contenu), récupéré à la demande. */
export function getMcpResponse(id: number): McpResponse | undefined {
  return responsesById.get(id);
}

/**
 * POST — « génère » une analyse (datée maintenant), la stocke, renvoie son résumé.
 * `userId` = l'utilisateur qui a lancé l'analyse (rattaché à la ligne MCP_Response).
 */
export function generateMcpResponse(courseId: number, userId: number): McpResponseSummary {
  seedCourse(courseId);
  const analysis = GENERATED_ANALYSES[generatedSeq % GENERATED_ANALYSES.length];
  generatedSeq += 1;
  const id = courseId * 1000 + 900 + generatedSeq;
  const response: McpResponse = {
    id,
    createdAt: new Date().toISOString(),
    content: JSON.stringify(analysis),
    userId,
    courseId,
    author: MOCK_AUTHOR,
  };
  responsesById.set(id, response);
  return toSummary(response);
}

/**
 * Analyses MCP « en cours » côté serveur, par couple (cours, utilisateur LANCEUR).
 * Le lien cours ↔ user permet à un autre onglet / un rechargement de page de retrouver
 * l'état « en cours » (cf. fetchPendingAnalysis). À terme : statut persistant en base.
 */
const pendingAnalyses = new Set<string>();
const pendingKey = (courseId: number, userId: number): string => `${courseId}:${userId}`;

/** L'utilisateur a-t-il une analyse en cours pour ce cours ? */
export function isAnalysisPending(courseId: number, userId: number): boolean {
  return pendingAnalyses.has(pendingKey(courseId, userId));
}

/** Marque une analyse en cours pour (cours, user). */
export function markAnalysisPending(courseId: number, userId: number): void {
  pendingAnalyses.add(pendingKey(courseId, userId));
}

/** Libère le « en cours » pour (cours, user). */
export function clearAnalysisPending(courseId: number, userId: number): void {
  pendingAnalyses.delete(pendingKey(courseId, userId));
}
