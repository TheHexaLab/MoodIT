import { useState } from 'react';
import * as React from 'react';
import { SectionEditor, type ItemChange } from '../components/SectionEditor/SectionEditor.tsx';
import { RoleEditor, type Role, type RoleChange, type User } from '../components/RoleEditor/RoleEditor.tsx';
import { useTheme } from '../helpers/theme.ts';

/**
 * Mock — rôles fournis au RoleEditor (ids alignés sur init.sql).
 * L'ordre du tableau = ordre d'affichage des sections.
 */
const roles: Role[] = [
  { id: 4, name: 'Administrateur' },
  { id: 2, name: 'Enseignant' },
  { id: 3, name: 'Mainteneur' }
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

interface Service {
  label: string;
  url: string;
  description: string;
}

interface Result {
  ok: boolean;
  message: string;
}

const services: Service[] = [
  {
    label: 'Gateway',
    url: '/gateway/test',
    description: 'Teste la connexion au Gateway',
  },
  {
    label: 'Auth Service',
    url: '/auth/test',
    description: "Teste la connexion au service d'authentification",
  },
  {
    label: 'Core Service + BD',
    url: '/api/test',
    description: 'Teste la connexion au service central et à PostgreSQL',
  },
];

export default function ServiceStatus() {
  const [results, setResults] = useState<Record<string, Result | null>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [showSectionEditor, setShowSectionEditor] = useState(false);
  const [showRoleEditor, setShowRoleEditor] = useState(false)
  const { toggleTheme } = useTheme()

  const testService = async (service: Service) => {
    setLoading((prev) => ({ ...prev, [service.label]: true }));
    setResults((prev) => ({ ...prev, [service.label]: null }));

    try {
      const res = await fetch(service.url);

      let message: string;
      if (!res.ok) {
        message = 'Erreur: impossible de joindre le service';
      } else {
        message = await res.text();
      }

      setResults((prev) => ({
        ...prev,
        [service.label]: { ok: res.ok, message },
      }));
    } catch {
      setResults((prev) => ({
        ...prev,
        [service.label]: {
          ok: false,
          message: 'Erreur: impossible de joindre le service',
        },
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [service.label]: false }));
    }
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>MoodIT — Statut des services</h1>
      <div style={styles.grid}>
        {services.map((service) => {
          const result = results[service.label];
          const isLoading = loading[service.label];

          return (
            <div key={service.label} style={styles.card}>
              <h2 style={styles.cardTitle}>{service.label}</h2>
              <p style={styles.description}>{service.description}</p>
              <button
                onClick={() => testService(service)}
                disabled={isLoading}
                style={{
                  ...styles.button,
                  opacity: isLoading ? 0.6 : 1,
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                }}
              >
                {isLoading ? 'Test en cours...' : 'Tester'}
              </button>
              {result && (
                <div
                  style={{
                    ...styles.result,
                    backgroundColor: result.ok ? '#d4edda' : '#f8d7da',
                    borderColor: result.ok ? '#28a745' : '#dc3545',
                    color: result.ok ? '#155724' : '#721c24',
                  }}
                >
                  <span style={styles.indicator}>{result.ok ? '✅' : '❌'}</span>
                  <span>{result.message}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {(!showSectionEditor || !showRoleEditor) && (
        <div style={styles.buttonContainer}>
          <button style={styles.openEditorButton} onClick={toggleTheme}>
            Changer Thème
          </button>
          {!showSectionEditor && (
            <button style={styles.openEditorButton} onClick={() => setShowSectionEditor(true)}>
              Gérer les canaux
            </button>
          )}
          {!showRoleEditor && (
            <button style={styles.openEditorButton} onClick={() => setShowRoleEditor(true)}>
              Gérer les rôles
            </button>
          )}
        </div>
      )}
      {showSectionEditor && (
        <SectionEditor
          itemList={[]}
          prefix="#"
          onClose={() => setShowSectionEditor(false)}
          onChange={(change: ItemChange) => {
            console.log(change);
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
          onChange={(change: RoleChange) => {
            console.log(change);
          }}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    boxSizing: 'border-box',
    minHeight: '100vh',
    backgroundColor: '#f5f5f5',
    padding: '40px 20px',
    fontFamily: 'sans-serif',
  },
  buttonContainer: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: "3rem",
    marginTop: "4rem"
  },
  title: {
    textAlign: 'center',
    fontSize: '24px',
    marginBottom: '40px',
    color: '#333',
  },
  grid: {
    display: 'flex',
    gap: '24px',
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  card: {
    backgroundColor: 'white',
    borderRadius: '12px',
    padding: '24px',
    width: '280px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  cardTitle: {
    fontSize: '18px',
    fontWeight: 'bold',
    color: '#333',
    margin: 0,
  },
  description: {
    fontSize: '14px',
    color: '#666',
    margin: 0,
  },
  button: {
    backgroundColor: '#4f46e5',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    padding: '10px 16px',
    fontSize: '14px',
    fontWeight: 'bold',
  },
  result: {
    borderRadius: '8px',
    padding: '10px 12px',
    fontSize: '13px',
    border: '1px solid',
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-start',
    wordBreak: 'break-word',
    whiteSpace: 'pre-line',
  },
  indicator: {
    flexShrink: 0,
  },
  openEditorButton: {
    display: 'block',
    backgroundColor: '#0d9488',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    padding: '10px 16px',
    fontSize: '14px',
    fontWeight: 'bold',
    cursor: 'pointer',
  },
};
