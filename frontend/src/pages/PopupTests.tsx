import { useState } from 'react';
import * as React from 'react';
import { SectionEditor, type ItemChange } from '../components/SectionEditor/SectionEditor.tsx';
import { RoleEditor, type Role, type RoleChange, type User } from '../components/RoleEditor/RoleEditor.tsx';
import { AddCoursePopup, type NewCourse, type Program } from '../components/AddCoursePopup/AddCoursePopup.tsx';
import { UpdateCoursePopup, type CourseUpdate } from '../components/UpdateCoursePopup/UpdateCoursePopup.tsx';
import { DeleteConfirmationBox } from '../components/DeleteConfirmationBox/DeleteConfirmationBox.tsx';
import { ErrorBox } from '../components/ErrorBox/ErrorBox.tsx';
import { EditProfilePopup, type ProfileUpdate } from '../components/EditProfilePopup/EditProfilePopup.tsx';
import { UpdateProgramPopup, type ProgramUpdate } from '../components/UpdateProgramPopup/UpdateProgramPopup.tsx';
import {
  AddSubscriptionPopup,
  type NewProgram,
  type Establishment,
  type Program as JoinProgram,
  type JoinSelection,
  type CreateEstablishment,
  type JoinEstablishment,
} from '../components/AddSubscriptionPopup/AddSubscriptionPopup.tsx';
import { Sun } from '../assets/Sun.tsx';
import { Moon } from '../assets/Moon.tsx';
import { useTheme } from '../helpers/theme.ts';

/** Mock — programmes fournis au AddCoursePopup (alignés sur init.sql). */
const programs: Program[] = [
  { id: 1, name: 'Génie informatique', code: 'GIN', cohort: 'Promo 71', color: '#1a6e3c' },
  { id: 2, name: 'Génie logiciel', code: 'GLO', cohort: 'Promo 71', color: '#0a5cc0' },
  { id: 3, name: 'Génie électrique', code: 'GEL', cohort: 'Promo 71', color: '#8b1a1a' },
  { id: 4, name: 'Génie mécanique', code: 'GMC', cohort: 'Promo 71', color: '#7a4e1a' },
  { id: 5, name: 'Génie civil', code: 'GCI', cohort: 'Promo 71', color: '#3a3a7a' },
  { id: 6, name: 'Génie chimique', code: 'GCH', cohort: 'Promo 71', color: '#4a7a1a' },
  { id: 7, name: "Génie de l'environnement", code: 'GEN', cohort: 'Promo 2024', color: '#0a7a6e' },
  { id: 8, name: 'Génie biotechnologique', code: 'GBT', cohort: 'Promo 2024', color: '#9333ea' },
  { id: 9, name: 'Génie robotique', code: 'GRO', cohort: 'Promo 2025', color: '#0891b2' },
  { id: 10, name: 'Génie aérospatial', code: 'GAE', cohort: 'Promo 71', color: '#b45309' },
  { id: 11, name: 'Génie physique', code: 'GPH', cohort: 'Promo 71', color: '#be185d' },
  { id: 12, name: 'Génie des matériaux', code: 'GMA', cohort: 'Promo 2024', color: '#15803d' },
  { id: 13, name: 'Génie industriel', code: 'GIA', cohort: 'Promo 71', color: '#1d4ed8' },
  { id: 14, name: 'Génie alimentaire', code: 'GAL', cohort: 'Promo 2025', color: '#c2410c' },
];

/**
 * Mock — rôles fournis au RoleEditor (ids alignés sur init.sql).
 * L'ordre du tableau = ordre d'affichage des sections.
 */
const roles: Role[] = [
  { id: 4, name: 'Administrateur' },
  { id: 2, name: 'Enseignant' },
  { id: 3, name: 'Mainteneur' },
];

/**
 * Mock — liste d'utilisateurs fournie au RoleEditor.
 * role_ids : Enseignant=2, Mainteneur=3, Administrateur=4 ; [] = non assigné (candidat partout).
 */
