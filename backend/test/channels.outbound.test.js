// channels/index.js outbound routing: store logging + delivery. Fully offline.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTBRIDGE_DB = path.join(os.tmpdir(), `heartbridge-channels-out-${process.pid}.json`);
process.env.LLM_PROVIDER = 'none';
delete process.env.TELEGRAM_BOT_TOKEN;

let store, telegram, channels, h;

before(async () => {
  store = await import('../src/store.js');
  telegram = await import('../src/channels/telegram.js');
  channels = await import('../src/channels/index.js');
  h = await import('./channels.harness.js');
});
beforeEach(() => store.reset());
afterEach(() => telegram.useBot(null));

const PROXY = [[{ label: 'Answer for Maria', data: 'cmd:proxy' }]];

test('sendToCaregiver logs text, textEn and buttons so the dashboard can show the proxy button', async () => {
  const ok = await channels.sendToCaregiver(store.getPatient('p1'), { text: 'Hola', textEn: 'Hello', buttons: PROXY });
  assert.equal(ok, false, 'caregiver not linked: logged but not delivered');
  const m = store.listMessages('p1').at(-1);
  assert.equal(m.to, 'caregiver');
  assert.equal(m.textEn, 'Hello');
  assert.deepEqual(m.buttons, PROXY);
});

test('sendToCaregiver delivers buttons to a linked caregiver chat', async () => {
  const { bot, calls } = h.makeBot();
  telegram.useBot(bot);
  const cg = store.getPatient('p1').caregiver;
  store.updatePatient('p1', { caregiver: { ...cg, chatId: 5151 } });
  assert.equal(await channels.sendToCaregiver(store.getPatient('p1'), { text: 'Hi', buttons: PROXY }), true);
  assert.equal(h.lastSent(calls).chat_id, 5151);
  assert.equal(h.lastSent(calls).reply_markup.inline_keyboard[0][0].callback_data, 'cmd:proxy');
});

test('a caregiver tapping the logged proxy button reaches handleInbound as the caregiver, label resolved', async () => {
  const { bot } = h.makeBot();
  await bot.handleUpdate(h.textUpdate(5151, '/start CG_GARCIA1'));
  await channels.sendToCaregiver(store.getPatient('p1'), { text: 'Maria has not answered', buttons: PROXY });
  await bot.handleUpdate(h.tapUpdate(5151, 'cmd:proxy', { text: 'q', reply_markup: { inline_keyboard: [[{ text: 'Answer for Maria', callback_data: 'cmd:proxy' }]] } }));
  const inbound = store.listMessages('p1').filter((m) => m.direction === 'in').at(-1);
  assert.equal(inbound.from, 'caregiver');
  assert.equal(inbound.text, 'Answer for Maria');
});

test('sendToNurses logs to the patient only when a patientId is given, and never throws', async () => {
  const before = store.listMessages('p1').length;
  assert.equal(await channels.sendToNurses({ text: 'general' }), false);
  assert.equal(store.listMessages('p1').length, before);
  await channels.sendToNurses({ text: 'about Maria', patientId: 'p1' });
  assert.equal(store.listMessages('p1').at(-1).to, 'nurse');
});

test('a delivery failure returns false instead of throwing', async () => {
  const { bot } = h.makeBot({
    results: {
      sendMessage: () => {
        throw new Error('chat not found');
      },
    },
  });
  telegram.useBot(bot);
  store.updatePatient('p1', { chatId: 4242 });
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal(await channels.sendToPatient(store.getPatient('p1'), { text: 'x' }), false);
  } finally {
    console.error = err;
  }
  assert.equal(store.listMessages('p1').at(-1).text, 'x', 'still in the dashboard log');
});
