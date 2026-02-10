function ts() {
  return new Date().toISOString();
}

function log(scope, message) {
  console.log(`[${ts()}] [${scope}] ${message}`);
}

module.exports = {
  log
};
