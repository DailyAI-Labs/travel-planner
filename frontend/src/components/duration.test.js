import { formatDuration, parseDuration } from './duration';

test('parses the shapes people actually type', () => {
  expect(parseDuration('90')).toBe(90);
  expect(parseDuration('90m')).toBe(90);
  expect(parseDuration('90 min')).toBe(90);
  expect(parseDuration('2h')).toBe(120);
  expect(parseDuration('1h30')).toBe(90);
  expect(parseDuration('1h30m')).toBe(90);
  expect(parseDuration('1:30')).toBe(90);
  expect(parseDuration('1.5h')).toBe(90);
  expect(parseDuration("45'")).toBe(45);
});

test('accepts the comma decimal an Italian keyboard produces', () => {
  expect(parseDuration('1,5h')).toBe(90);
});

test('tolerates spacing and case', () => {
  expect(parseDuration('  2 H  ')).toBe(120);
  expect(parseDuration('1 h 30')).toBe(90);
});

test('rejects rather than guesses', () => {
  expect(parseDuration('soon')).toBeNull();
  expect(parseDuration('1h2h')).toBeNull();
  expect(parseDuration('-30')).toBeNull();
  expect(parseDuration('1h75')).toBeNull(); // 75 minutes past the hour
  expect(parseDuration('')).toBeNull();
  expect(parseDuration(null)).toBeNull();
  expect(parseDuration(undefined)).toBeNull();
});

test('formats back into what the box should show', () => {
  expect(formatDuration(0)).toBe('');
  expect(formatDuration(45)).toBe('45m');
  expect(formatDuration(60)).toBe('1h');
  expect(formatDuration(90)).toBe('1h 30m');
  expect(formatDuration(120)).toBe('2h');
});

test('parse and format round-trip', () => {
  for (const minutes of [5, 45, 60, 90, 120, 195]) {
    expect(parseDuration(formatDuration(minutes))).toBe(minutes);
  }
});
