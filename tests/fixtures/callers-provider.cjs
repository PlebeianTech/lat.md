// Fixture 'callers' provider. Saves its stdin to the file named by
// LAT_FIXTURE_STDIN, then prints the output named by LAT_FIXTURE_STDOUT.
const { writeFileSync } = require('node:fs');
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  writeFileSync(process.argv[2], input);
  process.stdout.write(process.argv[3]);
  process.exitCode = Number(process.argv[4] ?? 0);
});
