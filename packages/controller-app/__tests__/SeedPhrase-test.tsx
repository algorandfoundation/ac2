import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import SeedPhrase from '../components/SeedPhrase';

// Mocking Reanimated because it often has issues in Jest environments
jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return Reanimated;
});

jest.mock('@expo/vector-icons', () => ({
  MaterialIcons: 'MaterialIcons',
}));

describe('<SeedPhrase />', () => {
  const mockPhrase = [
    'apple',
    'banana',
    'cherry',
    'date',
    'elderberry',
    'fig',
    'grape',
    'honeydew',
    'iceberg',
    'jackfruit',
    'kiwi',
    'lemon',
  ];
  const primaryColor = '#3B82F6';

  it('renders all words when showSeed is true', () => {
    const { getByText } = render(
      <SeedPhrase recoveryPhrase={mockPhrase} showSeed={true} primaryColor={primaryColor} />,
    );

    mockPhrase.forEach((word) => {
      expect(getByText(word)).toBeTruthy();
    });
  });

  it('hides words when showSeed is false and no validation is active', () => {
    const { queryByText } = render(
      <SeedPhrase recoveryPhrase={mockPhrase} showSeed={false} primaryColor={primaryColor} />,
    );

    // It should NOT show the words
    mockPhrase.forEach((word) => {
      expect(queryByText(word)).toBeNull();
    });
  });

  it('renders input fields for words specified in validateWords', () => {
    const validateWords = { 0: '', 5: '' };
    const { getByPlaceholderText } = render(
      <SeedPhrase
        recoveryPhrase={mockPhrase}
        showSeed={false}
        validateWords={validateWords}
        primaryColor={primaryColor}
      />,
    );

    expect(getByPlaceholderText('Word #1')).toBeTruthy();
    expect(getByPlaceholderText('Word #6')).toBeTruthy();
  });

  it('calls onInputChange when typing in validation fields', () => {
    const validateWords = { 0: '' };
    const onInputChange = jest.fn();
    const { getByPlaceholderText } = render(
      <SeedPhrase
        recoveryPhrase={mockPhrase}
        showSeed={false}
        validateWords={validateWords}
        onInputChange={onInputChange}
        primaryColor={primaryColor}
      />,
    );

    const input = getByPlaceholderText('Word #1');
    act(() => {
      fireEvent.changeText(input, 'test');
    });

    expect(onInputChange).toHaveBeenCalledWith(0, 'test');
  });
});
