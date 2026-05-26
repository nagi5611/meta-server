import { readFileSync } from 'node:fs';
import { fetchMatsuyamaAirportBoard, parseAirportTimetable } from '../lib/airport-timetable-client.js';
import { validateAirportTimetableLayout } from '../lib/layout-signature.js';

const html = readFileSync(new URL('./timetable-reference.html', import.meta.url), 'utf8');
const layout = validateAirportTimetableLayout(html);
console.log('layout', layout);
const parsed = parseAirportTimetable(html);
console.log('departures', parsed.departures.length, 'arrivals', parsed.arrivals.length);
console.log('sample dep', parsed.departures[0]);
console.log('sample arr', parsed.arrivals[0]);

try {
    const board = await fetchMatsuyamaAirportBoard();
    console.log('fetch board', board.layoutValid, board.departures.length, board.arrivals.length);
} catch (e) {
    console.error('fetch error', e.message, e.cause?.message || '');
}
