import React from 'react';
import { render } from '@testing-library/react-native';
import Logo from '../components/Logo';

describe('<Logo />', () => {
  it('renders correctly with default props', () => {
    const { getByText } = render(<Logo />);
    // Default name is 'Rocca', so it should show 'R'
    expect(getByText('R')).toBeTruthy();
  });

  it('renders correctly with custom size', () => {
    const { getByText } = render(<Logo size={100} />);
    expect(getByText('R')).toBeTruthy();
  });
});
