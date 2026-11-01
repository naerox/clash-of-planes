// Experiment 5: fc.float vs fc.double for a value that travels as a 32-bit float.
//   node experiments/lab07/5-float-vs-double.js
import fc from "fast-check";
const roundTrip = (x) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, x, true);
  return view.getFloat32(0, true);
};
const run = (name, arb) => {
  let bad = 0, total = 0;
  fc.assert(fc.property(arb, (x) => { total++; if (roundTrip(x) !== x) bad++; return true; }), { numRuns: 5000 });
  console.log(`${name.padEnd(10)} ${bad}/${total} values changed on the way through a float32`);
};
run("fc.double", fc.double({ noNaN: true, min: -1e6, max: 1e6 }));
run("fc.float", fc.float({ noNaN: true, min: -1e6, max: 1e6 }));
