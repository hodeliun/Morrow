const { runGroup } = require('./verify-prior-deliveries-ui.cjs');

runGroup('delivery1').catch((error) => {
  console.error(`VERIFICATION FAILED: ${error.stack ?? error}`);
  process.exitCode = 1;
});
