const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const url =
  process.env.TEST_DATABASE_URL || process.env.HISTORY_TEST_DATABASE_URL;
if (!url || !/^postgres(?:ql)?:\/\//.test(url)) {
  console.error(
    'Full tests require TEST_DATABASE_URL pointing to a disposable PostgreSQL database. Use npm run test:unit for database-free checks.'
  );
  process.exit(1);
}

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? testFiles(path)
        : entry.name.endsWith('.test.ts')
        ? [path]
        : [];
    })
    .sort();
}

const result = spawnSync(
  process.execPath,
  ['--test', '--import', 'tsx', ...testFiles('test')],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      TEST_DATABASE_URL: url,
      HISTORY_TEST_DATABASE_URL: url,
    },
  }
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
