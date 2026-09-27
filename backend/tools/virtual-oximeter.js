#!/usr/bin/env node
// Virtual pulse oximeter: posts SpO2 (and optionally heart rate) readings like a real device.
//
//   node tools/virtual-oximeter.js --patient p1 --spo2 94 --hr 82
//   node tools/virtual-oximeter.js --patient p1 --spo2 96 --trend -1/day --days 4 --hr 80
//   options: --api http://localhost:3001  --device virtual-oximeter
import { pathToFileURL } from 'node:url';
import * as devices from '../src/integrations/devices.js';

export const USAGE = `Usage: node tools/virtual-oximeter.js --patient <id> --spo2 <percent> [--hr <bpm>] [--trend <-x/day> --days <n>] [--api <url>] [--device <name>]`;

export async function main(argv, { log = console.log, fetchImpl } = {}) {
  const args = devices.parseArgs(argv);
  if (args.help) return log(USAGE);
  const api = String(args.api ?? process.env.HEARTBRIDGE_API ?? devices.DEFAULT_API).replace(/\/$/, '');
  const patientId = args.patient;
  const device = args.device ?? 'virtual-oximeter';
  const opts = fetchImpl ? { fetchImpl } : {};
  if (!patientId || patientId === true) throw new Error(`--patient is required\n${USAGE}`);
  if (args.spo2 === undefined) throw new Error(`--spo2 is required\n${USAGE}`);

  const first = devices.parseNumber(args.spo2, 'spo2');
  const perDay = args.trend !== undefined ? devices.parseTrend(args.trend) : 0;
  const days = args.trend !== undefined ? (args.days === undefined ? 3 : devices.parseNumber(args.days, 'days')) : 1;
  // Oximeters report whole percents; never above 100.
  const values = devices.planSeries({ first, perDay, days }).map((v) => Math.min(100, Math.round(v)));
  const hr = args.hr !== undefined ? devices.parseNumber(args.hr, 'hr') : null;
  values.forEach((value) => devices.validateReading({ patientId, type: 'spo2', value }));
  if (hr !== null) devices.validateReading({ patientId, type: 'hr', value: hr });

  const readingsFor = (value) => [{ type: 'spo2', value }, ...(hr !== null ? [{ type: 'hr', value: hr }] : [])];
  return devices.runSeries(api, { patientId, device, values, readingsFor, log }, opts);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await devices.runCli(main, process.argv.slice(2));
}
