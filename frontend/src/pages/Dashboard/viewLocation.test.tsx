import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { NO_VIEW, parseViewPath, useViewLocation, viewPath, type ViewLocation } from './viewLocation';

describe('parseViewPath / viewPath', () => {
  const cases: [string, ViewLocation][] = [
    ['/home', NO_VIEW],
    ['/home/p/3', { programId: 3 }],
    ['/home/p/3/c/12', { programId: 3, courseId: 12 }],
    ['/home/p/3/c/12/quiz/7', { programId: 3, courseId: 12, channel: { type: 'quiz', id: 7 } }],
    ['/home/p/3/c/12/text/8', { programId: 3, courseId: 12, channel: { type: 'text', id: 8 } }],
  ];

  it.each(cases)('%s ↔ vue', (path, view) => {
    expect(parseViewPath(path)).toEqual(view);
    expect(viewPath(view)).toBe(path);
  });

  it('barre oblique finale tolérée', () => {
    expect(parseViewPath('/home/p/3/c/12/')).toEqual({ programId: 3, courseId: 12 });
  });

  it.each(['/', '/login', '/home/p/x', '/home/p/3/c/', '/home/p/3/c/12/quiz', '/home/p/3/ch/4'])(
    '%s : aucune vue',
    (path) => expect(parseViewPath(path)).toEqual(NO_VIEW)
  );

  it('programme absent : /home, quels que soient cours et canal', () => {
    expect(viewPath({ programId: -1, courseId: 4, channel: { type: 'quiz', id: 1 } })).toBe('/home');
  });

  it('canal sans cours : le canal est ignoré', () => {
    expect(viewPath({ programId: 3, channel: { type: 'quiz', id: 1 } })).toBe('/home/p/3');
  });
});

describe('useViewLocation', () => {
  let setView: ReturnType<typeof useViewLocation>[1];

  function Probe() {
    const [view, set] = useViewLocation();
    setView = set;
    const { pathname } = useLocation();
    return (
      <>
        <span data-testid="path">{pathname}</span>
        <span data-testid="program">{view.programId}</span>
        <span data-testid="navigation">{useNavigationType()}</span>
      </>
    );
  }

  function renderAt(path: string) {
    render(
      <MemoryRouter initialEntries={[path]}>
        <Probe />
      </MemoryRouter>
    );
  }

  const path = () => screen.getByTestId('path').textContent;

  it('lit la vue dans l’URL', () => {
    renderAt('/home/p/5/c/9');
    expect(screen.getByTestId('program').textContent).toBe('5');
  });

  it('un choix ajoute une entrée d’historique, un repli la remplace', () => {
    renderAt('/home');
    act(() => setView({ programId: 2, courseId: 4 }));
    expect(path()).toBe('/home/p/2/c/4');
    expect(screen.getByTestId('navigation').textContent).toBe('PUSH');
    act(() => setView({ programId: 2 }, { replace: true }));
    expect(path()).toBe('/home/p/2');
    expect(screen.getByTestId('navigation').textContent).toBe('REPLACE');
  });

  it('vue identique : aucune navigation', () => {
    renderAt('/home/p/2');
    act(() => setView({ programId: 2 }));
    expect(screen.getByTestId('navigation').textContent).toBe('POP'); // entrée initiale intacte
  });

  it('deux mises à jour dans le même tick se composent', () => {
    renderAt('/home/p/2/c/4');
    act(() => {
      setView({ programId: 3, courseId: 6 });
      setView((previous) => ({ ...previous, channel: { type: 'forum', id: 1 } }));
    });
    expect(path()).toBe('/home/p/3/c/6/forum/1');
  });
});
