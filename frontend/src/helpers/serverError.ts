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

// Message d'erreur GLOBALE (bandeau en haut du formulaire) destiné à l'utilisateur.
// En production, on masque les détails techniques (codes HTTP type « Erreur 403 »,
// messages réseau bruts) derrière un message générique ; en développement on garde
// le message réel pour faciliter le débogage.
export function publicServerError(message: string): string {
  if (import.meta.env.PROD) {
    return 'Une erreur est survenue. Veuillez réessayer plus tard.';
  }
  return message;
}
