import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { I18nProvider } from './i18n';

/** Fake backend: health, per-place geocoding, and plan submission. */
function mockBackend({ unresolvable = [] } = {}) {
  let counter = 0;
  global.fetch = jest.fn((url, options) => {
    const json = (body) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

    if (String(url).endsWith('/api/v1/geocode')) {
      const { place } = JSON.parse(options.body);
      if (unresolvable.includes(place)) {
        return json({ found: false, query: place, error: 'No match found' });
      }
      counter += 1;
      return json({
        found: true,
        query: place,
        place: { name: `${place}, Somewhere`, lat: 51 + counter / 100, lon: -0.1 },
      });
    }

    if (String(url).endsWith('/compute_itinerary')) {
      return json({ code: 'ABC', status: 'pending' });
    }

    return json({ status: 'healthy' });
  });
}

beforeEach(() => {
  window.localStorage.clear();
  mockBackend();
});

const renderApp = () =>
  render(
    <I18nProvider>
      <App />
    </I18nProvider>
  );

const geocodeCalls = () =>
  global.fetch.mock.calls.filter(([url]) => String(url).includes('/geocode'));

async function setCity(city) {
  const input = await screen.findByPlaceholderText('London');
  fireEvent.change(input, { target: { value: city } });
  fireEvent.click(screen.getByRole('button', { name: /^set$/i }));
}

async function addPlaces(names) {
  const input = screen.getByPlaceholderText(/add a place/i);
  for (const name of names) {
    fireEvent.change(input, { target: { value: name } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    // A place only joins the list once the geocoder has answered.
    await waitFor(() =>
      expect(screen.getByText(`${name}, Somewhere`)).toBeInTheDocument()
    );
  }
}

async function fillValidTrip({
  city = 'London',
  places = ['Big Ben', 'Tower Bridge'],
} = {}) {
  await setCity(city);
  await addPlaces(places);
}

/** Submit and return the parsed request body. */
async function submitAndReadBody() {
  fireEvent.click(screen.getByRole('button', { name: /plan my route/i }));
  await waitFor(() => {
    const [url] = global.fetch.mock.calls.at(-1);
    expect(String(url)).toContain('compute_itinerary');
  });
  const [, options] = global.fetch.mock.calls.at(-1);
  return JSON.parse(options.body);
}

const dayCount = () => Number(screen.getByRole('status').textContent);

const setDays = (count) => {
  const more = screen.getByRole('button', { name: /one day more/i });
  const fewer = screen.getByRole('button', { name: /one day fewer/i });
  while (dayCount() < count) fireEvent.click(more);
  while (dayCount() > count) fireEvent.click(fewer);
};

test('renders the planner form', async () => {
  renderApp();
  expect(await screen.findByText(/which city or region/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/add a place/i)).toBeInTheDocument();
});

test('typing a city is not enough — it has to be confirmed', async () => {
  renderApp();
  const placeInput = await screen.findByPlaceholderText(/add a place/i);
  expect(placeInput).toBeDisabled();

  fireEvent.change(screen.getByPlaceholderText('London'), {
    target: { value: 'London' },
  });
  expect(placeInput).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: /^set$/i }));
  expect(placeInput).toBeEnabled();
});

test('a confirmed city is locked until Change is pressed', async () => {
  renderApp();
  await setCity('London');

  const cityInput = screen.getByPlaceholderText('London');
  expect(cityInput).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: /^change$/i }));
  expect(cityInput).toBeEnabled();
  expect(screen.getByRole('button', { name: /^set$/i })).toBeInTheDocument();
});

