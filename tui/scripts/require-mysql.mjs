const required = ['HOST', 'DATABASE', 'USERNAME', 'PASSWORD'];
const missing = required.filter(key => !process.env[`GROUNDS_TEST_MYSQL_${key}`]);
if (missing.length) {
  console.error(`Release acceptance requires dedicated MySQL test configuration: ${missing.join(', ')}. Skipped tests do not count as acceptance.`);
  process.exitCode = 1;
}