const roleUsers: User[] = [
  { id: 1, username: 'admin', first_name: 'Admin', last_name: 'Admin', email: 'admin@usherbrooke.ca', avatar_color: '#0a5cc0', role_ids: [4] },
  { id: 2, username: 'tremblaymar', first_name: 'Marie', last_name: 'Tremblay', email: 'tremblaymar@usherbrooke.ca', avatar_color: '#f6c350', role_ids: [4] }, // fond clair → texte sombre
  { id: 3, username: 'gagnonjp', first_name: 'Jean-Philippe', last_name: 'Gagnon', email: 'gagnonjp@usherbrooke.ca', avatar_color: '#1a6e3c', role_ids: [2] },
  { id: 4, username: 'roygenev', first_name: 'Geneviève', last_name: 'Roy', email: 'roygenev@usherbrooke.ca', avatar_color: '#7a4e1a', role_ids: [2] },
  { id: 5, username: 'lavoiesam', first_name: 'Samuel', last_name: 'Lavoie', email: 'lavoiesam@usherbrooke.ca', avatar_color: '#3a3a7a', role_ids: [2] },
  { id: 6, username: 'bouchardalx', first_name: 'Alexandre', last_name: 'Bouchard', email: 'bouchardalx@usherbrooke.ca', avatar_color: '#0a7a6e', role_ids: [3] },
  { id: 7, username: 'fortinemi', first_name: 'Émilie', last_name: 'Fortin', email: 'fortinemi@usherbrooke.ca', avatar_color: '#4a7a1a', role_ids: [3] },
  { id: 8, username: 'cotemax', first_name: 'Maxime', last_name: 'Côté', email: 'cotemax@usherbrooke.ca', avatar_color: '#0a5cc0', role_ids: [2] },
  { id: 9, username: 'belangerju', first_name: 'Julie', last_name: 'Bélanger', email: 'belangerju@usherbrooke.ca', avatar_color: '#8b1a1a', role_ids: [2] },
  { id: 10, username: 'pelletierni', first_name: 'Nicolas', last_name: 'Pelletier', email: 'pelletierni@usherbrooke.ca', avatar_color: '#4a7a1a', role_ids: [2] },
  // Non assignés : disponibles à l'ajout dans n'importe quelle section.
  { id: 11, username: 'morinclar', first_name: 'Clara', last_name: 'Morin', email: 'morinclar@usherbrooke.ca', avatar_color: '#5eead4', role_ids: [] }, // fond clair → texte sombre
  { id: 12, username: 'girardtho', first_name: 'Thomas', last_name: 'Girard', email: 'girardtho@usherbrooke.ca', avatar_color: '#3a3a7a', role_ids: [] },
];

/** Mock — établissements fournis au AddSubscriptionPopup (aligné sur init.sql). */
const establishments: Establishment[] = [
  { id: 1, name: 'Université de Sherbrooke' },
  { id: 2, name: 'Université Laval' },
  { id: 3, name: 'Polytechnique Montréal' },
  { id: 4, name: 'Université de Montréal' },
  { id: 5, name: 'Université McGill' },
  { id: 6, name: 'Université Concordia' },
  { id: 7, name: 'Université du Québec à Montréal' },
  { id: 8, name: 'Université du Québec à Trois-Rivières' },
  { id: 9, name: 'Université du Québec à Chicoutimi' },
  { id: 10, name: 'Université du Québec en Outaouais' },
  { id: 11, name: 'École de technologie supérieure' },
  { id: 12, name: 'HEC Montréal' },
];

/**
 * Mock — programmes rattachés aux établissements, fournis au AddSubscriptionPopup (vue rejoindre).
 * Université de Sherbrooke (id 1) reçoit la majorité (assez pour scroller), Laval (2) et
 * Polytechnique (3) en ont quelques-uns ; les autres établissements n'en ont aucun (désactivés).
 */
