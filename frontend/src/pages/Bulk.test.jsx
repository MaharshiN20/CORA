// K14: bulk alert actions. Selection on the worklist and the PATCH /api/alerts request bodies.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = {
  alerts: vi.fn(),
  patients: vi.fn(),
  updateAlert: vi.fn(),
  updateAlerts: vi.fn(),
  health: vi.fn().mockResolvedValue({ ok: true }),
};
vi.mock('../api.js', () => ({ api, socket: { on() {}, off() {} } }));

const { default: Worklist } = await import('./Worklist.jsx');
const { bulkable, bulkBodies, bulkOutcome, BULK_MAX } = await import('../lib/worklist.js');

const NOW = Date.now();
const iso = (min) => new Date(NOW + min * 60000).toISOString();
const mk = (id, patientId, tier, dueMin, extra = {}) => ({ id, patientId, tier, kind: 'triage', status: 'open', ts: iso(-20), dueBy: iso(dueMin), title: `Title ${id}`, reasons: [`Reason ${id}`], assignee: null, ...extra });
const maria = { id: 'p1', name: 'Maria Garcia', language: 'es', riskScore: 8, riskTier: 'High', weights: [], signals: {} };
const robert = { id: 'p2', name: 'Robert Johnson', language: 'en', riskScore: 3, riskTier: 'Low', weights: [], signals: {} };

// a1 RED · a4 YELLOW open · a2 YELLOW acknowledged by Ana · a3 INFO refill open
const ALERTS = [mk('a1', 'p1', 'RED', -5), mk('a2', 'p2', 'YELLOW', 120, { assignee: 'Ana', status: 'acknowledged' }), mk('a3', 'p2', 'INFO', 900, { kind: 'refill', title: 'Furosemide not picked up' }), mk('a4', 'p1', 'YELLOW', 60)];

const okFor = (body) => ({ results: body.ids.map((id) => ({ id, ok: true })), updated: body.ids.length, failed: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.health.mockResolvedValue({ ok: true });
  api.patients.mockResolvedValue([maria, robert]);
  api.alerts.mockResolvedValue(ALERTS);
  api.updateAlerts.mockImplementation(async (body) => okFor(body));
});

async function renderWorklist() {
  render(
    <MemoryRouter>
      <Worklist />
    </MemoryRouter>,
  );
  await screen.findByText('Title a1');
}
const box = (name) => screen.getByRole('checkbox', { name });
const pick = (name) => fireEvent.click(box(name));
const bar = () => screen.getByRole('group', { name: 'Bulk actions' });
const sent = () => api.updateAlerts.mock.calls.map(([body]) => ({ ...body, ids: [...body.ids].sort() }));

