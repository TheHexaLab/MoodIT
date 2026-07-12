import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import '../LoginPage.css';
import { Lightanddark } from '../../assets/light-dark-btn';
import logo from '../../assets/Logo.png';
import { forgotPassword } from '../../helpers/api';
import { useTheme } from '../../helpers/theme';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Étape 1 du « mot de passe oublié » : saisie de l'email. Le backend renvoie toujours une
// réponse générique (anti-énumération), donc un succès mène systématiquement à l'étape de
// saisie du code (/reset-password), que l'email existe ou non.
export default function ForgotPassword() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setFieldError('');

    if (!email) {
      setFieldError('L’adresse e-mail est requise');
      return;
    }
    if (!EMAIL_REGEX.test(email)) {
      setFieldError('Format d’e-mail invalide');
      return;
    }

    setSubmitting(true);
    try {
      await forgotPassword(email);
      navigate('/reset-password', { state: { email } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de connexion au serveur');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <aside className="aside">
        <div className="bubble-1" />
        <div className="bubble-2" />
        <div className="bubble-3" />
        <div className="aside-content">
          <div className="logo-wrapper">
            <img src={logo} alt="Logo MoodIT" />
          </div>
          <h1 className="app-name">MoodIT</h1>
          <p className="app-tagline">
            <span className={'app-tagline-text'}>Parce que Moodle,&nbsp;</span>
            <span className={'app-tagline-text'}>c'était pas assez chaotique.</span>
          </p>
        </div>
      </aside>

      <main className="main">
        <div className="form-card">
          <h2 className="form-title">
            Mot de passe oublié <span className="titleIcon">🔑</span>
          </h2>
          <p className="form-subtitle">
            Entrez votre adresse e-mail : nous vous enverrons un code de réinitialisation.
          </p>

          <form className="form" onSubmit={handleSubmit}>
            {error && <p className="server-error">⚠ {error}</p>}
            <div className="field">
              <div className="label-row">
                <label className="label">Adresse e-mail</label>
                {fieldError && <span className="field-error">⚠ {fieldError}</span>}
              </div>
              <input
                className={`input${fieldError ? ' invalid' : ''}`}
                type="email"
                autoComplete="email"
                placeholder="exemple@usherbrooke.ca"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Envoi...' : 'Envoyer le code →'}
            </button>
            <p className="or-divider">ou</p>
            <p className="register-row">
              <Link to="/login" className="register-link">
                ← Retour à la connexion
              </Link>
            </p>
          </form>
        </div>

        <footer className="footer">© 2026 MoodIT · Confidentialité · Conditions d'utilisation</footer>
      </main>
      <button type="button" className="light-dark-btn" onClick={toggleTheme}>
        <Lightanddark isDark={theme === 'dark'} />
      </button>
    </div>
  );
}
