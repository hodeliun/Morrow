// Test-only Electron entrypoint: the export dialog writes into a synthetic temp folder.
if (process.env.MORROW_HIDDEN !== '1' || !process.env.MORROW_TEST_PDF)
  throw new Error('This entrypoint requires a hidden test profile and PDF output path.');
const { dialog } = require('electron');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: process.env.MORROW_TEST_PDF });
require('../dist-electron/main.cjs');
