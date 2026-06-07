import { useState } from 'react';
import * as React from 'react';
import { useTheme } from '../helpers/theme.ts';

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
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '3rem',
    marginTop: '4rem',
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
