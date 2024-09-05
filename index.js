require('dotenv').config();

const { axios, moduleVersion } = require('./services/axios.js');
const PAYLOAD = require('./scripts/payload.js');
const generateComment = require('./scripts/generateComment.js');
const isImageRequest = require('./scripts/isImageRequest.js');
const headers = require('./scripts/headers.js');
const { logToCSV, readReportedIPs, wasImageRequestLogged } = require('./scripts/csv.js');
const formatDelay = require('./scripts/formatDelay.js');
const clientIp = require('./scripts/clientIp.js');
const log = require('./scripts/log.js');

const MAIN_DELAY = process.env.NODE_ENV === 'production'
	? 3 * 60 * 60 * 1000
	: 8 * 1000;

const REPORTED_IP_COOLDOWN_MS = 7 * 60 * 60 * 1000;
const COOLDOWN_MS = 2000;
const MAX_URL_LENGTH = 2000;

const fetchBlockedIPs = async () => {
	try {
		const { data, status } = await axios.post('https://api.cloudflare.com/client/v4/graphql', PAYLOAD(), { headers: headers.CLOUDFLARE });
		const events = data?.data?.viewer?.zones[0]?.firewallEventsAdaptive;
		if (events) {
			log('info', `Fetched ${events.length} events from Cloudflare`);
			return events;
		} else {
			log('error', `Failed to retrieve data from Cloudflare. Status: ${status}`, data?.errors);
			return null;
		}
	} catch (err) {
		log('error', err.response?.data ? `${err.response.status} HTTP ERROR (Cloudflare API)\n${JSON.stringify(err.response.data, null, 2)}` : `Unknown error with Cloudflare API: ${err.message}`);
		return null;
	}
};

const isIPReportedRecently = (ip, reportedIPs) => {
	const lastReport = reportedIPs.find(entry => entry.ip === ip && (entry.action === 'Reported' || entry.action.startsWith('Failed')));
	if (lastReport) {
		const lastTimestamp = new Date(lastReport.timestamp).getTime();
		const currentTime = Date.now();
		const timeDifference = currentTime - lastTimestamp;
		if (timeDifference < REPORTED_IP_COOLDOWN_MS) return { recentlyReported: true, timeDifference };
	}

	return { recentlyReported: false };
};

const reportIP = async (event, url, country, cycleErrorCounts) => {
	if (!url) {
		logToCSV(event.rayName, event.clientIP, url, 'Failed - Missing URL', country);
		log('warn', `Missing URL ${event.clientIP}; URI: ${url};`);
		return false;
	}

	if (event.clientIP === clientIp.address) {
		logToCSV(event.rayName, event.clientIP, url, 'Your IP address', country);
		log('warn', `Your IP address (${event.clientIP}) was unexpectedly received from Cloudflare. URI: ${url}; Ignoring...`);
		return false;
	}

	if (url.length > MAX_URL_LENGTH) {
		logToCSV(event.rayName, event.clientIP, url, 'Failed - URL too long', country);
		log('log', `URL too long ${event.clientIP}; URI: ${url};`);
		return false;
	}

	try {
		await axios.post('https://api.abuseipdb.com/api/v2/report', {
			ip: event.clientIP,
			categories: '19',
			comment: generateComment(event)
		}, { headers: headers.ABUSEIPDB });

		logToCSV(event.rayName, event.clientIP, url, 'Reported', country);
		log('info', `Reported ${event.clientIP}; URI: ${url}`);

		return true;
	} catch (err) {
		if (err.response?.status === 429) {
			logToCSV(event.rayName, event.clientIP, url, 'Failed - 429 Too Many Requests', country);
			log('info', `Rate limited (429) while reporting ${event.clientIP}; URI: ${url};`);
			cycleErrorCounts.blocked++;
		} else {
			log('error', `Error ${err.response?.status} while reporting ${event.clientIP}; URI: ${url}; (${err.response?.data})`);
			cycleErrorCounts.otherErrors++;
		}

		return false;
	}
};

(async () => {
	if (process.env.NODE_ENV === 'production') {
		try {
			process.send('ready');
		} catch (err) {
			log('info', `Failed to send ready signal to parent process. ${err.message}`);
		}
	}

	log('info', 'Starting, please wait...');
	await clientIp.fetchIPAddress();
	let cycleId = 1;

	while (true) {
		log('info', `===================== New Reporting Cycle (v${moduleVersion}) =====================`);

		const blockedIPEvents = await fetchBlockedIPs();
		if (!blockedIPEvents) {
			log('warn', 'No events fetched, skipping cycle...');
			continue;
		}

		const reportedIPs = readReportedIPs();
		let cycleImageSkippedCount = 0, cycleProcessedCount = 0, cycleReportedCount = 0, cycleSkippedCount = 0;
		const cycleErrorCounts = { blocked: 0, noResponse: 0, otherErrors: 0 };
		let imageRequestLogged = false;

		for (const event of blockedIPEvents) {
			cycleProcessedCount++;
			const ip = event.clientIP;
			const url = `${event.clientRequestHTTPHost}${event.clientRequestPath}`;
			const country = event.clientCountryName;

			const { recentlyReported, timeDifference } = isIPReportedRecently(ip, reportedIPs);
			if (recentlyReported) {
				const hoursAgo = Math.floor(timeDifference / (1000 * 60 * 60));
				const minutesAgo = Math.floor((timeDifference % (1000 * 60 * 60)) / (1000 * 60));
				const secondsAgo = Math.floor((timeDifference % (1000 * 60)) / 1000);
				log('info', `${ip} was reported or rate-limited ${hoursAgo}h ${minutesAgo}m ${secondsAgo}s ago. Skipping...`);
				cycleSkippedCount++;
				continue;
			}

			if (isImageRequest(event.clientRequestPath)) {
				cycleImageSkippedCount++;
				if (!wasImageRequestLogged(ip, reportedIPs)) {
					logToCSV(event.rayName, ip, url, 'Skipped - Image Request', country);

					if (imageRequestLogged) continue;
					log('info', 'Skipping image requests in this cycle...');
					imageRequestLogged = true;
				}

				continue;
			}

			const wasReported = await reportIP(event, url, country, cycleErrorCounts);
			if (wasReported) {
				cycleReportedCount++;
				await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS));
			}
		}

		log('info', `Cycle Summary [${cycleId}]:`);
		log('info', `- Reported IPs: ${cycleReportedCount}`);
		log('info', `- Total IPs processed: ${cycleProcessedCount}`);
		log('info', `- Skipped IPs: ${cycleSkippedCount}`);
		log('info', `- Skipped due to Image Requests: ${cycleImageSkippedCount}`);
		log('info', `- 429 Too Many Requests: ${cycleErrorCounts.blocked}`);
		log('info', `- No response errors: ${cycleErrorCounts.noResponse}`);
		log('info', `- Other errors: ${cycleErrorCounts.otherErrors}`);
		log('info', '==================== End of Reporting Cycle ====================');

		log('info', `Waiting ${formatDelay(MAIN_DELAY)}...`);
		cycleId++;
		await new Promise(resolve => setTimeout(resolve, MAIN_DELAY));
	}
})();