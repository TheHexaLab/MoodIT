import { useState } from 'react';
import ProgramMenu from '../../components/ProgramMenu/ProgramMenu.tsx';
import CourseMenu, { type Course } from '../../components/CourseMenu/CourseMenu.tsx';
import {
  type ChannelMessage,
  type ChannelMessageAuthor,
  type ChannelRef,
  type CourseChannel,
  isSameChannel,
} from '../../components/CourseChannelList/CourseChannelList.tsx';
import { getPrefixForType } from '../../components/CourseChannelList/channelTypePrefix.ts';

// TODO [5] — supprimer cet import (et tout src/dev/) une fois le vrai WebSocket branché.
import { mockMessageSocket } from '../../dev/mockWsSocket.ts';
import { type UserMenuUser } from '../../components/UserMenu/UserMenu.tsx';
import LeftMenuGroup from '../../components/LeftMenuGroup/LeftMenuGroup.tsx';
import { normalizeCourseChannelsFromSources } from '../../components/CourseChannelList/courseChannelSources.ts';
import MainPanel from '../../components/MainPanel/MainPanel.tsx';
import { getDashboardPrograms } from './dashboardDataSource.ts';
import styles from './Dashboard.module.css';

const loggedInUserMock: UserMenuUser = {
  id: 1,
  username: 'jeandubois',
  firstName: 'Jean',
  lastName: 'D.',
  avatar_color: '#0a5cc0',
};

// TODO : dériver du rôle réel de l'utilisateur connecté (mock pour l'instant).
const isAdminMock = true;

// Mettre à true pour tester le chemin d'échec (rollback + ErrorPopup) des
// operations sur les messages : envoi, modification, suppression.
const SIMULATE_SEND_FAILURE = true;
const SIMULATE_DELAY = 2000;
const SIMULATE_FETCH_FAILURE = false;

/* ─────────────────────────────────────────────────────────────────────────────
 * TODO — BRANCHEMENT BACKEND + TEMPS RÉEL DU CHAT
 * Détails complets : src/components/MainPanel/ChannelView/HANDOFF.md
 *
 * Ordre de développement conseillé (chaque étape est isolée et testable) :
 *   [1] GET    messages    → handleFetchMessages   (afficher l'historique d'abord)
 *   [2] POST   message     → handleSendMessage     (RENVOYER le message persisté + client_msg_id)
 *   [3] PATCH  message     → handleEditMessage
 *   [4] DELETE message     → handleDeleteMessage
 *   [5] WebSocket          → remplacer `mockMessageSocket` par `createChannelSocket(...)`
 *                            (scaffold prêt : src/services/channelSocket.ts)
 *
 * Déjà géré côté front (ne rien recoder) : états loading/erreur, rollback optimiste,
 * déduplication optimiste ↔ écho (client_msg_id), désabonnement au changement de canal.
 * À NETTOYER en fin de parcours : tout le dossier src/dev/ (mock + menu de test).
 * ───────────────────────────────────────────────────────────────────────────── */