describe('bulk helpers', () => {
  it('bulkable: open YELLOW and INFO only, never RED, never resolved', () => {
    expect(bulkable(mk('x', 'p1', 'YELLOW', 5))).toBe(true);
    expect(bulkable(mk('x', 'p1', 'INFO', 5))).toBe(true);
    expect(bulkable(mk('x', 'p1', 'RED', 5))).toBe(false);
    expect(bulkable(mk('x', 'p1', 'YELLOW', 5, { status: 'resolved' }))).toBe(false);
    expect(bulkable(mk('x', 'p1', 'YELLOW', 5, { status: 'contacted' }))).toBe(true);
  });

  it('acknowledge without a name: the open ones, by "nurse", nobody assigned', () => {
    expect(bulkBodies(ALERTS, 'acknowledge')).toEqual([{ ids: ['a3', 'a4'], status: 'acknowledged', by: 'nurse' }]);
  });

  it('acknowledge with a name: takes unowned alerts, never takes over an owned one', () => {
    const mixed = [...ALERTS, mk('a5', 'p2', 'YELLOW', 30, { assignee: 'Ben' })];
    expect(bulkBodies(mixed, 'acknowledge', 'Ana')).toEqual([
      { ids: ['a3', 'a4'], status: 'acknowledged', assignee: 'Ana', by: 'Ana' },
      { ids: ['a5'], status: 'acknowledged', by: 'Ana' },
    ]);
  });

  it('acknowledge skips RED, resolved and already acknowledged alerts entirely', () => {
    const ids = bulkBodies([mk('r', 'p1', 'RED', 1), mk('done', 'p1', 'YELLOW', 1, { status: 'resolved' }), mk('ack', 'p1', 'YELLOW', 1, { status: 'acknowledged' })], 'acknowledge', 'Ana');
    expect(ids).toEqual([]);
  });

  it('assign: everything selected that is not already mine; needs a name', () => {
    expect(bulkBodies(ALERTS, 'assign', 'Ana')).toEqual([{ ids: ['a3', 'a4'], assignee: 'Ana', by: 'Ana' }]);
    expect(bulkBodies(ALERTS, 'assign', 'Ben')).toEqual([{ ids: ['a2', 'a3', 'a4'], assignee: 'Ben', by: 'Ben' }]);
    expect(() => bulkBodies(ALERTS, 'assign', '')).toThrow(/Set your name/);
  });

  it('more than 50 alerts are split into requests of at most 50', () => {
    const many = Array.from({ length: 120 }, (_, i) => mk(`m${i}`, 'p1', 'INFO', 600));
    const bodies = bulkBodies(many, 'acknowledge');
    expect(bodies.map((b) => b.ids.length)).toEqual([BULK_MAX, BULK_MAX, 20]);
    expect(new Set(bodies.flatMap((b) => b.ids)).size).toBe(120);
  });

  it('bulkOutcome reports what the API says, per alert', () => {
    expect(bulkOutcome([{ results: [{ id: 'a', ok: true }, { id: 'b', ok: true }] }])).toEqual({ tone: 'ok', text: '2 updated', failedIds: [] });
    expect(bulkOutcome([{ results: [{ id: 'a', ok: true, unchanged: true }] }])).toEqual({ tone: 'ok', text: 'Nothing needed changing', failedIds: [] });
    expect(bulkOutcome([])).toEqual({ tone: 'ok', text: 'Nothing needed changing', failedIds: [] });
    const partial = bulkOutcome([
      { results: [{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'already resolved' }] },
      { results: [{ id: 'c', ok: false, error: 'already resolved' }, { id: 'd', ok: false, error: 'not found' }] },
    ]);
    expect(partial).toEqual({ tone: 'warn', text: '1 updated · 3 not changed (already resolved; not found)', failedIds: ['b', 'c', 'd'] });
  });
});

