const fs = require('node:fs');
const path = require('node:path');

const CSV_FILE_PATH = path.join(__dirname, '..', 'reported_ips.csv');

if (!fs.existsSync(CSV_FILE_PATH)) fs.writeFileSync(CSV_FILE_PATH, 'Timestamp,RayID,IP,Endpoint,Action,Country\n');

const logToCSV = (timestamp, rayid, ip, endpoint, action, country) => {
	const logLine = `${timestamp.toISOString()},${rayid},${ip},${endpoint},${action},${country}\n`;
	fs.appendFileSync(CSV_FILE_PATH, logLine);
};

const readReportedIPs = () => {
	if (!fs.existsSync(CSV_FILE_PATH)) return [];

	const content = fs.readFileSync(CSV_FILE_PATH, 'utf8');
	return content.split('\n').slice(1).map(line => {
		const [timestamp, rayid, ip, domain, action, country] = line.split(',');
		return { timestamp: new Date(timestamp), rayid, ip, domain, action, country };
	}).filter(entry => entry.timestamp && entry.rayid && entry.ip);
};

module.exports = { logToCSV, readReportedIPs };