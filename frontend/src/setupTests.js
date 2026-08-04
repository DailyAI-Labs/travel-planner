// jest-dom adds DOM matchers, e.g. expect(element).toHaveTextContent(/react/i).
// https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from 'util';

// The jsdom react-scripts ships with predates TextEncoder being part of the
// environment, and jsPDF's PNG decoder reaches for it on import. Browsers have
// had both for years, so this fills the gap under test only.
if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;
}
