'use strict';
// Set or change the GUI login:   node set-password.js [username]
// Writes a scrypt hash to auth.json. Restart the GUI afterwards.
const readline = require('readline');
const { saveCredentials, loadCredentials, MIN_PASSWORD_LENGTH } = require('./auth');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      // Echo the prompt itself, but not what's typed.
      if (s.startsWith(question)) process.stdout.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  const existing = loadCredentials(__dirname);
  const username = process.argv[2] || (existing && existing.username) || 'admin';
  const pw1 = await askHidden(`New password for "${username}" (min ${MIN_PASSWORD_LENGTH} chars): `);
  if (pw1.length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }
  const pw2 = await askHidden('Repeat password: ');
  if (pw1 !== pw2) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
  saveCredentials(__dirname, username, pw1);
  console.log('Saved to auth.json. Restart the GUI for it to take effect (existing sessions end when it restarts).');
})();
