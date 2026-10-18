import { loadConfig } from '../src/config.js';
// Offline only: no SDK startup, state creation, auth call or connection.
try {
  loadConfig();
  console.log(JSON.stringify({ event: 'config_valid', note: 'Syntax only; identities, permissions and connectivity are not verified.' }));
} catch (error) {
  console.error(JSON.stringify({ event: 'config_invalid', reason: error.message }));
  process.exitCode = 78;
}
