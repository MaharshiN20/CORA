import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// No real socket / network in tests.
const api = { simulate: vi.fn() };
vi.mock('../api.js', () => ({ api, socket: { on() {}, off() {} } }));

const { default: PhoneSimulator, liveButtonIndex } = await import('./PhoneSimulator.jsx');
const { messageOutcome } = await import('../lib/worklist.js');

const patient = { id: 'p5', name: 'Dorothy Smith', caregiver: { name: 'James Smith' } };
const question = { id: 'm1', direction: 'out', to: 'patient', text: 'How is your breathing today?', buttons: [[{ label: 'Normal', data: 'ci:breath:normal' }]] };

beforeEach(() => api.simulate.mockReset());

describe('liveButtonIndex', () => {
  it('only the latest bot message is tappable', () => {
    expect(liveButtonIndex([{ direction: 'out', to: 'patient' }, question], 'patient')).toBe(1);
  });
  it('a typed answer after the question locks its buttons (no double answers)', () => {
    expect(liveButtonIndex([question, { direction: 'in', from: 'patient', text: 'normal' }], 'patient')).toBe(-1);
  });
  it('messages to the other role do not count', () => {
    expect(liveButtonIndex([question, { direction: 'out', to: 'caregiver', text: 'x' }], 'patient')).toBe(0);
  });
});

describe('PhoneSimulator', () => {
  it('shows a typing indicator while the reply is on its way', async () => {
    let finish;
    api.simulate.mockReturnValue(new Promise((r) => (finish = r)));
    render(<PhoneSimulator patient={patient} messages={[question]} />);
    fireEvent.change(screen.getByPlaceholderText('Message as patient…'), { target: { value: '140' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('status', { name: 'HeartBridge is typing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Normal' })).toBeDisabled(); // no taps while busy
    finish([]);
    await waitFor(() => expect(screen.queryByRole('status', { name: 'HeartBridge is typing' })).not.toBeInTheDocument());
  });

  it('a failed send shows an inline error and gives the text back (no unhandled rejection)', async () => {
    const real = api.simulate;
    let calls = 0;
    api.simulate = async () => {
      calls++;
      throw Object.assign(new Error('POST -> 502'), { status: 502 });
    };
    try {
      render(<PhoneSimulator patient={patient} messages={[]} />);
      const input = screen.getByPlaceholderText('Message as patient…');
      fireEvent.change(input, { target: { value: 'hello' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Not sent: POST -> 502');
      expect(input).toHaveValue('hello');
      expect(calls).toBe(1);
    } finally {
      api.simulate = real;
    }
  });

  it('a quick-reply tap goes through the same path', async () => {
    api.simulate.mockResolvedValue([]);
    render(<PhoneSimulator patient={patient} messages={[question]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Normal' }));
    await waitFor(() => expect(api.simulate).toHaveBeenCalledWith('p5', { buttonData: 'ci:breath:normal', role: 'patient' }));
  });

  it('nurse-group messages are not shown on the patient phone', () => {
    render(<PhoneSimulator patient={patient} messages={[{ id: 'n', direction: 'out', to: 'nurse', text: 'RED follow-up' }, question]} />);
    expect(screen.queryByText('RED follow-up')).not.toBeInTheDocument();
  });
});

describe('messageOutcome', () => {
  it('never claims "Sent ✓" for an undelivered or untranslated message', () => {
    expect(messageOutcome({ delivered: true, translated: null, language: 'en' })).toEqual({ tone: 'ok', text: 'Sent ✓' });
    expect(messageOutcome({ delivered: true, translated: true, language: 'es' }).text).toMatch(/translated to Español/);
    const vi_ = messageOutcome({ delivered: false, translated: false, language: 'vi' });
    expect(vi_.tone).toBe('warn');
    expect(vi_.text).toMatch(/sent in English/);
    expect(vi_.text).toMatch(/not on Telegram/);
  });
});

describe('a burst of bot messages is revealed one at a time', () => {
  const reply = (id, text) => ({ id, direction: 'out', to: 'patient', text });
  it('history shows at once; new messages appear behind the typing dots, in order', async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<PhoneSimulator patient={patient} messages={[question]} />);
      expect(screen.getByText('How is your breathing today?')).toBeInTheDocument();
      expect(screen.queryByRole('status', { name: 'HeartBridge is typing' })).not.toBeInTheDocument();

      rerender(<PhoneSimulator patient={patient} messages={[question, reply('m2', 'Thanks!'), reply('m3', 'Any swelling?')]} />);
      expect(screen.getByRole('status', { name: 'HeartBridge is typing' })).toBeInTheDocument();
      expect(screen.queryByText('Thanks!')).not.toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(screen.getByText('Thanks!')).toBeInTheDocument();
      expect(screen.queryByText('Any swelling?')).not.toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(screen.getByText('Any swelling?')).toBeInTheDocument();
      expect(screen.queryByRole('status', { name: 'HeartBridge is typing' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('switching patient shows that history immediately (no replay)', () => {
    const { rerender } = render(<PhoneSimulator patient={patient} messages={[question]} />);
    rerender(<PhoneSimulator patient={{ ...patient, id: 'p9' }} messages={[reply('x1', 'Hola'), reply('x2', 'Adiós')]} />);
    expect(screen.getByText('Hola')).toBeInTheDocument();
    expect(screen.getByText('Adiós')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'HeartBridge is typing' })).not.toBeInTheDocument();
  });

  it('the 911 message gets its own emergency label', () => {
    render(<PhoneSimulator patient={patient} messages={[reply('e1', '🚨 Please CALL 911 NOW.')]} />);
    expect(screen.getByText('Emergency instruction')).toBeInTheDocument();
  });
});
