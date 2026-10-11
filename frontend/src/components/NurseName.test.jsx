import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NurseName from './NurseName.jsx';

describe('NurseName', () => {
  beforeEach(() => localStorage.clear());

  it('lets a first and last name be typed with a space (the saved value is trimmed, the box is not)', () => {
    render(<NurseName />);
    const box = screen.getByLabelText(/your name/i);
    fireEvent.change(box, { target: { value: 'Nurse ' } });
    expect(box.value).toBe('Nurse ');
    fireEvent.change(box, { target: { value: 'Nurse Kim' } });
    expect(box.value).toBe('Nurse Kim');
    expect(localStorage.getItem('hb_nurse')).toBe('Nurse Kim');
  });

  it('trims trailing spaces in the stored name once the field loses focus', () => {
    render(<NurseName />);
    const box = screen.getByLabelText(/your name/i);
    fireEvent.change(box, { target: { value: 'Kim   ' } });
    fireEvent.blur(box);
    expect(box.value).toBe('Kim');
    expect(localStorage.getItem('hb_nurse')).toBe('Kim');
  });
});
