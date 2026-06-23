import { useNavigate } from 'react-router-dom';
import { clearToken } from '../helpers/auth';

export default function Home() {
  const navigate = useNavigate();

  function handleLogout() {
    clearToken(); // supprime le token du localStorage
    navigate('/login');
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1rem',
        background: 'var(--bg-main)',
        color: 'var(--text)',
      }}
    >
      <h1>Connecté ✅</h1>
      <p>Bienvenue sur ton espace MoodIT.</p>
      <button onClick={handleLogout}>Se déconnecter</button>
    </div>
  );
}
