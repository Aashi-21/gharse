// Runs the Prisma CLI after loading the repo-root .env (if present), so there is a single .env file.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const envFile = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const bin = require.resolve('prisma/build/index.js');
const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
});
process.exit(r.status ?? 1);
