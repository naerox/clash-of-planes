// Experiment 1: watch V8 optimise a function and throw the optimised code away.
//   node --allow-natives-syntax --trace-deopt experiments/lab07/1-deopt.js
function add(a, b) {
  return a + b;
}
const status = (label) => {
  const s = %GetOptimizationStatus(add);
  // V8 12.4 bits: 1 function, 16 optimised, 32 Maglev, 64 TurboFan, 128 interpreted (they move between versions)
  console.log(
    label.padEnd(34),
    "status =",
    String(s).padEnd(7),
    "| optimised:",
    Boolean(s & 16),
    "| TurboFan:",
    Boolean(s & 64),
    "| Maglev:",
    Boolean(s & 32),
  );
};

status("fresh function");
for (let i = 0; i < 200_000; i++) add(i, 1); // always small integers
%OptimizeFunctionOnNextCall(add);
add(1, 2);
status("after 200k int calls + optimise");

add("a", "b"); // strings: the optimised code assumed numbers
status("after the first string call");

for (let i = 0; i < 200_000; i++) add(i, 1);
%OptimizeFunctionOnNextCall(add);
add(1, 2);
status("re-optimised (now it knows both)");
