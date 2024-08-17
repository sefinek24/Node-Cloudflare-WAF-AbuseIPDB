const levels = {
	info: '[INFO]',
	warn: '[WARN]',
	error: '[FAIL]'
};

module.exports = (level, message) => {
	const timestamp = process.env.NODE_ENV === 'development' ? `${new Date().toISOString()}: ` : '';
	console[level](`${levels[level]} ${timestamp}${message}`);
};