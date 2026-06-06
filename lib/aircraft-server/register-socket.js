// lib/aircraft-server/register-socket.js — aircraft-board / aircraft-exit のソケット登録

import { getAircraftServerDeps } from './deps-registry.js';
import { ensureRoomAircraftState, worldContainsAircraftSlot } from './room-aircraft.js';

/** @type {boolean} */
let aircraftSocketHandlersRegistered = false;

/**
 * io に connection ごとの aircraft ハンドラを登録する（重複登録防止）。
 * @param {import('socket.io').Server} io
 */
export function registerAircraftSocketHandlers(io) {
    if (aircraftSocketHandlersRegistered) return;
    aircraftSocketHandlersRegistered = true;
    io.on('connection', (socket) => {
        socket.on('aircraft-board', (data, callback) => {
            const deps = getAircraftServerDeps();
            if (!deps) {
                if (typeof callback === 'function') callback({ ok: false, error: 'deps_unconfigured' });
                return;
            }
            const slotId = data && String(data.slotId || '').trim();
            const world = socket.data.currentRoom;
            if (!slotId || !world) {
                if (typeof callback === 'function') callback({ ok: false, error: 'bad_request' });
                return;
            }
            if (!worldContainsAircraftSlot(world, slotId)) {
                if (typeof callback === 'function') callback({ ok: false, error: 'invalid_slot' });
                return;
            }
            const rs = deps.getRoomState(world);
            ensureRoomAircraftState(rs);
            if (rs.aircraft.pilots.has(slotId)) {
                if (typeof callback === 'function') callback({ ok: false, error: 'busy' });
                return;
            }
            const pl = rs.players.get(socket.id);
            if (!pl) {
                if (typeof callback === 'function') callback({ ok: false, error: 'no_player' });
                return;
            }
            if (pl.pilotingAircraftId) {
                if (typeof callback === 'function') callback({ ok: false, error: 'already_piloting' });
                return;
            }
            rs.aircraft.pilots.set(slotId, socket.id);
            pl.pilotingAircraftId = slotId;
            pl.passengeringAircraftId = null;
            if (typeof callback === 'function') callback({ ok: true });
        });

        socket.on('aircraft-exit', (data, callback) => {
            const deps = getAircraftServerDeps();
            if (!deps) {
                if (typeof callback === 'function') callback({ ok: false, error: 'deps_unconfigured' });
                return;
            }
            const world = socket.data.currentRoom;
            if (!world) {
                if (typeof callback === 'function') callback({ ok: false, error: 'no_room' });
                return;
            }
            const rs = deps.getRoomState(world);
            const pl = rs.players.get(socket.id);
            const slotId = (data && String(data.slotId || '').trim()) || (pl && pl.pilotingAircraftId);
            if (!slotId || rs.aircraft.pilots.get(slotId) !== socket.id) {
                if (typeof callback === 'function') callback({ ok: false, error: 'not_pilot' });
                return;
            }
            rs.aircraft.pilots.delete(slotId);
            rs.aircraft.poses.delete(slotId);
            if (pl) {
                pl.pilotingAircraftId = null;
                pl.passengeringAircraftId = null;
            }
            io.to(world).emit('aircraft-released', { slotId, pilotId: socket.id });
            if (typeof callback === 'function') callback({ ok: true });
        });
    });
}
