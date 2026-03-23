const pino = require('pino');

const logger = pino({
  level: 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

function child(programName) {
  return logger.child({ programa: programName });
}

module.exports = { logger, child };
