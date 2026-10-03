const { start } = require("./script");

start().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
