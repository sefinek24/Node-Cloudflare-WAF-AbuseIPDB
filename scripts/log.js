module.exports = (level, message) => {
	const logLevels = {
		info: '[INFO]',
		warn: '[WARN]',
		error: '[FAIL]'
	};

	const timestamp = process.env.NODE_ENV === 'development' ? `${new Date().toISOString()}: ` : '';
	console[level](`${logLevels[level]} ${timestamp}${message}`);
};