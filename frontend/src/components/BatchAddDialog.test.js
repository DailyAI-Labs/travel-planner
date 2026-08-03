import { parsePlaceList } from './BatchAddDialog';

test('strips the bullet shapes people actually paste', () => {
  expect(
    parsePlaceList(`
- Colosseo
* Fontana di Trevi
• Pantheon
– Piazza Navona
1. Musei Vaticani
2) Castel Sant'Angelo
3: Villa Borghese
`)
  ).toEqual([
    'Colosseo',
    'Fontana di Trevi',
    'Pantheon',
    'Piazza Navona',
    'Musei Vaticani',
    "Castel Sant'Angelo",
    'Villa Borghese',
  ]);
});

test('handles parenthesised, hashed and dashed numbering', () => {
  expect(
    parsePlaceList('(1) Colosseo\n1 - Pantheon\n#3 Piazza Navona\n# Villa Borghese')
  ).toEqual(['Colosseo', 'Pantheon', 'Piazza Navona', 'Villa Borghese']);
});

test('strips markers repeatedly when a line carries more than one', () => {
  // Numbering followed by a bullet is common in pasted nested lists.
  expect(parsePlaceList('1) - Colosseo\n2. • Pantheon')).toEqual([
    'Colosseo',
    'Pantheon',
  ]);
});

test('a number joined to the name by a dash is not numbering', () => {
  expect(parsePlaceList('9-11 Memorial')).toEqual(['9-11 Memorial']);
});

test('handles markdown checkboxes', () => {
  expect(parsePlaceList('- [ ] Colosseo\n- [x] Pantheon')).toEqual([
    'Colosseo',
    'Pantheon',
  ]);
});

test('drops blank lines and repeats, ignoring case', () => {
  expect(parsePlaceList('Colosseo\n\n  \nCOLOSSEO\n- colosseo\nPantheon')).toEqual([
    'Colosseo',
    'Pantheon',
  ]);
});

test('keeps commas inside a name when there are several lines', () => {
  expect(parsePlaceList('Piazza San Marco, Venezia\nPonte di Rialto')).toEqual([
    'Piazza San Marco, Venezia',
    'Ponte di Rialto',
  ]);
});

test('splits a single line on commas, since it cannot be a list otherwise', () => {
  expect(parsePlaceList('Colosseo, Pantheon, Fontana di Trevi')).toEqual([
    'Colosseo',
    'Pantheon',
    'Fontana di Trevi',
  ]);
});

test('a plain list without any markers is left alone', () => {
  expect(parsePlaceList('Big Ben\nTower Bridge')).toEqual([
    'Big Ben',
    'Tower Bridge',
  ]);
});

test('empty input yields nothing', () => {
  expect(parsePlaceList('')).toEqual([]);
  expect(parsePlaceList('\n\n  \n')).toEqual([]);
});

test('a number that is part of the name survives', () => {
  // "1." is numbering; "9/11" is not.
  expect(parsePlaceList('- 9/11 Memorial\n- 30 St Mary Axe')).toEqual([
    '9/11 Memorial',
    '30 St Mary Axe',
  ]);
});
