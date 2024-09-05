const { axios } = require('../services/axios.js');
const log = require('./log.js');

let address = null; // Holds the IP address
const refreshInterval = 360000; // 6 minutes

const fetchIPAddress = async () => {
	try {
		const { data } = await axios.get('https://api.sefinek.net/api/v2/ip');
		if (data?.success) {
			address = data.message;
		} else {
			log('error', 'Failed to retrieve your IP');
		}
	} catch (err) {
		log('error', `Error fetching your IP: ${err.message}`);
	}
};

setInterval(fetchIPAddress, refreshInterval);

module.exports = { fetchIPAddress, address };