describe('Worklist bulk selection', () => {
  it('YELLOW and INFO cards have a checkbox; the RED card does not', async () => {
    await renderWorklist();
    expect(box('Select the YELLOW alert for Maria Garcia')).not.toBeChecked();
    expect(box('Select the INFO alert for Robert Johnson')).toBeInTheDocument();
    expect(box('Select the YELLOW alert for Robert Johnson')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /RED alert/ })).not.toBeInTheDocument();
    const red = screen.getByRole('article', { name: 'RED alert for Maria Garcia' });
    expect(within(red).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(bar()).toHaveTextContent('RED alerts are handled one at a time');
  });

  it('nothing selected: no action buttons; selecting shows the count and the actions', async () => {
    await renderWorklist();
    expect(bar()).toHaveTextContent('Select routine alerts (3)');
    expect(screen.queryByRole('button', { name: 'Acknowledge selected' })).not.toBeInTheDocument();
    pick('Select the YELLOW alert for Maria Garcia');
    pick('Select the INFO alert for Robert Johnson');
    expect(bar()).toHaveTextContent('2 selected');
    expect(screen.getByRole('button', { name: 'Acknowledge selected' })).toBeEnabled();
    pick('Select the INFO alert for Robert Johnson');
    expect(bar()).toHaveTextContent('1 selected');
  });

  it('"Acknowledge selected" sends one PATCH with the selected ids, then clears the selection', async () => {
    await renderWorklist();
    pick('Select the YELLOW alert for Maria Garcia');
    pick('Select the INFO alert for Robert Johnson');
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge selected' }));
    await waitFor(() => expect(api.updateAlerts).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ ids: ['a3', 'a4'], status: 'acknowledged', by: 'nurse' }]);
    expect(await screen.findByRole('status')).toHaveTextContent('2 updated');
    expect(bar()).toHaveTextContent('Select routine alerts (3)');
    expect(box('Select the YELLOW alert for Maria Garcia')).not.toBeChecked();
    expect(api.alerts.mock.calls.length).toBeGreaterThan(1); // the list is reloaded
    expect(api.updateAlert).not.toHaveBeenCalled();
  });

  it('a signed-in nurse takes the unowned alerts she acknowledges', async () => {
    localStorage.setItem('hb_nurse', 'Ana');
    await renderWorklist();
    pick('Select all 3 routine alerts shown');
    expect(bar()).toHaveTextContent('3 selected');
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge selected' }));
    await waitFor(() => expect(api.updateAlerts).toHaveBeenCalled());
    // a2 is already acknowledged (and Ana's): it is not sent at all
    expect(sent()).toEqual([{ ids: ['a3', 'a4'], status: 'acknowledged', assignee: 'Ana', by: 'Ana' }]);
  });

  it('"Assign selected to me" is disabled until the nurse has set a name', async () => {
    await renderWorklist();
    pick('Select all 3 routine alerts shown');
    expect(screen.getByRole('button', { name: 'Assign selected to me' })).toBeDisabled();
  });

  it('"Assign selected to me" as Ben reassigns everything selected, including Ana\'s alert', async () => {
    localStorage.setItem('hb_nurse', 'Ben');
    await renderWorklist();
    pick('Select all 3 routine alerts shown');
    fireEvent.click(screen.getByRole('button', { name: 'Assign selected to me' }));
    await waitFor(() => expect(api.updateAlerts).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ ids: ['a2', 'a3', 'a4'], assignee: 'Ben', by: 'Ben' }]);
    expect(sent()[0]).not.toHaveProperty('status');
  });

  it('select all picks every routine alert shown and never the RED; unticking it clears', async () => {
    await renderWorklist();
    pick('Select all 3 routine alerts shown');
    for (const name of ['Select the YELLOW alert for Maria Garcia', 'Select the INFO alert for Robert Johnson', 'Select the YELLOW alert for Robert Johnson']) expect(box(name)).toBeChecked();
    expect(box('Select all 3 routine alerts shown')).toBeChecked();
    pick('Select all 3 routine alerts shown');
    expect(bar()).toHaveTextContent('Select routine alerts (3)');
  });

  it('only what is selected AND on screen is acted on: a filter cannot hide an alert that gets changed', async () => {
    await renderWorklist();
    pick('Select all 3 routine alerts shown');
    fireEvent.change(screen.getByLabelText('Filter by tier'), { target: { value: 'INFO' } });
    expect(bar()).toHaveTextContent('1 selected');
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge selected' }));
    await waitFor(() => expect(api.updateAlerts).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ ids: ['a3'], status: 'acknowledged', by: 'nurse' }]);
  });

  it('a partial failure is reported and the alerts that failed stay selected', async () => {
    api.updateAlerts.mockResolvedValue({ results: [{ id: 'a4', ok: true }, { id: 'a3', ok: false, error: 'already resolved' }], updated: 1, failed: 1 });
    await renderWorklist();
    pick('Select the YELLOW alert for Maria Garcia');
    pick('Select the INFO alert for Robert Johnson');
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge selected' }));
    expect(await screen.findByRole('status')).toHaveTextContent('1 updated · 1 not changed (already resolved)');
    expect(box('Select the INFO alert for Robert Johnson')).toBeChecked();
    expect(box('Select the YELLOW alert for Maria Garcia')).not.toBeChecked();
  });

  it('a failed request shows the error and keeps the selection', async () => {
    api.updateAlerts.mockRejectedValue(new Error('PATCH /alerts -> 500'));
    await renderWorklist();
    pick('Select the YELLOW alert for Maria Garcia');
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge selected' }));
    expect(await screen.findByRole('status')).toHaveTextContent('PATCH /alerts -> 500');
    expect(box('Select the YELLOW alert for Maria Garcia')).toBeChecked();
  });

  it('with only already-acknowledged alerts selected there is nothing to acknowledge', async () => {
    await renderWorklist();
    pick('Select the YELLOW alert for Robert Johnson'); // a2: acknowledged by Ana
    expect(screen.getByRole('button', { name: 'Acknowledge selected' })).toBeDisabled();
  });

  it('a worklist with only RED alerts has no bulk bar at all', async () => {
    api.alerts.mockResolvedValue([mk('a1', 'p1', 'RED', -5)]);
    await renderWorklist();
    expect(screen.queryByRole('group', { name: 'Bulk actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
