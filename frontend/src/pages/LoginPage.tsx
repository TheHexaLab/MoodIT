//création de la page de login
//date: 7 juin 2026
//Philip Pigeon

import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import './LoginPage.css';
import { EyeIcon } from '../assets/eye.tsx';
import { Lightanddark } from '../assets/light-dark-btn.tsx';
import { login } from '../helpers/api';
import { useTheme } from '../helpers/theme';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FieldErrors = { email?: string; password?: string };

export default function LoginPage() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  // Associe un message d'erreur serveur au bon champ (par mots-clés).
  function mapServerError(message: string) {
    const m = message.toLowerCase();
    if (m.includes('e-mail') || m.includes('email') || m.includes('adresse') || m.includes('vérifié')) {
      setFieldErrors({ email: message });
    } else if (m.includes('mot de passe')) {
      setFieldErrors({ password: message });
    } else {
      setError(message);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setFieldErrors({});

    const errors: FieldErrors = {};
    if (!email) errors.email = 'L’adresse e-mail est requise';
    else if (!EMAIL_REGEX.test(email)) errors.email = 'Format d’e-mail invalide';
    if (!password) errors.password = 'Le mot de passe est requis';

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      await login({ email, password });
      navigate('/verify-code', { state: { email, mode: '2fa' } });
    } catch (err) {
      mapServerError(err instanceof Error ? err.message : 'Erreur inconnue');
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
            <img src="../../images/Logo.png" alt="Logo" />
          </div>
          <h1 className="app-name">MoodIT</h1>
          <p className="app-tagline">
            Parce que Moodle,
            <br />
            c'est pas assez chaotique.
          </p>
        </div>
      </aside>

      <main className="main">
        <button type="button" className="light-dark-btn" onClick={toggleTheme}>
          <Lightanddark isDark={isDark} />
        </button>
        <div className="form-card">
          <h2 className="form-title">Bon retour 👋</h2>
          <p className="form-subtitle">Connectez-vous à votre espace MoodIT</p>

          <form className="form" onSubmit={handleSubmit}>
            {error && <p className="server-error">⚠ {error}</p>}
            <div className="field">
              <div className="label-row">
                <label className="label">Adresse e-mail</label>
                {fieldErrors.email && <span className="field-error">⚠ {fieldErrors.email}</span>}
              </div>
              <input
                className={`input${fieldErrors.email ? ' invalid' : ''}`}
                type="email"
                placeholder="exemple@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="field">
              <div className="label-row">
                <label className="label">Mot de passe</label>
                {fieldErrors.password && (
                  <span className="field-error">⚠ {fieldErrors.password}</span>
                )}
              </div>
              <div className="input-wrapper">
                <input
                  className={`input${fieldErrors.password ? ' invalid' : ''}`}
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="eye-btn"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  <EyeIcon visible={showPassword} />
                </button>
              </div>
              <a
                href="https://www.youtube.com/watch?v=Aq5WXmQQooo"
                target="_blank"
                rel="noopener noreferrer"
                className="forgot-link"
              >
                Mot de passe oublié ?
              </a>
            </div>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Connexion...' : 'Se connecter →'}
            </button>
            <p className="or-divider">ou</p>
            <p className="register-row">
              Pas encore de compte ?{' '}
              <Link to="/register" className="register-link">
                Créer un compte
              </Link>
            </p>
          </form>
        </div>

        <footer className="footer">
          © 2026 MoodIT · <a href="#">Confidentialité</a> · <a href="#">Conditions d'utilisation</a>
        </footer>
      </main>
    </div>
  );
}
