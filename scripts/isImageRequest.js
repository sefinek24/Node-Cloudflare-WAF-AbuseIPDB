const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp'];
module.exports = loc => imageExtensions.some(ext => loc.toLowerCase().endsWith(ext));
