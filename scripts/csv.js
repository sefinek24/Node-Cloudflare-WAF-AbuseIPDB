const fs = require('node:fs');
const path = require('node:path');
const log = require('./log.js');

const CSV_FILE_PATH = path.join(__dirname, '..', 'reported_ips.csv');
const MAX_CSV_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB
const CSV_HEADER = 'Timestamp,RayID,IP,Hostname,Endpoint,User-Agent,Action,Country,SefinekAPI\n';

if (!fs.existsSync(CSV_FILE_PATH)) fs.writeFileSync(CSV_FILE_PATH, CSV_HEADER);

const checkCSVSize = () => {
	const stats = fs.statSync(CSV_FILE_PATH);
	if (stats.size > MAX_CSV_SIZE_BYTES) {
		fs.writeFileSync(CSV_FILE_PATH, CSV_HEADER);
		log('info', `CSV file size exceeded ${MAX_CSV_SIZE_BYTES / (1024 * 1024)} MB. File has been reset.`);
	}
};

const escapeCSVValue = value => {
	if (typeof value === 'string' && value.includes(',')) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
};

const logToCSV = (rayId, ip, hostname, endpoint, useragent, action, country, sefinekAPI) => {
	checkCSVSize();
	const logLine = `${new Date().toISOString()},${rayId},${ip},${hostname},${escapeCSVValue(endpoint)},${escapeCSVValue(useragent || '')},${action},${country},${sefinekAPI || false}`;
	fs.appendFileSync(CSV_FILE_PATH, logLine + '\n');
};

const readReportedIPs = () => {
	if (!fs.existsSync(CSV_FILE_PATH)) return [];

	const content = fs.readFileSync(CSV_FILE_PATH, 'utf8');
	return content
		.split('\n')
		.slice(1)
		.filter(line => line.trim() !== '')
		.map(line => {
			const [timestamp, rayId, ip, hostname, endpoint, useragent, action, country, sefinekAPI] = line.split(',');
			return { timestamp: new Date(timestamp), rayId, ip, hostname, endpoint, useragent, action, country, sefinekAPI };
		});
};

const updateSefinekAPIInCSV = (rayId, reportedToSefinekAPI) => {
	if (!fs.existsSync(CSV_FILE_PATH)) {
		log('error', 'CSV file does not exist');
		return;
	}

	const content = fs.readFileSync(CSV_FILE_PATH, 'utf8');
	const lines = content.split('\n');

	const updatedLines = lines.map(line => {
		if (line.includes(rayId)) {
			const [timestamp, rayIdExisting, ip, hostname, endpoint, useragent, action, country] = line.split(',');
			if (rayIdExisting === rayId) {
				return `${timestamp},${rayId},${ip},${hostname},${escapeCSVValue(endpoint)},${escapeCSVValue(useragent)},${action},${country},${reportedToSefinekAPI}`;
			}
		}
		return line;
	});

	fs.writeFileSync(CSV_FILE_PATH, updatedLines.join('\n'));
};

const wasImageRequestLogged = (ip, reportedIPs) => reportedIPs.some(entry => entry.ip === ip && entry.action === 'Skipped - Image Request');

module.exports = { logToCSV, readReportedIPs, updateSefinekAPIInCSV, wasImageRequestLogged };