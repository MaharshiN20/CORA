#!/usr/bin/env node
// Virtual Bluetooth/cellular scale: posts weight readings to the backend like a real device.
//
//   node tools/virtual-scale.js --patient p1 --lb 177.4
//   node tools/virtual-scale.js --patient p1 --trend +0.8/day --days 5          (starts from the last weight)
//   node tools/virtual-scale.js --patient p1 --lb 176 --trend +0.8/day --days 5
//   options: --api http://localhost:3001  --device virtual-scale
import { pathToFileURL } from 'node:url';
import * as devices from '../src/integrations/devices.js';

export const USAGE = `Usage: node tools/virtual-scale.js --patient <id> (--lb <weight> | --trend <+x/day> --days <n>) [--api <url>] [--device <name>]`;

// The patient's latest known weight (device reading or check-in), for trends with no --lb.
async function lastWeight(api, patientId, opts) {
  const p = await devices.getJSON(`${api}/api/patients/${encodeURIComponent(patientId)}`, opts);
  const fromDevice = (p.readings ?? []).filter((r) => r.type === 'weight').at(-1);
  const fromCheckin = (p.weights ?? []).at(-1);
  const latest = [fromDevice && { ts: fromDevice.ts, lb: fromDevice.value }, fromCheckin].filter(Boolean).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).at(-1);
  if (!latest) throw new Error(`${patientId} has no weight yet: pass --lb to start from`);
  return latest.lb;
}

export async function main(argv, { log = console.log, fetchImpl } = {}) {
  const args = devices.parseArgs(argv);
  if (args.help) return log(USAGE);
  const api = String(args.api ?? process.env.HEARTBRIDGE_API ?? devices.DEFAULT_API).replace(/\/$/, '');
  const patientId = args.patient;
  const device = args.device ?? 'virtual-scale';
  const opts = fetchImpl ? { fetchImpl } : {};
  if (!patientId || patientId === true) throw new Error(`--patient is required\n${USAGE}`);

  let values;
  if (args.trend !== undefined) {
    const perDay = devices.parseTrend(args.trend);
    const days = args.days === undefined ? 5 : devices.parseNumber(args.days, 'days');
    // With no --lb the series continues from the last weight: day 1 is already one step up.
    const first = args.lb !== undefined ? devices.parseNumber(args.lb, 'lb') : (await lastWeight(api, patientId, opts)) + perDay;
    values = devices.planSeries({ first, perDay, days });
  } else if (args.lb !== undefined) {
    values = [devices.parseNumber(args.lb, 'lb')];
  } else {
    throw new Error(`pass --lb or --trend\n${USAGE}`);
  }
  values.forEach((value) => devices.validateReading({ patientId, type: 'weight', value }));

  return devices.runSeries(api, { patientId, device, values, readingsFor: (value) => [{ type: 'weight', value }], log }, opts);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await devices.runCli(main, process.argv.slice(2));
}