export default function Dashboard() {
  const dashboardPrograms = getDashboardPrograms();
  const [activeProgramId, setActiveProgramId] = useState<number>(
    dashboardPrograms && dashboardPrograms.length > 0 ?  dashboardPrograms[0].id : -1
  );
  const [selectedCourseId, setSelectedCourseId] = useState<number | undefined>(undefined);
  const [selectedChannelRef, setSelectedChannelRef] = useState<ChannelRef | undefined>(undefined);

  // TODO : remplacer par une navigation ou un rendu de vue lors de l'implémentation des canaux.
  const handleOpenChannel = (channel: CourseChannel) => {
    console.log('[Dashboard] Ouverture du canal :', channel);
  };

  // TODO : ouvrir le formulaire d'ajout de programme.
  const handleAddProgram = () => {
    console.log("[Dashboard] Ajout d'un programme demandé.");
  };

  // TODO : ouvrir le formulaire d'ajout de cours.
  const handleAddCourse = () => console.log('[Dashboard] Ajouter un cours demandé.');
  // TODO : ouvrir le formulaire de création de canal texte.
  const handleCreateChannel = () => console.log('[Dashboard] Créer un canal demandé.');
  // TODO : ouvrir le formulaire de création de quiz.
  const handleCreateQuiz = () => console.log('[Dashboard] Créer un quiz demandé.');
  // TODO : ouvrir le formulaire de création de forum.
  const handleCreateForum = () => console.log('[Dashboard] Créer un forum demandé.');

  // Auteur des messages envoyés = utilisateur connecte (colonnes utiles de User_).
  const currentUserAuthor: ChannelMessageAuthor = {
    id: loggedInUserMock.id,
    username: loggedInUserMock.username,
    first_name: loggedInUserMock.firstName ?? '',
    last_name: loggedInUserMock.lastName ?? '',
  };

  // TODO [2] — API POST du message (post_parent_id si réponse).
  // ⚠ RENVOYER le message persisté (id réel) pour la réconciliation, et stocker le
  //   clientMessageId pour que le broadcast WS le renvoie (dédup). Voir HANDOFF.md.
  const handleSendMessage = async (
    content: string,
    parentId: number | null,
    clientMessageId: string
  ) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (envoi de message)');
    console.log(
      '[Dashboard] Envoi de message :',
      content,
      '(post_parent_id =',
      parentId,
      ', client_msg_id =',
      clientMessageId,
      ')'
    );
  };

  // TODO [3] — API PATCH du message. Simulation pour l'instant.
  const handleEditMessage = async (messageId: number, content: string) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (modification de message)');
    console.log('[Dashboard] Modification du message', messageId, ':', content);
  };

  // TODO [4] — API DELETE du message. Simulation pour l'instant.
  const handleDeleteMessage = async (messageId: number) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (suppression de message)');
    console.log('[Dashboard] Suppression du message', messageId);
  };

  const activeProgram =
    dashboardPrograms.find((program) => program.id === activeProgramId) ?? null;
  const courses = activeProgram?.courses ?? [];
  const effectiveSelectedCourseId = getEffectiveSelectedCourseId(courses, selectedCourseId);
  const selectedCourse = getSelectedCourse(courses, effectiveSelectedCourseId);
  const selectedCourseChannels = selectedCourse
    ? normalizeCourseChannelsFromSources({
        channels: selectedCourse.channels,
        quizzes: selectedCourse.quizzes,
        forums: selectedCourse.forums,
      })
    : [];
  const selectedChannel =
    selectedCourseChannels.find((channel) => isSameChannel(channel, selectedChannelRef)) ?? null;

  // TODO [1] — API GET /channels/:id/messages (charger l'historique du canal).
  // Simulation pour l'instant : petit délai pour montrer l'état « Chargement… »,
  // puis on renvoie les messages mock du canal demandé.
  const handleFetchMessages = async (channelId: number): Promise<ChannelMessage[]> => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_FETCH_FAILURE) throw new Error('Échec simulé (chargement des messages)');
    return selectedChannel?.id === channelId ? (selectedChannel.messages ?? []) : [];
  };

  const mobileTopbarTitle = selectedChannel
    ? `${getPrefixForType(selectedChannel.type)} ${selectedChannel.name}`
    : 'Accueil';
  const mobileUserInitial = getUserInitial(loggedInUserMock);

  return (
    <div className={styles.dashboardLayout}>
      <LeftMenuGroup
        mobileTitle={mobileTopbarTitle}
        mobileUserInitial={mobileUserInitial}
        programMenu={
          <ProgramMenu
            programs={dashboardPrograms}
            activeProgramId={activeProgramId}
            onSelectProgram={(nextProgramId) => {
              setActiveProgramId(nextProgramId);
              setSelectedChannelRef(undefined);

              const nextProgram = dashboardPrograms.find((program) => program.id === nextProgramId);

              setSelectedCourseId(getEffectiveSelectedCourseId(nextProgram?.courses ?? [], undefined));
            }}
            onAddProgram={handleAddProgram}
          />
        }
        courseMenu={
          <CourseMenu
            activeProgram={activeProgram}
            courses={courses}
            currentUser={loggedInUserMock}
            selectedCourseId={effectiveSelectedCourseId}
            onSelectCourse={(courseId) => {
              setSelectedCourseId(courseId);
              setSelectedChannelRef(undefined);
            }}
            selectedChannel={selectedChannelRef}
            onSelectChannel={setSelectedChannelRef}
            onOpenChannel={handleOpenChannel}
          />
        }
      />

      <MainPanel
        isAdmin={isAdminMock}
        program={activeProgram}
        selectedCourse={effectiveSelectedCourseId ?? null}
        selectedChannel={selectedChannelRef ?? null}
        currentUser={currentUserAuthor}
        onFetchMessages={handleFetchMessages}
        onSendMessage={handleSendMessage}
        onEditMessage={handleEditMessage}
        onDeleteMessage={handleDeleteMessage}
        // TODO [5] — remplacer le mock par le vrai socket :
        //   const socket = useMemo(() => createChannelSocket(import.meta.env.VITE_WS_URL, getAuthToken), []);
        //   puis socket={socket}  (scaffold : src/services/channelSocket.ts)
        socket={mockMessageSocket}
        onAddProgram={handleAddProgram}
        onAddCourse={handleAddCourse}
        onCreateChannel={handleCreateChannel}
        onCreateQuiz={handleCreateQuiz}
        onCreateForum={handleCreateForum}
      />
    </div>
  );
}

function getUserInitial(user: UserMenuUser): string {
  const display = user.firstName?.trim() || user.username?.trim() || 'U';
  return display[0].toUpperCase();
}

function getEffectiveSelectedCourseId(
  courses: Course[],
  selectedCourseId: number | undefined
): number | undefined {
  if (courses.length === 0) return undefined;

  const selectedCourseStillExists = courses.some((course) => course.id === selectedCourseId);

  return selectedCourseStillExists ? selectedCourseId : courses[0].id;
}

function getSelectedCourse(courses: Course[], selectedCourseId: number | undefined): Course | null {
  return courses.find((course) => course.id === selectedCourseId) ?? courses[0] ?? null;
}
