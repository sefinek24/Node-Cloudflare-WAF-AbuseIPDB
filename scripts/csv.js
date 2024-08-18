const fs = require('node:fs');
const path = require('node:path');
const log = require('./log.js');

const CSV_FILE_PATH = path.join(__dirname, '..', 'reported_ips.csv');
const MAX_CSV_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB
const CSV_HEADER = 'Timestamp,RayID,IP,Endpoint,Action,Country\n';

if (!fs.existsSync(CSV_FILE_PATH)) fs.writeFileSync(CSV_FILE_PATH, CSV_HEADER);

const checkCSVSize = () => {
	const stats = fs.statSync(CSV_FILE_PATH);
	if (stats.size > MAX_CSV_SIZE_BYTES) {
		fs.writeFileSync(CSV_FILE_PATH, CSV_HEADER);
		log('info', `CSV file size exceeded ${MAX_CSV_SIZE_BYTES / (1024 * 1024)} MB. File has been reset.`);
	}
};

const logToCSV = (rayId, ip, endpoint, action, country) => {
	checkCSVSize();
	const logLine = `${new Date().toISOString()},${rayId},${ip},${endpoint},${action},${country}\n`;
	fs.appendFileSync(CSV_FILE_PATH, logLine);
};

const readReportedIPs = () => {
	if (!fs.existsSync(CSV_FILE_PATH)) return [];

	const content = fs.readFileSync(CSV_FILE_PATH, 'utf8');
	return content
		.split('\n')
		.slice(1)
		.filter(line => line.trim() !== '')
		.map(line => {
			const [timestamp, rayid, ip, endpoint, action, country] = line.split(',');
			return { timestamp: new Date(timestamp), rayid, ip, endpoint, action, country };
		});
};

const wasImageRequestLogged = (ip, reportedIPs) => reportedIPs.some(entry => entry.ip === ip && entry.action === 'Skipped - Image Request');

module.exports = { logToCSV, readReportedIPs, wasImageRequestLogged };