// Experiment 2: hidden classes. The same loop over objects that all have one shape,
// four shapes, or many shapes — and over a Float32Array.
//   node experiments/lab07/2-shapes.js
const N = 1_000_000;
const make = (variant) => {
  const a = new Array(N);
  for (let i = 0; i < N; i++) {
    switch (variant === 1 ? 0 : i % variant) {
      case 0: a[i] = { x: i, y: 1 }; break;
      case 1: a[i] = { y: 1, x: i }; break; // same keys, other order → another shape
      case 2: a[i] = { x: i, y: 1, z: 0 }; break;
      case 3: a[i] = { z: 0, x: i, y: 1 }; break;
      default: { const o = { x: i, y: 1 }; o["k" + (i % variant)] = 0; a[i] = o; }
    }
  }
  return a;
};
function sum(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i].x;
  return s;
}
const time = (fn) => {
  fn(); fn(); // warm up
  const t0 = performance.now();
  for (let r = 0; r < 20; r++) fn();
  return (performance.now() - t0) / 20;
};
console.log("shapes in the array | ms per pass over 1M objects");
for (const variant of [1, 2, 4, 5, 20]) {
  const arr = make(variant);
  const label = variant === 1 ? "1  (monomorphic)" : variant <= 4 ? `${variant}  (polymorphic)` : `${variant}  (megamorphic)`;
  console.log(label.padEnd(20), "|", time(() => sum(arr)).toFixed(2));
}
const xs = new Float32Array(N);
for (let i = 0; i < N; i++) xs[i] = i;
console.log("Float32Array".padEnd(20), "|", time(() => { let s = 0; for (let i = 0; i < N; i++) s += xs[i]; return s; }).toFixed(2));
