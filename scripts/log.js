const levels = {
	info: '[INFO]',
	warn: '[WARN]',
	error: '[FAIL]'
};

module.exports = (level, msg) => console[level](`${levels[level]} ${msg}`);