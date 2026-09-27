// `npm run seed`: wipe data/db.json back to the demo seed.
// Lives outside seed.js because store.js imports seed.js: a top-level `await
// import('./store.js')` inside seed.js deadlocked (Node exit code 13, "unsettled
// top-level await") and the reset never happened.
const { reset } = await import('../src/store.js');
reset();
console.log('Seed data restored to data/db.json (demo clock back to real time).');
