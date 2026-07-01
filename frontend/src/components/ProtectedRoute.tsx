import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useCurrentUser } from '../context/currentUserContext';
import LoadingPage from './LoadingPage/LoadingPage';

// Garde de route. La validation forte du token (GET /api/me → vérification en BD par
// le gateway) est faite UNE fois par CurrentUserProvider ; ici on ne lit que son état.
// On ne refait donc aucun fetch : le même appel sert au garde et au profil (UserMenu).
//
// 'checking' → page de chargement (pas de flash de la page protégée) ;
// 'authed' → enfants ; 'unauthed' (token absent/périmé/révoqué) → /login.
export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status } = useCurrentUser();

  if (status === 'checking') return <LoadingPage />;
  if (status === 'unauthed') return <Navigate to="/login" replace />;
  return <>{children}</>;
}