const joinPrograms: JoinProgram[] = programs.map((p, i) => ({
  ...p,
  establishmentId: i < 10 ? 1 : i < 12 ? 2 : 3,
}));

/** Mock — canaux fournis au SectionEditor. */
const channels = [
  { id: '1', name: 'general' },
  { id: '2', name: 'annonces' },
  { id: '3', name: 'aide' },
];

/** Page de test : ouvre et essaie chaque popup avec des données mock. */
export default function PopupTests() {
  const [showSectionEditor, setShowSectionEditor] = useState(false);
  const [showRoleEditor, setShowRoleEditor] = useState(false);
  const [showAddCourse, setShowAddCourse] = useState(false);
  const [showUpdateCourse, setShowUpdateCourse] = useState(false);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [showUpdateProgram, setShowUpdateProgram] = useState(false);
  const [showAddSubscription, setShowAddSubscription] = useState(false);
  const [showErrorBox, setShowErrorBox] = useState(false);
  /** Mode « bug » : les callbacks du AddSubscriptionPopup échouent (test des erreurs). */
  const [failRequests, setFailRequests] = useState(false);
  const { theme, toggleTheme } = useTheme();

  return (
    <div style={styles.container}>
      <button
        style={{
          ...styles.bugButton,
          ...(failRequests ? styles.bugButtonOn : styles.bugButtonOff),
        }}
        onClick={() => setFailRequests((v) => !v)}
        aria-pressed={failRequests}
        title="Bascule l'échec des requêtes du AddSubscriptionPopup"
      >
        {failRequests ? '🐛 Requêtes : bug' : '✓ Requêtes : OK'}
      </button>
      <button
        style={styles.themeButton}
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre'}
      >
        {theme === 'dark' ? (
          <Sun width="1.25rem" height="1.25rem" />
        ) : (
          <Moon width="1.25rem" height="1.25rem" />
        )}
      </button>
      <h1 style={styles.title}>Test des popups</h1>
      <p style={styles.subtitle}>
        Page de test : chaque bouton ouvre un popup avec des données mock. Les actions (onChange /
        onSave) sont loguées dans la console.
      </p>

      <div style={styles.buttons}>
        <button style={styles.button} onClick={() => setShowDeleteConfirmation(true)}>
          DeleteConfirmationBox
        </button>
        <button style={styles.button} onClick={() => setShowSectionEditor(true)}>
          SectionEditor (canaux)
        </button>
        <button style={styles.button} onClick={() => setShowRoleEditor(true)}>
          RoleEditor (rôles)
        </button>
        <button style={styles.button} onClick={() => setShowAddCourse(true)}>
          AddCoursePopup (cours)
        </button>
        <button style={styles.button} onClick={() => setShowUpdateCourse(true)}>
          UpdateCoursePopup (cours)
        </button>
        <button style={styles.button} onClick={() => setShowEditProfile(true)}>
          EditProfilePopup (profil)
        </button>
        <button style={styles.button} onClick={() => setShowUpdateProgram(true)}>
          UpdateProgramPopup (programme)
        </button>
        <button style={styles.button} onClick={() => setShowAddSubscription(true)}>
          AddSubscriptionPopup (programme)
        </button>
        <button style={styles.button} onClick={() => setShowErrorBox(true)}>
          ErrorBox (erreur)
        </button>
      </div>

      {showSectionEditor && (
        <SectionEditor
          itemList={channels}
          prefix="#"
          onClose={() => setShowSectionEditor(false)}
          // onChange peut être async ; en cas d'échec le composant annule et affiche l'erreur.
          onChange={async (change: ItemChange) => {
            await new Promise((r) => setTimeout(r, 400));
            if (failRequests) throw new Error('Échec simulé (SectionEditor)');
            console.log('SectionEditor', change);
          }}
          labels={{
            title: 'Modifier les canaux',
            subtitle: 'Glisse pour réorganiser · ajoute, modifie ou supprime un canal',
            addButton: 'Ajouter un canal',
            emptyMessage: 'Aucun canal pour le moment.',
            addTitle: 'Nouveau canal',
            editTitle: 'Modifier le canal',
            deleteTitle: 'Supprimer le canal ?',
            deleteBody: (item, prefix) =>
              `Le canal « ${prefix} ${item.name} » et tous ses messages seront définitivement supprimés. Cette action est irréversible.`,
          }}
        />
      )}

      {showRoleEditor && (
        <RoleEditor
          onClose={() => setShowRoleEditor(false)}
          roles={roles}
          users={roleUsers}
          // onChange peut être async ; en cas d'échec le composant annule et affiche l'erreur.
          onChange={async (change: RoleChange) => {
            await new Promise((r) => setTimeout(r, 400));
            if (failRequests) throw new Error('Échec simulé (RoleEditor)');
            console.log('RoleEditor', change);
          }}
        />
      )}

      {showAddCourse && (
        <AddCoursePopup
          onClose={() => setShowAddCourse(false)}
          programs={programs}
          onSave={async (course: NewCourse) => {
            await new Promise((r) => setTimeout(r, 400));
            if (failRequests) throw new Error('Échec simulé (AddCoursePopup)');
            console.log('AddCoursePopup', course);
          }}
        />
      )}

      {showUpdateCourse && (
        <UpdateCoursePopup
          onClose={() => setShowUpdateCourse(false)}
          programs={programs}
          // Cours édité = GIF201, rattaché aux programmes GIN et GLO (ids 1 et 2).
          course={{ title: 'Structures de données', code: 'GIF201', programIds: [1, 2] }}
          // onSave peut être async ; le composant ferme via onClose en cas de succès.
          onSave={async (course: CourseUpdate) => {
            await new Promise((r) => setTimeout(r, 400));
            if (failRequests) throw new Error('Échec simulé (UpdateCoursePopup)');
            console.log('UpdateCoursePopup', course);
          }}
        />
      )}

      {showDeleteConfirmation && (
        <DeleteConfirmationBox
          title="Supprimer le cours ?"
          content="Ce cours et tout son contenu seront définitivement supprimés. Cette action est irréversible."
          onDeleteConfirmation={() => {
            console.log('DeleteConfirmationBox', 'supprimé');
            setShowDeleteConfirmation(false);
          }}
          onClose={() => setShowDeleteConfirmation(false)}
        />
      )}

      {showEditProfile && (
        <EditProfilePopup
          user={{
            username: 'tremblaymar',
            first_name: 'Marie',
            last_name: 'Tremblay',
            avatar_color: '#14B8A6',
            avatar_url:
              'https://media.licdn.com/dms/image/v2/D4E03AQFMLYc-j7m0rw/profile-displayphoto-crop_800_800/B4EZ5wvbMMJMAI-/0/1780007941382?e=1782345600&v=beta&t=V8YeOmxGBZsOZApvF3DlMmHrdo1IoBYNHOJbtdiHS8U',
          }}
          onClose={() => setShowEditProfile(false)}
          // onSave peut être async ; le composant ferme via onClose en cas de succès.
          onSave={async (profile: ProfileUpdate) => {
            await new Promise((r) => setTimeout(r, 400));
            if (failRequests) throw new Error('Échec simulé (EditProfilePopup)');
            console.log('EditProfilePopup', profile);
          }}
        />
      )}

      {showUpdateProgram && (
        <UpdateProgramPopup
          onClose={() => setShowUpdateProgram(false)}
          // Programme édité = GIN ; les autres codes servent à tester l'unicité.
          program={{
            name: programs[0].name,
            code: programs[0].code,
            cohort: programs[0].cohort,
            color: programs[0].color,
          }}
          existingCodes={programs.slice(1).map((p) => p.code)}
          // onSave peut être async ; le composant ferme via onClose en cas de succès.
          onSave={async (program: ProgramUpdate) => {
            await new Promise((r) => setTimeout(r, 400));
            if (failRequests) throw new Error('Échec simulé (UpdateProgramPopup)');
            console.log('UpdateProgramPopup', program);
          }}
        />
      )}

      {showAddSubscription && (
        <AddSubscriptionPopup
          onClose={() => setShowAddSubscription(false)}
          // Au clic « Créer » : établissements + codes de leurs programmes (async, ~400 ms).
          loadCreateEstablishments={async (): Promise<CreateEstablishment[]> => {
            await new Promise((r) => setTimeout(r, 400));
            if (failRequests) throw new Error('Échec simulé (loadCreateEstablishments)');
            return establishments.map((e) => ({
              ...e,
              programCodes: joinPrograms
                .filter((p) => p.establishmentId === e.id)
                .map((p) => p.code),
            }));
          }}
          // Au clic « Rejoindre » : établissements + leur nombre de programmes (async, ~400 ms).
          loadJoinEstablishments={async (): Promise<JoinEstablishment[]> => {
            await new Promise((r) => setTimeout(r, 400));
            if (failRequests) throw new Error('Échec simulé (loadJoinEstablishments)');
            return establishments.map((e) => ({
              ...e,
              programCount: joinPrograms.filter((p) => p.establishmentId === e.id).length,
            }));
          }}
          // Au choix d'un établissement : ses programmes rattachés (async, ~400 ms).
          loadEstablishmentPrograms={async (establishmentId: number): Promise<JoinProgram[]> => {
            await new Promise((r) => setTimeout(r, 400));
            if (failRequests) throw new Error('Échec simulé (loadEstablishmentPrograms)');
            return joinPrograms.filter((p) => p.establishmentId === establishmentId);
          }}
          // onCreate / onJoin peuvent être async ; le composant ferme via onClose en cas de succès.
          onCreate={async (program: NewProgram) => {
            await new Promise((r) => setTimeout(r, 400));
            if (failRequests) throw new Error('Échec simulé (onCreate)');
            console.log('AddSubscriptionPopup', 'créer', program);
          }}
          onJoin={async (selection: JoinSelection) => {
            await new Promise((r) => setTimeout(r, 400));
            if (failRequests) throw new Error('Échec simulé (onJoin)');
            console.log('AddSubscriptionPopup', 'rejoindre', selection);
          }}
        />
      )}

      {showErrorBox && (
        <ErrorBox
          content="Impossible de charger les données. Vérifie ta connexion et réessaie."
          onClose={() => setShowErrorBox(false)}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    boxSizing: 'border-box',
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
    padding: '40px 20px',
    fontFamily: 'Inter, sans-serif',
  },
  title: {
    margin: 0,
    fontSize: '1.5rem',
    fontWeight: 600,
  },
  themeButton: {
    position: 'fixed',
    top: '1rem',
    right: '1rem',
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '2.25rem',
    height: '2.25rem',
    borderRadius: '999px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  bugButton: {
    position: 'fixed',
    top: '1rem',
    left: '1rem',
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '2.25rem',
    padding: '0 0.875rem',
    borderRadius: '999px',
    border: '1px solid',
    fontFamily: 'Inter, sans-serif',
    fontSize: '0.8125rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  bugButtonOff: {
    borderColor: 'rgba(34,197,94,0.45)',
    background: 'rgba(34,197,94,0.10)',
    color: '#16a34a',
  },
  bugButtonOn: {
    borderColor: 'rgba(219,46,46,0.45)',
    background: 'rgba(219,46,46,0.12)',
    color: '#db2e2e',
  },
  subtitle: {
    margin: 0,
    maxWidth: '32rem',
    textAlign: 'center',
    opacity: 0.7,
    fontSize: '0.9rem',
  },
  buttons: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: '0.75rem',
    marginTop: '0.5rem',
  },
  button: {
    padding: '0.625rem 1rem',
    borderRadius: '0.5rem',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
};
