// Classe un message d'erreur serveur vers le champ de formulaire concerné, par mots-clés.
// Retourne null si le message est général (à afficher comme erreur globale).
// Mutualisé entre LoginPage et Register pour éviter de dupliquer la logique de mapping.

export type ServerErrorField = 'username' | 'email' | 'password';

export function classifyServerError(message: string): ServerErrorField | null {
  const m = message.toLowerCase();
  if (m.includes('utilisateur')) {
    return 'username';
  }
  if (
    m.includes('e-mail') ||
    m.includes('email') ||
    m.includes('adresse') ||
    m.includes('domaine') ||
    m.includes('courriel') ||
    m.includes('vérifié')
  ) {
    return 'email';
  }
  if (m.includes('mot de passe')) {
    return 'password';
  }
  return null;
}
