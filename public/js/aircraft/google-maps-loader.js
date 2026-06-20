// public/js/aircraft/google-maps-loader.js — Google Maps JavaScript API の遅延読込（管理画面用）

/** @type {Promise<typeof google.maps>|null} */
let loadPromise = null;

/**
 * @param {string} apiKey
 * @returns {Promise<typeof google.maps>}
 */
export function loadGoogleMapsApi(apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) {
        return Promise.reject(new Error('google_maps_api_key_missing'));
    }
    if (window.google?.maps) {
        return Promise.resolve(window.google.maps);
    }
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`;
        script.async = true;
        script.defer = true;
        script.onload = () => {
            if (window.google?.maps) resolve(window.google.maps);
            else reject(new Error('google_maps_load_failed'));
        };
        script.onerror = () => reject(new Error('google_maps_load_failed'));
        document.head.appendChild(script);
    });
    return loadPromise;
}
