'use strict';

/*
 * Sleep-sound list for the ecozy E80S, taken from the device's own thing-model
 * documentation for dp113 (playtrack_set).
 *
 * dp113 is a 7-byte raw datapoint:
 *   b0  1 = playing, 0 = stopped
 *   b1  sound index, 0-22 (0 = none)
 *   b2  volume, 1-16
 *   b3  play mode (0 single-repeat, 1 shuffle, 2 list) - E80S Pro uses 0
 *   b4  countdown minutes, high byte (0-480)
 *   b5  countdown minutes, low byte
 *   b6  track navigation (0 previous, 1 next, 2 play current)
 */

const SLEEP_SOUNDS = [
  { id: 1, name: 'River' },
  { id: 2, name: 'Flowing Water' },
  { id: 3, name: 'Morning Forest Birds' },
  { id: 4, name: 'Birdsong' },
  { id: 5, name: 'Night Insects' },
  { id: 6, name: 'Crickets' },
  { id: 7, name: 'Summer and Autumn' },
  { id: 8, name: 'Campfire Forest' },
  { id: 9, name: 'Rain and Thunder' },
  { id: 10, name: 'Rain' },
  { id: 11, name: 'Waves' },
  { id: 12, name: 'Ocean Waves' },
  { id: 13, name: 'Wind' },
  { id: 14, name: 'Wind Noise' },
  { id: 15, name: 'Wind Chimes' },
  { id: 16, name: 'Train' },
  { id: 17, name: 'Church Bells' },
  { id: 18, name: 'Heartbeat' },
  { id: 19, name: 'Pink Noise' },
  { id: 20, name: 'White Noise' },
  { id: 21, name: 'Twinkle Twinkle' },
  { id: 22, name: 'Lullaby' },
];

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64) {
  try {
    return Array.from(Buffer.from(String(b64), 'base64'));
  } catch (e) {
    return [];
  }
}

/** Read the current sleep-sound state from a dp113 value. */
function decodeTrack(raw) {
  const b = base64ToBytes(raw);
  if (b.length < 3) return null;
  return {
    playing: Boolean(b[0]),
    sound: b[1],
    volume: b[2],
    mode: b[3] || 0,
    countdown: ((b[4] || 0) << 8) | (b[5] || 0),
    bytes: b,
  };
}

/**
 * Build a new dp113 value, preserving any bytes we are not changing.
 * `current` is the device's existing raw value.
 */
function encodeTrack(changes, current) {
  const b = base64ToBytes(current);
  const bytes = b.length >= 7 ? b.slice() : [0, 0, 1, 0, 0, 0, 0];
  if (changes.playing != null) bytes[0] = changes.playing ? 1 : 0;
  if (changes.sound != null) bytes[1] = Math.max(0, Math.min(22, Number(changes.sound)));
  if (changes.volume != null) bytes[2] = Math.max(1, Math.min(16, Number(changes.volume)));
  if (changes.countdown != null) {
    const c = Math.max(0, Math.min(480, Number(changes.countdown)));
    bytes[4] = (c >> 8) & 0xff;
    bytes[5] = c & 0xff;
  }
  return bytesToBase64(bytes);
}

module.exports = { SLEEP_SOUNDS, decodeTrack, encodeTrack, base64ToBytes, bytesToBase64 };
