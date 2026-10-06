import { parsePlaceList } from './BatchAddDialog';

const names = (text) => parsePlaceList(text).map((entry) => entry.name);
const details = (text) => parsePlaceList(text).map((entry) => entry.details);

test('strips the bullet shapes people actually paste', () => {
  expect(
    names(`
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
    names('(1) Colosseo\n1 - Pantheon\n#3 Piazza Navona\n# Villa Borghese')
  ).toEqual(['Colosseo', 'Pantheon', 'Piazza Navona', 'Villa Borghese']);
});

test('strips markers repeatedly when a line carries more than one', () => {
  // Numbering followed by a bullet is common in pasted nested lists.
  expect(names('1) - Colosseo\n2. • Pantheon')).toEqual([
    'Colosseo',
    'Pantheon',
  ]);
});

test('a number joined to the name by a dash is not numbering', () => {
  expect(names('9-11 Memorial')).toEqual(['9-11 Memorial']);
});

test('handles markdown checkboxes', () => {
  expect(names('- [ ] Colosseo\n- [x] Pantheon')).toEqual([
    'Colosseo',
    'Pantheon',
  ]);
});

test('drops blank lines and repeats, ignoring case', () => {
  expect(names('Colosseo\n\n  \nCOLOSSEO\n- colosseo\nPantheon')).toEqual([
    'Colosseo',
    'Pantheon',
  ]);
});

test('keeps commas inside a name when there are several lines', () => {
  expect(names('Piazza San Marco, Venezia\nPonte di Rialto')).toEqual([
    'Piazza San Marco, Venezia',
    'Ponte di Rialto',
  ]);
});

test('splits a single line on commas, since it cannot be a list otherwise', () => {
  expect(names('Colosseo, Pantheon, Fontana di Trevi')).toEqual([
    'Colosseo',
    'Pantheon',
    'Fontana di Trevi',
  ]);
});

test('a plain list without any markers is left alone', () => {
  expect(names('Big Ben\nTower Bridge')).toEqual([
    'Big Ben',
    'Tower Bridge',
  ]);
});

test('empty input yields nothing', () => {
  expect(names('')).toEqual([]);
  expect(names('\n\n  \n')).toEqual([]);
});

test('a number that is part of the name survives', () => {
  // "1." is numbering; "9/11" is not.
  expect(names('- 9/11 Memorial\n- 30 St Mary Axe')).toEqual([
    '9/11 Memorial',
    '30 St Mary Axe',
  ]);
});

test('a stay and opening hours after pipes are read, in either order', () => {
  expect(
    parsePlaceList(
      '- Colosseo | 1h30 | 9:00-19:00\nPantheon | 9-19\nTrevi | 15m\nMusei | 8.30 – 18 | 2h'
    )
  ).toEqual([
    {
      name: 'Colosseo',
      raw: '- Colosseo | 1h30 | 9:00-19:00',
      details: { visitMinutes: 90, opens: '09:00', closes: '19:00' },
    },
    { name: 'Pantheon', raw: 'Pantheon | 9-19', details: { opens: '09:00', closes: '19:00' } },
    { name: 'Trevi', raw: 'Trevi | 15m', details: { visitMinutes: 15 } },
    {
      name: 'Musei',
      raw: 'Musei | 8.30 – 18 | 2h',
      details: { opens: '08:30', closes: '18:00', visitMinutes: 120 },
    },
  ]);
});

test('opening hours may give only one end, and 24 means end of day', () => {
  expect(details('A | 10:00-\nB | -18:30\nC | 18-24')).toEqual([
    { opens: '10:00', closes: '' },
    { opens: '', closes: '18:30' },
    { opens: '18:00', closes: '23:59' },
  ]);
});

test('a place with no details gets none', () => {
  expect(details('Colosseo\nPantheon |')).toEqual([{}, {}]);
});

test('unreadable or impossible details mark the line instead of being guessed', () => {
  expect(
    details('A | soon\nB | 19-9\nC | 25-26\nD | 1h | 2h\nE | 9-12 | 14-18')
  ).toEqual([
    { error: true },
    { error: true },
    { error: true },
    { error: true },
    { error: true },
  ]);
});