test('Enter adds a place instead of submitting the plan', async () => {
  renderApp();
  await setCity('London');
  const input = screen.getByPlaceholderText(/add a place/i);

  fireEvent.change(input, { target: { value: 'Tower Bridge' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

  await waitFor(() =>
    expect(screen.getByText('Tower Bridge, Somewhere')).toBeInTheDocument()
  );
  expect(input).toHaveValue('');
  expect(
    global.fetch.mock.calls.some(([u]) => String(u).includes('compute_itinerary'))
  ).toBe(false);
});

test('each place is resolved as it is added, and the match is shown', async () => {
  renderApp();
  await fillValidTrip({ places: ['Colosseo'] });

  expect(screen.getByText('Colosseo, Somewhere')).toBeInTheDocument();
  expect(geocodeCalls()).toHaveLength(1);
});

test('a place that cannot be found is not added to the list', async () => {
  mockBackend({ unresolvable: ['Nowhere At All'] });
  renderApp();
  await fillValidTrip({ places: ['Big Ben'] });

  const input = screen.getByPlaceholderText(/add a place/i);
  fireEvent.change(input, { target: { value: 'Nowhere At All' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

  expect(await screen.findByRole('alert')).toHaveTextContent(/was not found here/i);
  // The rejected name is nowhere in the list, and the draft is kept so the
  // spelling can be corrected.
  expect(screen.queryByText(/Nowhere At All, Somewhere/)).not.toBeInTheDocument();
  expect(input).toHaveValue('Nowhere At All');
});

test('a pasted list adds every place in one go', async () => {
  renderApp();
  await setCity('Roma');

  fireEvent.click(screen.getByRole('button', { name: /paste a whole list/i }));
  fireEvent.change(screen.getByRole('textbox', { name: /paste your list/i }), {
    target: { value: '- Colosseo\n- Pantheon\n3. Piazza Navona' },
  });

  expect(screen.getByText(/3 places ready to add/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /add 3 places/i }));

  // The dialog closes on success and every place lands in the list.
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  );
  expect(screen.getByText('Colosseo, Somewhere')).toBeInTheDocument();
  expect(screen.getByText('Pantheon, Somewhere')).toBeInTheDocument();
  expect(screen.getByText('Piazza Navona, Somewhere')).toBeInTheDocument();
  expect(geocodeCalls()).toHaveLength(3);
});

test('a pasted list skips places already in the list', async () => {
  renderApp();
  await fillValidTrip({ city: 'Roma', places: ['Colosseo'] });

  fireEvent.click(screen.getByRole('button', { name: /paste a whole list/i }));
  fireEvent.change(screen.getByRole('textbox', { name: /paste your list/i }), {
    target: { value: 'Colosseo\nPantheon' },
  });

  expect(screen.getByText(/1 places ready to add/i)).toBeInTheDocument();
  expect(screen.getByText(/1 already in your list/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /add 1 places/i }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  );
  // Colosseo was resolved once when added by hand, and not again.
  expect(geocodeCalls()).toHaveLength(2);
});

test('places from a pasted list that cannot be found stay in the box', async () => {
  mockBackend({ unresolvable: ['Nowhere At All'] });
  renderApp();
  await setCity('Roma');

  fireEvent.click(screen.getByRole('button', { name: /paste a whole list/i }));
  const box = screen.getByRole('textbox', { name: /paste your list/i });
  fireEvent.change(box, {
    target: { value: 'Colosseo\nNowhere At All\nPantheon' },
  });
  fireEvent.click(screen.getByRole('button', { name: /add 3 places/i }));

  // The two good ones are added; the dialog stays open holding only the bad
  // one, so it can be corrected without retyping the rest.
  expect(await screen.findByRole('alert')).toHaveTextContent(/1 could not be found/i);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(box).toHaveValue('Nowhere At All');
  expect(screen.getByText('Colosseo, Somewhere')).toBeInTheDocument();
  expect(screen.getByText('Pantheon, Somewhere')).toBeInTheDocument();
});

test('the batch dialog can be dismissed with Escape', async () => {
  renderApp();
  await setCity('Roma');

  fireEvent.click(screen.getByRole('button', { name: /paste a whole list/i }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('confirming a different city re-resolves every place already added', async () => {
  renderApp();
  await fillValidTrip({ places: ['Duomo', 'Battistero'] });
  expect(geocodeCalls()).toHaveLength(2);

  fireEvent.click(screen.getByRole('button', { name: /^change$/i }));
  fireEvent.change(screen.getByPlaceholderText('London'), {
    target: { value: 'Firenze' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^set$/i }));

  await waitFor(() => {
    const calls = geocodeCalls();
    expect(calls).toHaveLength(4);
    // Both re-checks must carry the new city, not the old one.
    expect(calls.slice(2).map(([, o]) => JSON.parse(o.body).area)).toEqual([
      'Firenze',
      'Firenze',
    ]);
  });
});

test('planning sends the already-resolved coordinates', async () => {
  renderApp();
  await fillValidTrip();

  const body = await submitAndReadBody();
  expect(body.resolved_places).toHaveLength(2);
  expect(body.resolved_places[0]).toMatchObject({
    query: 'Big Ben',
    name: 'Big Ben, Somewhere',
  });
  expect(typeof body.resolved_places[0].lat).toBe('number');
});

test('walking is the default and is sent alone', async () => {
  renderApp();
  await fillValidTrip();

  expect(screen.getByRole('radio', { name: /on foot/i })).toBeChecked();
  expect(await submitAndReadBody()).toMatchObject({
    modes: ['walking'],
    area: 'London',
    days: 1,
  });
});

test('choosing the car sends driving alone', async () => {
  renderApp();
  await fillValidTrip();
  fireEvent.click(screen.getByRole('radio', { name: /by car/i }));

  expect((await submitAndReadBody()).modes).toEqual(['driving']);
});

test('the distance field targets the threshold of the selected mode', async () => {
  renderApp();
  await fillValidTrip();

  fireEvent.change(screen.getByLabelText(/longest stretch you will walk/i), {
    target: { value: '2500' },
  });
  expect(await submitAndReadBody()).toMatchObject({
    max_walking_distance: 2500,
    max_cycling_distance: 5000,
  });
});

test('same start and finish is planned as a round trip', async () => {
  renderApp();
  await fillValidTrip();

  const startSelect = screen.getByLabelText(/^start at$/i);
  const endSelect = screen.getByLabelText(/^finish at$/i);
  fireEvent.change(endSelect, { target: { value: startSelect.options[0].value } });

  expect(screen.getByText(/round trip/i)).toBeInTheDocument();

  const body = await submitAndReadBody();
  expect(body.day_starts).toEqual([0]);
  expect(body.day_ends).toEqual([0]);
});

test('the day stepper adds and removes days, with a floor of one', async () => {
  renderApp();
  await fillValidTrip({ places: ['A', 'B', 'C', 'D'] });

  const more = screen.getByRole('button', { name: /one day more/i });
  const fewer = screen.getByRole('button', { name: /one day fewer/i });

  expect(fewer).toBeDisabled();
  fireEvent.click(more);
  fireEvent.click(more);
  expect(dayCount()).toBe(3);

  fireEvent.click(fewer);
  expect(dayCount()).toBe(2);

  expect((await submitAndReadBody()).days).toBe(2);
});

test('each day gets its own start and finish selectors', async () => {
  renderApp();
  await fillValidTrip({ places: ['A', 'B', 'C', 'D', 'E'] });

  setDays(2);
  expect(screen.getByLabelText(/day 1 — start/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/day 2 — finish/i)).toBeInTheDocument();

  const day2Start = screen.getByLabelText(/day 2 — start/i);
  fireEvent.change(day2Start, { target: { value: day2Start.options[2].value } });

  const body = await submitAndReadBody();
  expect(body.days).toBe(2);
  expect(body.day_starts).toEqual([0, 2]);
});

test('a too-far failure is phrased in the reader’s language', async () => {
  renderApp();
  fireEvent.change(
    await screen.findByRole('combobox', { name: /switch language/i }),
    { target: { value: 'it' } }
  );

  // Drop straight into the failed state the backend would report.
  const failure = {
    status: 'failed',
    error: "'marsala' and 'siracusa' are 260 km apart — too far to cover on foot.",
    error_code: 'too_far_for_mode',
    error_params: { first: 'marsala', second: 'siracusa', km: 260, mode: 'walking' },
  };
  global.fetch = jest.fn((url) => {
    const json = (b) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) });
    if (String(url).includes('/travel_plan/')) return json(failure);
    if (String(url).includes('/compute_itinerary')) return json({ code: 'X', status: 'pending' });
    if (String(url).includes('/geocode')) {
      return json({ found: true, place: { name: 'X, Somewhere', lat: 1, lon: 2 } });
    }
    return json({ status: 'healthy' });
  });

  const cityInput = screen.getByPlaceholderText('Roma');
  fireEvent.change(cityInput, { target: { value: 'Sicilia' } });
  fireEvent.click(screen.getByRole('button', { name: /^conferma$/i }));

  const placeInput = screen.getByPlaceholderText(/aggiungi un luogo/i);
  for (const name of ['marsala', 'siracusa']) {
    fireEvent.change(placeInput, { target: { value: name } });
    fireEvent.keyDown(placeInput, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(placeInput).toHaveValue(''));
  }

  fireEvent.click(screen.getByRole('button', { name: /calcola il percorso/i }));

  const alert = await screen.findByText(/troppo per andarci a piedi/i);
  expect(alert).toHaveTextContent('260 km');
  expect(alert).toHaveTextContent('marsala');
  // The raw engine wording must not leak through.
  expect(alert).not.toHaveTextContent(/max distance limit/i);
});

test('the language selector shows the current language and switches on change', async () => {
  renderApp();
  const select = await screen.findByRole('combobox', { name: /switch language/i });
  expect(select).toHaveValue('en');

  fireEvent.change(select, { target: { value: 'it' } });
  expect(screen.getByText(/in quale città o regione/i)).toBeInTheDocument();
  // Its own label follows the language too, so it reads to the user currently
  // looking at it rather than to the one they are switching away from.
  const italian = screen.getByRole('combobox', { name: /cambia lingua/i });
  expect(italian).toHaveValue('it');

  fireEvent.change(italian, { target: { value: 'en' } });
  expect(screen.getByText(/which city or region/i)).toBeInTheDocument();
});

test('a sleeping backend is waited out rather than declared offline', async () => {
  // The retry gap is seconds long, so the clock is faked rather than waited
  // out; testing-library advances it from inside waitFor.
  jest.useFakeTimers();
  try {
    // What a spun-down free instance looks like: the first requests are
    // refused outright, and one of them is what starts it.
    let refusals = 3;
    global.fetch = jest.fn(() => {
      if (refusals > 0) {
        refusals -= 1;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy' }),
      });
    });

    renderApp();

    expect(await screen.findByText(/waking the backend/i)).toBeInTheDocument();
    expect(screen.queryByText(/backend offline/i)).not.toBeInTheDocument();

    // Generous against the four-second gap, but it is fake time: waitFor
    // winds the clock forward rather than sleeping.
    await waitFor(
      () => expect(screen.getByText(/backend online/i)).toBeInTheDocument(),
      { timeout: 20000 }
    );
  } finally {
    jest.useRealTimers();
  }
});

test('a backend that comes back is noticed without reloading the page', async () => {
  jest.useFakeTimers();
  try {
    let healthy = false;
    global.fetch = jest.fn(() =>
      healthy
        ? Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ status: 'healthy' }),
          })
        : Promise.reject(new TypeError('Failed to fetch'))
    );

    renderApp();

    // Long enough failing that it is no longer a cold start. The coarse
    // interval is what keeps winding two and a half minutes of fake clock
    // forward from costing thousands of DOM queries.
    await waitFor(
      () => expect(screen.getByText(/backend offline/i)).toBeInTheDocument(),
      { timeout: 200000, interval: 1000 }
    );

    // Offline is a report, not a verdict: the asking has to continue.
    healthy = true;
    await waitFor(
      () => expect(screen.getByText(/backend online/i)).toBeInTheDocument(),
      { timeout: 60000 }
    );
  } finally {
    jest.useRealTimers();
  }
});

