import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import NoActiveChannelState from './NoActiveChannelState';
import { defaultLabels } from './labels';

afterEach(cleanup);

describe('NoActiveChannelState', () => {
  it('affiche le titre et le sous-titre par défaut', () => {
    render(<NoActiveChannelState />);
    expect(screen.getByRole('heading', { name: defaultLabels.title })).toBeTruthy();
    expect(screen.getByText(defaultLabels.subtitle)).toBeTruthy();
  });

  it('les libellés fournis remplacent les défauts', () => {
    render(<NoActiveChannelState labels={{ subtitle: 'Choisis quelque chose' }} />);
    expect(screen.getByText('Choisis quelque chose')).toBeTruthy();
    expect(screen.queryByText(defaultLabels.subtitle)).toBeNull();
    expect(screen.getByRole('heading', { name: defaultLabels.title })).toBeTruthy();
  });
});
