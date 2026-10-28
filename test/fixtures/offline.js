'use strict';
// Preloaded into the server by the boot test: no internet (package lists, Discord) during tests.
global.fetch = async () => {
  throw new Error('offline (test)');
};