test('a health check that never answers is abandoned and tried again', async () => {
  jest.useFakeTimers();
  try {
    // The failure mode with no timeout of its own: a connection held open
    // rather than refused. Nothing settles, so nothing schedules the next
    // check, and the badge would sit on "waking" for as long as the page is
    // open. The mock only gives up when the abort signal says so.
    let hang = true;
    global.fetch = jest.fn(
      (url, options) =>
        new Promise((resolve, reject) => {
          if (hang) {
            options?.signal?.addEventListener('abort', () =>
              reject(new Error('aborted'))
            );
            return;
          }
          resolve({ ok: true, json: () => Promise.resolve({ status: 'healthy' }) });
        })
    );

    renderApp();
    hang = false;

    await waitFor(
      () => expect(screen.getByText(/backend online/i)).toBeInTheDocument(),
      { timeout: 60000, interval: 1000 }
    );
  } finally {
    jest.useRealTimers();
  }
});

test('a tab hidden at the wrong moment does not freeze the badge', async () => {
  jest.useFakeTimers();
  const visibility = jest
    .spyOn(document, 'hidden', 'get')
    .mockReturnValue(true);
  try {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy' }),
      })
    );

    renderApp();
    // Hidden: no request is worth making, and none is made.
    expect(global.fetch).not.toHaveBeenCalled();

    // Looked at again, but without the visibility event ever arriving - the
    // loop has to have kept its own tick alive to recover from this.
    visibility.mockReturnValue(false);
    await waitFor(
      () => expect(screen.getByText(/backend online/i)).toBeInTheDocument(),
      { timeout: 120000, interval: 1000 }
    );
  } finally {
    visibility.mockRestore();
    jest.useRealTimers();
  }
});

test('a backend that goes away stops being reported as online', async () => {
  jest.useFakeTimers();
  try {
    let healthy = true;
    global.fetch = jest.fn(() =>
      healthy
        ? Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ status: 'healthy' }),
          })
        : Promise.reject(new TypeError('Failed to fetch'))
    );

    renderApp();
    await waitFor(
      () => expect(screen.getByText(/backend online/i)).toBeInTheDocument(),
      { timeout: 20000 }
    );

    healthy = false;
    await waitFor(
      () => expect(screen.getByText(/waking the backend/i)).toBeInTheDocument(),
      { timeout: 120000, interval: 1000 }
    );
  } finally {
    jest.useRealTimers();
  }
});

test('the chosen language survives a reload', async () => {
  const first = renderApp();
  fireEvent.change(
    await screen.findByRole('combobox', { name: /switch language/i }),
    { target: { value: 'it' } }
  );
  first.unmount();

  renderApp();
  expect(await screen.findByText(/in quale città o regione/i)).toBeInTheDocument();
});
