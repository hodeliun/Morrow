const { runGroup } = require('./verify-prior-deliveries-ui.cjs');

runGroup('delivery2').catch((error) => {
  console.error(`VERIFICATION FAILED: ${error.stack ?? error}`);
  process.exitCode = 1;
});
