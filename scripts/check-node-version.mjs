import process from 'node:process';

const minimum = [22, 19, 0];
const actual = process.versions.node.split('.').map(Number);
let atLeast = actual.length === 3;
if (atLeast) {
  atLeast = true;
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] > minimum[index]) break;
    if (actual[index] < minimum[index]) { atLeast = false; break; }
  }
}
if (!atLeast) {
  console.error(`Node ${minimum.join('.')} or newer is required; found ${process.versions.node}`);
  process.exitCode = 1;
} else {
  console.log(`Node ${process.versions.node} satisfies >=${minimum.join('.')}`);
}
