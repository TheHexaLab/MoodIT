import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { hasActiveSession } from '../helpers/api';
import LoadingPage from './LoadingPage/LoadingPage';

// Garde des pages d'authentification (/login, /register, /verify-code), symétrique de
// ProtectedRoute (#63). Un utilisateur déjà connecté qui y revient (bouton « back » après la
// connexion, lien enregistré) est renvoyé vers /home, en REMPLAÇANT l'entrée d'historique : il ne
// voit jamais un écran de connexion qui donnerait l'impression d'une déconnexion.
//
// 'checking' → page de chargement (pas de flash du formulaire) ; session active → /home ;
// sinon (aucune session, ou serveur injoignable) → la page demandée.
export default function GuestRoute({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'authed' | 'guest'>('checking');

  useEffect(() => {
    let cancelled = false;
    void hasActiveSession().then((active) => {
      if (!cancelled) setStatus(active ? 'authed' : 'guest');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'checking') return <LoadingPage />;
  if (status === 'authed') return <Navigate to="/home" replace />;
  return <>{children}</>;
}
